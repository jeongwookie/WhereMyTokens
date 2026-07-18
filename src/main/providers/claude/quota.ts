import {
  ClaudeApiStatus,
  ClaudeUsagePayload,
  fetchClaudeUsage,
} from '../../rateLimitFetcher';
import { getOAuthCredentialMarker } from '../../oauthRefresh';
import { FIVE_HOURS_MS, SEVEN_DAYS_MS, normalizeQuotaPeriod } from '../../../shared/quotaDomain';
import type {
  ProviderCreditBalance,
  ProviderQuotaSnapshot,
  QuotaEntry,
  QuotaTarget,
} from '../../../shared/quotaTypes';
import type { ProviderContext } from '../types';

export interface ClaudeProviderQuotaSnapshot extends ProviderQuotaSnapshot {
  provider: 'claude';
  status: ClaudeApiStatus;
  credentialMarker: string | null;
}

const ACCOUNT_TARGET: QuotaTarget = {
  id: 'claude.group.account',
  label: 'Claude',
  defaultMode: 'rich',
  defaultOrder: 0,
  taskbarAbbreviation: 'C',
  cacheMetricTitle: 'Cache read / (cache read + cache creation)',
};

const FABLE_TARGET: QuotaTarget = {
  id: 'claude.group.fable',
  label: 'Fable',
  defaultMode: 'simple',
  defaultOrder: 10,
  taskbarAbbreviation: 'F',
  hideCost: true,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isInactive(record: Record<string, unknown>): boolean {
  return record.active === false
    || record.is_active === false
    || record.status === 'inactive';
}

function usedPct(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function absoluteReset(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function abbreviation(label: string): string {
  const match = label.toUpperCase().match(/[A-Z0-9]/);
  return match?.[0] ?? 'C';
}

function modelLabel(record: Record<string, unknown>): string | null {
  const scope = asRecord(record.scope);
  const model = asRecord(scope?.model);
  const displayName = typeof model?.display_name === 'string' ? model.display_name.trim() : '';
  return displayName || null;
}

function extraUsageCredits(usage: ClaudeUsagePayload | null): Record<string, ProviderCreditBalance> | undefined {
  const extraUsage = usage?.extraUsage;
  if (!extraUsage?.isEnabled) return undefined;
  return {
    extraUsage: {
      available: Math.max(0, extraUsage.monthlyLimit - extraUsage.usedCredits),
      used: extraUsage.usedCredits,
      total: extraUsage.monthlyLimit,
      remainingPct: Math.max(0, Math.min(100, 100 - extraUsage.utilization)),
      resetMs: null,
    },
  };
}

function limitedEntry(
  key: string,
  target: QuotaTarget,
  scope: QuotaEntry['scope'],
  percent: number,
  resetsAt: number | null,
  durationMs: number,
  usageBinding?: QuotaEntry['usageBinding'],
): QuotaEntry {
  return {
    key,
    target,
    scope,
    state: 'limited',
    usedPct: percent,
    resetsAt,
    durationMs,
    durationInferred: false,
    period: normalizeQuotaPeriod(durationMs),
    ...(usageBinding ? { usageBinding } : {}),
  };
}

export function parseClaudeQuotaEntries(usage: ClaudeUsagePayload): { entries: QuotaEntry[]; activeCandidates: number; invalid: number } {
  const entries: QuotaEntry[] = [];
  const scoped: Array<{ record: Record<string, unknown>; label: string; id: string }> = [];
  let activeCandidates = usage.accountWindowCandidates;
  let invalid = usage.invalidAccountWindows;

  const fiveHour = usage.accountWindows.fiveHour;
  if (fiveHour) {
    entries.push(limitedEntry(
      'claude.account.5h', ACCOUNT_TARGET, { kind: 'account' }, fiveHour.usedPct, fiveHour.resetsAt, FIVE_HOURS_MS,
      { kind: 'all-provider-models' },
    ));
  }
  const sevenDay = usage.accountWindows.sevenDay;
  if (sevenDay) {
    entries.push(limitedEntry(
      'claude.account.7d', ACCOUNT_TARGET, { kind: 'account' }, sevenDay.usedPct, sevenDay.resetsAt, SEVEN_DAYS_MS,
      { kind: 'all-provider-models' },
    ));
  }

  for (const raw of usage.limits) {
    const record = asRecord(raw);
    if (!record) {
      activeCandidates += 1;
      invalid += 1;
      continue;
    }
    const kind = typeof record.kind === 'string' ? record.kind : '';
    const group = typeof record.group === 'string' ? record.group : '';
    if ((kind === 'session' && group === 'session') || (kind === 'weekly_all' && group === 'weekly')) {
      continue;
    }
    if (isInactive(record)) continue;
    activeCandidates += 1;
    const percent = usedPct(record.percent);
    const resetsAt = absoluteReset(record.resets_at);
    if (percent == null || resetsAt === undefined) {
      invalid += 1;
      continue;
    }
    if (kind === 'weekly_scoped' && group === 'weekly') {
      const label = modelLabel(record);
      const id = label ? slug(label) : '';
      if (!label || !id) invalid += 1;
      else scoped.push({ record, label, id });
      continue;
    }
    invalid += 1;
  }

  const labelsById = new Map<string, Set<string>>();
  for (const candidate of scoped) {
    const labels = labelsById.get(candidate.id) ?? new Set<string>();
    labels.add(candidate.label.toLowerCase());
    labelsById.set(candidate.id, labels);
  }
  const seenScopedIds = new Set<string>();
  for (const candidate of scoped) {
    if ((labelsById.get(candidate.id)?.size ?? 0) !== 1 || seenScopedIds.has(candidate.id)) {
      invalid += 1;
      continue;
    }
    seenScopedIds.add(candidate.id);
    const percent = usedPct(candidate.record.percent)!;
    const resetsAt = absoluteReset(candidate.record.resets_at)!;
    const isFable = candidate.id === 'fable';
    const target = isFable ? FABLE_TARGET : {
      id: `claude.group.${candidate.id}`,
      label: candidate.label,
      defaultMode: 'simple' as const,
      defaultOrder: 20,
      taskbarAbbreviation: abbreviation(candidate.label),
      hideCost: true,
    };
    entries.push(limitedEntry(
      isFable ? 'claude.fable.7d' : `claude.model.${candidate.id}.7d`,
      target,
      { kind: 'model', label: candidate.label },
      percent,
      resetsAt,
      SEVEN_DAYS_MS,
    ));
  }
  return { entries, activeCandidates, invalid };
}

export async function fetchClaudeQuota(ctx: ProviderContext): Promise<ClaudeProviderQuotaSnapshot> {
  const result = await fetchClaudeUsage();
  const parsed = result.usage ? parseClaudeQuotaEntries(result.usage) : null;
  const allActiveInvalid = !!parsed && parsed.activeCandidates > 0 && parsed.entries.length === 0;
  const status: ClaudeApiStatus = allActiveInvalid
    ? {
        code: 'schema-changed',
        connected: false,
        label: 'schema changed',
        detail: 'Claude quota data contained candidates but none could form a canonical quota entry.',
        responseKeys: result.status.responseKeys,
      }
    : parsed && parsed.invalid > 0
      ? { ...result.status, detail: `${parsed.invalid} malformed or unclassified Claude quota candidate(s) were ignored.` }
      : result.status;
  return {
    provider: 'claude',
    source: status.connected ? 'api' : 'cache',
    capturedAt: ctx.nowMs,
    entries: status.connected ? (parsed?.entries ?? []) : [],
    accountLabel: result.usage?.plan || undefined,
    planName: result.usage?.plan || undefined,
    credits: extraUsageCredits(result.usage),
    status,
    credentialMarker: getOAuthCredentialMarker(),
  };
}

export function isClaudeQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is ClaudeProviderQuotaSnapshot {
  return snapshot.provider === 'claude' && !!snapshot.status && 'credentialMarker' in snapshot;
}
