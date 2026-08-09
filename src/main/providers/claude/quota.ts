import {
  FIVE_HOURS_MS,
  SEVEN_DAYS_MS,
  ageProviderQuotaSnapshot,
  normalizeQuotaPeriod,
} from '../../../shared/quotaDomain';
import type {
  ProviderCreditBalance,
  ProviderQuotaSnapshot,
  ProviderQuotaStatus,
  QuotaEntry,
  QuotaTarget,
} from '../../../shared/quotaTypes';
import {
  CLAUDE_STATUS_LINE_CACHE_MAX_MS,
  CLAUDE_STATUS_LINE_FRESH_MS,
  type ClaudeStatusLineSnapshot,
} from '../../../shared/claudeStatusLine';
import { readClaudeStatusLineFile } from '../../../bridge/claudeStatusLineFile';
import type { ProviderContext } from '../types';
import {
  CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS,
  fetchClaudeCompatibilityUsage,
  type ClaudeCompatibilityUsage,
} from './readOnlyUsage';

const ACCOUNT_TARGET: QuotaTarget = {
  id: 'claude.group.account',
  label: 'Claude',
  defaultMode: 'rich',
  defaultOrder: 0,
  taskbarAbbreviation: 'C',
  cacheMetricTitle: 'Cache read / (cache read + cache creation)',
};

const COMPATIBILITY_CREDENTIAL_MARKERS = new WeakMap<object, string>();

function accountTarget(source: 'statusLine' | 'api'): QuotaTarget {
  if (source === 'statusLine') return ACCOUNT_TARGET;
  return {
    ...ACCOUNT_TARGET,
    badges: [{
      key: 'compatibility-api',
      label: 'Compat',
      title: 'Read-only Claude Desktop compatibility data',
      tone: 'neutral',
    }],
  };
}

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scopedTarget(label: string, id: string, source: 'statusLine' | 'api'): QuotaTarget {
  const isFable = /\bfable\b/i.test(label);
  return {
    id: isFable ? 'claude.group.fable' : `claude.group.${id}`,
    label: isFable ? 'Fable' : label,
    defaultMode: 'simple',
    defaultOrder: isFable ? 10 : 20,
    taskbarAbbreviation: (label.toUpperCase().match(/[A-Z0-9]/)?.[0] ?? 'C'),
    hideCost: true,
    badges: [{
      key: source === 'statusLine' ? 'statusline' : 'compatibility-api',
      label: source === 'statusLine' ? 'Local' : 'Compat',
      title: source === 'statusLine'
        ? 'Reported locally by Claude Code statusLine'
        : 'Read-only Claude Desktop compatibility data',
      tone: 'neutral',
    }],
  };
}

function limitedEntry(
  period: '5h' | '7d',
  usedPct: number,
  resetsAt: number | null,
  durationMs: number,
  source: 'statusLine' | 'api',
): QuotaEntry {
  return {
    key: `claude.account.${period}`,
    target: accountTarget(source),
    scope: { kind: 'account' },
    state: 'limited',
    usedPct,
    resetsAt,
    durationMs,
    durationInferred: false,
    period: normalizeQuotaPeriod(durationMs),
    usageBinding: { kind: 'all-provider-models' },
  };
}

export function waitingClaudeQuota(nowMs: number): ProviderQuotaSnapshot {
  return {
    provider: 'claude',
    source: 'cache',
    capturedAt: nowMs,
    entries: [],
    status: {
      connected: false,
      code: 'bridge-unavailable',
      label: 'waiting for Claude',
      detail: 'Waiting for Claude Code statusLine or read-only Desktop compatibility data.',
      severity: 'warning',
    },
  };
}

function isCompatibilitySnapshot(snapshot: ProviderQuotaSnapshot): boolean {
  return snapshot.source === 'api'
    || snapshot.status?.code === 'compatibility-api'
    || snapshot.status?.code === 'compatibility-stale';
}

export function ageClaudeQuotaSnapshot(
  snapshot: ProviderQuotaSnapshot,
  nowMs: number,
): ProviderQuotaSnapshot {
  const aged = ageProviderQuotaSnapshot(snapshot, nowMs);
  if (nowMs >= snapshot.capturedAt + CLAUDE_STATUS_LINE_CACHE_MAX_MS) {
    return { ...aged, entries: [] };
  }
  const compatibility = isCompatibilitySnapshot(snapshot);
  const freshMs = compatibility ? CLAUDE_COMPATIBILITY_MIN_INTERVAL_MS : CLAUDE_STATUS_LINE_FRESH_MS;
  const fresh = nowMs >= snapshot.capturedAt
    && nowMs - snapshot.capturedAt < freshMs;
  if (fresh || aged.entries.length === 0) return aged;
  return {
    ...aged,
    source: 'cache',
    status: {
      connected: false,
      code: compatibility ? 'compatibility-stale' : 'bridge-stale',
      label: 'cached',
      detail: compatibility
        ? 'Showing the last read-only Claude compatibility result for up to 30 minutes.'
        : 'Showing the last Claude Code statusLine quota for up to 30 minutes.',
      severity: 'warning',
    },
  };
}

