import {
  CodexQuotaPayload,
  CodexUsageStatus,
  CodexResetCreditsData,
  fetchCodexQuota as fetchCodexQuotaApi,
  fetchCodexResetCredits,
  resetCreditsFromUsagePayload,
} from '../../codexUsageFetcher';
import { normalizeQuotaPeriod } from '../../../shared/quotaDomain';
import type {
  ProviderCreditBalance,
  ProviderQuotaSnapshot,
  QuotaEntry,
  QuotaTarget,
} from '../../../shared/quotaTypes';
import type { ProviderContext } from '../types';

const ACCOUNT_TARGET: QuotaTarget = {
  id: 'codex.group.account',
  label: 'Codex',
  defaultMode: 'rich',
  defaultOrder: 0,
  taskbarAbbreviation: 'X',
  cacheMetricTitle: 'Cached input / input',
};

export interface CodexProviderQuotaSnapshot extends ProviderQuotaSnapshot {
  provider: 'codex';
  status: CodexUsageStatus;
  authMtimeMs: number | null;
  authIdentityHash: string | null;
  resetAuthMtimeMs: number | null;
  resetAuthIdentityHash: string | null;
  usageSkipped?: boolean;
  resetCredits: CodexResetCreditsData | null;
}

function codexCredits(usage: CodexQuotaPayload | null): Record<string, ProviderCreditBalance> | undefined {
  const credits = usage?.credits;
  if (!credits?.hasCredits) return undefined;
  return {
    accountCredits: {
      available: credits.unlimited ? Number.MAX_SAFE_INTEGER : 0,
      resetMs: null,
    },
  };
}

export function codexQuotaEntries(usage: CodexQuotaPayload | null): QuotaEntry[] {
  if (!usage) return [];
  return usage.windows.map((window): QuotaEntry => {
    const period = normalizeQuotaPeriod(window.durationMs);
    if (period == null) throw new Error('Codex quota adapter received an unsupported duration');
    return {
      key: `codex.account.${period}`,
      target: ACCOUNT_TARGET,
      scope: { kind: 'account' },
      state: 'limited',
      usedPct: window.usedPct,
      resetsAt: window.resetsAt,
      durationMs: window.durationMs,
      durationInferred: false,
      period,
      usageBinding: { kind: 'all-provider-models' },
    };
  });
}

export async function fetchCodexQuota(ctx: ProviderContext): Promise<CodexProviderQuotaSnapshot> {
  const usageSkipped = ctx.skipCodexUsage === true;
  const [result, resetResult] = await Promise.all([
    usageSkipped ? Promise.resolve(null) : fetchCodexQuotaApi(),
    ctx.skipCodexResetCredits ? Promise.resolve(null) : fetchCodexResetCredits(),
  ]);
  const status: CodexUsageStatus = result?.status ?? { code: 'ok', connected: true, label: '', detail: '' };
  const source = usageSkipped ? 'cache' : status.connected ? 'api' : 'localLog';
  const usage = result?.usage ?? null;

  let resetCredits: CodexResetCreditsData | null = null;
  if (resetResult == null) {
    resetCredits = null;
  } else if (resetResult.data) {
    resetCredits = resetResult.data;
  } else {
    const resetStatus: CodexUsageStatus = resetResult.status;
    const transientOrLimited = resetStatus.code === 'rate-limited'
      || resetStatus.code === 'network'
      || resetStatus.code === 'timeout'
      || resetStatus.code === 'http-error';
    resetCredits = transientOrLimited && usage
      ? resetCreditsFromUsagePayload(result?.rawPayload, ctx.nowMs, resetStatus)
      : null;
    resetCredits ??= {
      credits: [],
      availableCount: 0,
      totalEarnedCount: 0,
      checkedAt: ctx.nowMs,
      countOnly: false,
      source: 'api',
      status: resetStatus,
    };
  }

  return {
    provider: 'codex',
    source,
    capturedAt: ctx.nowMs,
    entries: status.connected && !usageSkipped ? codexQuotaEntries(usage) : [],
    planName: usage?.plan || undefined,
    credits: codexCredits(usage),
    status,
    authMtimeMs: result?.authMtimeMs ?? null,
    authIdentityHash: result?.authIdentityHash ?? null,
    resetAuthMtimeMs: resetResult?.authMtimeMs ?? null,
    resetAuthIdentityHash: resetResult?.authIdentityHash ?? null,
    usageSkipped,
    resetCredits,
  };
}

export function isCodexQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is CodexProviderQuotaSnapshot {
  return snapshot.provider === 'codex' && !!snapshot.status && 'authMtimeMs' in snapshot;
}
