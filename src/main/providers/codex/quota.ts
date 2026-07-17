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
  authIdentityHash: string | null;
  resetAuthMtimeMs: number | null;
  resetAuthIdentityHash: string | null;
  usageSkipped?: boolean;
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

function codexQuotaWindow(
  available: boolean,
  pct: number,
  resetMs: number | null,
  resetLabel: string,
  unlimited: boolean,
  source: ProviderQuotaSnapshot['source'],
): NonNullable<ProviderQuotaSnapshot['windows']>[string] | null {
  if (unlimited) {
    return {
      pct: 0,
      resetMs: null,
      limitState: 'unlimited',
      source,
    };
  }
  if (!available) return null;
  return {
    pct,
    resetMs,
    resetLabel: resetMs == null ? resetLabel : undefined,
    source,
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
  const usageSkipped = ctx.skipCodexUsage === true;
  const [result, resetResult] = await Promise.all([
    usageSkipped ? Promise.resolve(null) : fetchCodexUsagePct(),
    ctx.skipCodexResetCredits ? Promise.resolve(null) : fetchCodexResetCredits(),
  ]);
  const status: CodexUsageStatus = result?.status ?? { code: 'ok', connected: true, label: '', detail: '' };
  const source = usageSkipped ? 'cache' : quotaSource(status);
  const usage = result?.usage ?? null;
  const h5Window = usage ? codexQuotaWindow(usage.h5Available, usage.h5Pct, usage.h5ResetMs, 'Codex 5h reset unavailable', usage.h5Unlimited, source) : null;
  const weekWindow = usage ? codexQuotaWindow(usage.weekAvailable, usage.weekPct, usage.weekResetMs, 'Codex weekly reset unavailable', usage.weekUnlimited, source) : null;

  let resetCredits: CodexResetCreditsData | null = null;
  if (resetResult == null) {
    resetCredits = null;
  } else if (resetResult.data) {
    resetCredits = resetResult.data;
  } else {
    const rs: CodexUsageStatus = resetResult.status;
    const hardReject = rs.code === 'unauthorized' || rs.code === 'forbidden' || rs.code === 'schema-changed';
    const transientOrLimited = rs.code === 'rate-limited' || rs.code === 'network' || rs.code === 'timeout' || rs.code === 'http-error';
    if (rs.code === 'no-credentials') {
      resetCredits = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    } else if (hardReject) {
      resetCredits = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    } else if (transientOrLimited && usage) {
      resetCredits = resetCreditsFromUsagePayload(result?.rawPayload, ctx.nowMs, rs)
        ?? { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    } else {
      resetCredits = { credits: [], availableCount: 0, totalEarnedCount: 0, checkedAt: ctx.nowMs, countOnly: false, source: 'api', status: rs };
    }
  }

  return {
    provider: 'codex',
    source,
    capturedAt: ctx.nowMs,
    planName: usage?.plan || undefined,
    ...buildCodexQuotaDisplayMetadata(),
    windows: usage && (h5Window || weekWindow)
      ? {
          ...(h5Window ? { h5: h5Window } : {}),
          ...(weekWindow ? { week: weekWindow } : {}),
        }
      : undefined,
    credits: codexCredits(usage),
    status,
    usage,
    authMtimeMs: result?.authMtimeMs ?? null,
    authIdentityHash: result?.authIdentityHash ?? null,
    resetAuthMtimeMs: resetResult?.authMtimeMs ?? null,
    resetAuthIdentityHash: resetResult?.authIdentityHash ?? null,
    usageSkipped,
    resetCredits,
  };
}

export function isCodexQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is CodexProviderQuotaSnapshot {
  return snapshot.provider === 'codex' && 'status' in snapshot && 'usage' in snapshot;
}
