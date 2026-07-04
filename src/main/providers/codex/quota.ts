import {
  CodexUsagePct,
  CodexUsageStatus,
  CodexResetCreditsData,
  fetchCodexUsagePct,
  fetchCodexResetCredits,
  resetCreditsFromUsagePayload,
} from '../../codexUsageFetcher';
import type { ProviderContext, ProviderCreditBalance, ProviderQuotaSnapshot } from '../types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface CodexProviderQuotaSnapshot extends ProviderQuotaSnapshot {
  provider: 'codex';
  status: CodexUsageStatus;
  usage: CodexUsagePct | null;
  authMtimeMs: number | null;
  resetCredits: CodexResetCreditsData | null;
}

function quotaSource(status: CodexUsageStatus): ProviderQuotaSnapshot['source'] {
  return status.connected ? 'api' : 'localLog';
}

function codexCredits(usage: CodexUsagePct | null): Record<string, ProviderCreditBalance> | undefined {
  const credits = usage?.credits;
  if (!credits?.hasCredits) return undefined;
  return {
    accountCredits: {
      available: credits.unlimited ? Number.MAX_SAFE_INTEGER : 0,
      resetMs: null,
    },
  };
}

export function buildCodexQuotaDisplayMetadata(): Pick<ProviderQuotaSnapshot, 'groups' | 'windowDisplay'> {
  return {
    groups: [
      {
        key: 'account',
        label: 'Codex',
        defaultMode: 'rich',
        windowKeys: ['h5', 'week'],
        sortOrder: 0,
      },
      {
        key: 'resets',
        label: 'Codex Resets',
        defaultMode: 'simple',
        windowKeys: [],
        sortOrder: 1,
      },
    ],
    windowDisplay: {
      h5: {
        label: '5h',
        visualKind: 'pace',
        cacheMetricTitle: 'Cached input / input',
        durationMs: FIVE_HOURS_MS,
      },
      week: {
        label: '1w',
        visualKind: 'pace',
        cacheMetricTitle: 'Cached input / input',
        durationMs: SEVEN_DAYS_MS,
      },
    },
  };
}

export async function fetchCodexQuota(ctx: ProviderContext): Promise<CodexProviderQuotaSnapshot> {
  // R2-2: reset has its OWN cooldown. When it is active the StateManager sets
  // ctx.skipCodexResetCredits so we skip ONLY the dedicated reset GET (usage GET still fires,
  // keeping its 5-min cadence). resetResult is null in that case and we leave stored data alone.
  const [result, resetResult] = await Promise.all([
    fetchCodexUsagePct(),
    ctx.skipCodexResetCredits ? Promise.resolve(null) : fetchCodexResetCredits(),
  ]);
  const source = quotaSource(result.status);
  const usage = result.usage;

  // Reset credits: choose the object AND its status by the reset outcome class (R2-1).
  let resetCredits: CodexResetCreditsData | null = null;
  if (resetResult == null) {
    // Cooldown skip: do not overwrite; leave stored data untouched (null => StateManager keeps cache).
    resetCredits = null;
  } else if (resetResult.data) {
    resetCredits = resetResult.data;                       // dedicated endpoint succeeded
  } else {
    const rs: CodexUsageStatus = resetResult.status;
    const hardReject = rs.code === 'unauthorized' || rs.code === 'forbidden' || rs.code === 'schema-changed';
    const transientOrLimited = rs.code === 'rate-limited' || rs.code === 'network' || rs.code === 'timeout' || rs.code === 'http-error';
    if (rs.code === 'no-credentials') {
      resetCredits = null;                                  // no creds -> StateManager clears cache via status
    } else if (hardReject) {
      // 401/403/schema-changed: do NOT show a possibly-stale count from usage; surface the error and let
      // Task 3 evict the reset cache. Carry the failing status, empty list.
      resetCredits = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    } else if (transientOrLimited && usage) {
      // 429 / transient with usage OK: count-only fallback IS allowed, but it carries the REAL failing
      // status (not a synthetic ok) so codexResetBackoffMs fires (429 Retry-After) and the card renders
      // stale/error rather than fresh-ok. rawPayload is a free byproduct of the usage fetch.
      resetCredits = resetCreditsFromUsagePayload(result.rawPayload, ctx.nowMs, rs)
        ?? { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    } else {
      // transient without usage, or anything else non-ok: carry the failing status, empty.
      resetCredits = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    }
  }

  return {
    provider: 'codex',
    source,
    capturedAt: ctx.nowMs,
    planName: usage?.plan || undefined,
    ...buildCodexQuotaDisplayMetadata(),
    windows: usage
      ? {
          ...(usage.h5Available
            ? {
                h5: {
                  pct: usage.h5Pct,
                  resetMs: usage.h5ResetMs,
                  resetLabel: usage.h5ResetMs == null ? 'Codex 5h reset unavailable' : undefined,
                  source,
                },
              }
            : {}),
          ...(usage.weekAvailable
            ? {
                week: {
                  pct: usage.weekPct,
                  resetMs: usage.weekResetMs,
                  resetLabel: usage.weekResetMs == null ? 'Codex weekly reset unavailable' : undefined,
                  source,
                },
              }
            : {}),
        }
      : undefined,
    credits: codexCredits(usage),
    status: result.status,
    usage,
    authMtimeMs: result.authMtimeMs,
    resetCredits,
  };
}

export function isCodexQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is CodexProviderQuotaSnapshot {
  return snapshot.provider === 'codex' && 'status' in snapshot && 'usage' in snapshot;
}