export function buildClaudeStatusLineQuota(
  data: ClaudeStatusLineSnapshot,
  nowMs: number,
): ProviderQuotaSnapshot {
  const entries: QuotaEntry[] = [];
  const fiveHour = data.rateLimits.fiveHour;
  const sevenDay = data.rateLimits.sevenDay;
  if (fiveHour) entries.push(limitedEntry('5h', fiveHour.usedPct, fiveHour.resetsAtMs, FIVE_HOURS_MS, 'statusLine'));
  if (sevenDay) entries.push(limitedEntry('7d', sevenDay.usedPct, sevenDay.resetsAtMs, SEVEN_DAYS_MS, 'statusLine'));
  const usedTargetIds = new Set<string>();
  for (const window of data.rateLimits.modelScoped) {
    const id = slug(window.label);
    if (!id) continue;
    const target = scopedTarget(window.label, id, 'statusLine');
    if (usedTargetIds.has(target.id)) continue;
    usedTargetIds.add(target.id);
    entries.push({
      key: target.id === 'claude.group.fable' ? 'claude.fable.7d' : `claude.model.${id}.7d`,
      target,
      scope: { kind: 'model', label: target.label },
      state: 'limited',
      usedPct: window.usedPct,
      resetsAt: window.resetsAtMs,
      durationMs: SEVEN_DAYS_MS,
      durationInferred: false,
      period: '7d',
    });
  }

  const fresh = nowMs >= data.capturedAt && nowMs - data.capturedAt < CLAUDE_STATUS_LINE_FRESH_MS;
  const status: ProviderQuotaStatus = fresh && entries.length > 0
    ? { connected: true, code: 'ok', severity: 'ok' }
    : entries.length > 0
      ? {
          connected: false,
          code: 'bridge-stale',
          label: 'cached',
          detail: 'Showing the last Claude Code statusLine quota for up to 30 minutes.',
          severity: 'warning',
        }
      : {
          connected: false,
          code: 'bridge-unavailable',
          label: 'waiting for Claude',
          detail: 'Claude Code has not reported plan usage yet.',
          severity: 'warning',
        };
  const aged = ageClaudeQuotaSnapshot({
    provider: 'claude',
    source: fresh ? 'statusLine' : 'cache',
    capturedAt: data.capturedAt,
    entries,
    status,
  }, nowMs);
  if (aged.entries.length > 0) return aged;
  return {
    ...aged,
    status: {
      connected: false,
      code: 'bridge-unavailable',
      label: 'waiting for Claude',
      detail: 'Claude Code has not reported an active plan-usage window yet.',
      severity: 'warning',
    },
  };
}

function compatibilityCredits(usage: ClaudeCompatibilityUsage): Record<string, ProviderCreditBalance> | undefined {
  const extraUsage = usage.extraUsage;
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

export function buildClaudeCompatibilityQuota(
  usage: ClaudeCompatibilityUsage,
  capturedAt: number,
  nowMs: number,
  credentialMarker?: string | null,
): ProviderQuotaSnapshot {
  const entries: QuotaEntry[] = [];
  if (usage.fiveHour) {
    entries.push(limitedEntry('5h', usage.fiveHour.usedPct, usage.fiveHour.resetsAtMs, FIVE_HOURS_MS, 'api'));
  }
  if (usage.sevenDay) {
    entries.push(limitedEntry('7d', usage.sevenDay.usedPct, usage.sevenDay.resetsAtMs, SEVEN_DAYS_MS, 'api'));
  }
  const usedTargetIds = new Set<string>();
  for (const window of usage.modelScoped) {
    const id = slug(window.label);
    if (!id) continue;
    const target = scopedTarget(window.label, id, 'api');
    if (usedTargetIds.has(target.id)) continue;
    usedTargetIds.add(target.id);
    entries.push({
      key: target.id === 'claude.group.fable' ? 'claude.fable.7d' : `claude.model.${id}.7d`,
      target,
      scope: { kind: 'model', label: target.label },
      state: 'limited',
      usedPct: window.usedPct,
      resetsAt: window.resetsAtMs,
      durationMs: SEVEN_DAYS_MS,
      durationInferred: false,
      period: '7d',
    });
  }
  const snapshot = ageClaudeQuotaSnapshot({
    provider: 'claude',
    source: 'api',
    capturedAt,
    entries,
    accountLabel: usage.planName || undefined,
    planName: usage.planName || undefined,
    credits: compatibilityCredits(usage),
    status: {
      connected: entries.length > 0,
      code: entries.length > 0 ? 'compatibility-api' : 'schema-changed',
      label: entries.length > 0 ? 'compatibility' : 'compatibility changed',
      detail: entries.length > 0
        ? 'Read-only Claude Desktop compatibility data; credentials are never refreshed or changed.'
        : 'Anthropic returned no recognized Claude quota windows.',
      severity: entries.length > 0 ? 'ok' : 'warning',
    },
  }, nowMs);
  if (credentialMarker) COMPATIBILITY_CREDENTIAL_MARKERS.set(snapshot, credentialMarker);
  return snapshot;
}

export function getClaudeQuotaCredentialMarker(snapshot: ProviderQuotaSnapshot): string | null {
  return COMPATIBILITY_CREDENTIAL_MARKERS.get(snapshot) ?? null;
}

export async function fetchClaudeQuota(ctx: ProviderContext): Promise<ProviderQuotaSnapshot> {
  const data = readClaudeStatusLineFile(undefined, ctx.nowMs);
  const local = data ? buildClaudeStatusLineQuota(data, ctx.nowMs) : null;
  if (local?.status?.connected && local.entries.length > 0) return local;

  const compatibility = await fetchClaudeCompatibilityUsage({ nowMs: ctx.nowMs });
  if (compatibility.usage) {
    return buildClaudeCompatibilityQuota(
      compatibility.usage,
      compatibility.capturedAt,
      ctx.nowMs,
      compatibility.credentialMarker,
    );
  }
  if (local?.entries.length) return local;
  return {
    provider: 'claude',
    source: 'cache',
    capturedAt: compatibility.capturedAt,
    entries: [],
    status: { ...compatibility.status, severity: 'warning' },
  };
}

export function isClaudeQuotaSnapshot(snapshot: ProviderQuotaSnapshot): boolean {
  return snapshot.provider === 'claude' && !!snapshot.status;
}
