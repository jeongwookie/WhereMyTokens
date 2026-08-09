import {
  FIVE_HOURS_MS,
  SEVEN_DAYS_MS,
  ageProviderQuotaSnapshot,
  normalizeQuotaPeriod,
} from '../../../shared/quotaDomain';
import type {
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

const ACCOUNT_TARGET: QuotaTarget = {
  id: 'claude.group.account',
  label: 'Claude',
  defaultMode: 'rich',
  defaultOrder: 0,
  taskbarAbbreviation: 'C',
  cacheMetricTitle: 'Cache read / (cache read + cache creation)',
};

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scopedTarget(label: string, id: string): QuotaTarget {
  const isFable = /\bfable\b/i.test(label);
  return {
    id: isFable ? 'claude.group.fable' : `claude.group.${id}`,
    label: isFable ? 'Fable' : label,
    defaultMode: 'simple',
    defaultOrder: isFable ? 10 : 20,
    taskbarAbbreviation: (label.toUpperCase().match(/[A-Z0-9]/)?.[0] ?? 'C'),
    hideCost: true,
    badges: [{
      key: 'statusline',
      label: 'Local',
      title: 'Reported locally by Claude Code statusLine',
      tone: 'neutral',
    }],
  };
}

function limitedEntry(
  period: '5h' | '7d',
  usedPct: number,
  resetsAt: number | null,
  durationMs: number,
): QuotaEntry {
  return {
    key: `claude.account.${period}`,
    target: ACCOUNT_TARGET,
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
      detail: 'Use Claude Code once after enabling the statusLine integration to sync plan usage.',
      severity: 'warning',
    },
  };
}

export function ageClaudeQuotaSnapshot(
  snapshot: ProviderQuotaSnapshot,
  nowMs: number,
): ProviderQuotaSnapshot {
  const aged = ageProviderQuotaSnapshot(snapshot, nowMs);
  if (nowMs >= snapshot.capturedAt + CLAUDE_STATUS_LINE_CACHE_MAX_MS) {
    return { ...aged, entries: [] };
  }
  const fresh = nowMs >= snapshot.capturedAt
    && nowMs - snapshot.capturedAt < CLAUDE_STATUS_LINE_FRESH_MS;
  if (fresh || aged.entries.length === 0) return aged;
  return {
    ...aged,
    source: 'cache',
    status: {
      connected: false,
      code: 'bridge-stale',
      label: 'cached',
      detail: 'Showing the last Claude Code statusLine quota for up to 30 minutes.',
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
  if (fiveHour) entries.push(limitedEntry('5h', fiveHour.usedPct, fiveHour.resetsAtMs, FIVE_HOURS_MS));
  if (sevenDay) entries.push(limitedEntry('7d', sevenDay.usedPct, sevenDay.resetsAtMs, SEVEN_DAYS_MS));
  const usedTargetIds = new Set<string>();
  for (const window of data.rateLimits.modelScoped) {
    const id = slug(window.label);
    if (!id) continue;
    const target = scopedTarget(window.label, id);
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

export async function fetchClaudeQuota(ctx: ProviderContext): Promise<ProviderQuotaSnapshot> {
  const data = readClaudeStatusLineFile(undefined, ctx.nowMs);
  return data ? buildClaudeStatusLineQuota(data, ctx.nowMs) : waitingClaudeQuota(ctx.nowMs);
}

export function isClaudeQuotaSnapshot(snapshot: ProviderQuotaSnapshot): boolean {
  return snapshot.provider === 'claude' && !!snapshot.status;
}
