import {
  CodexUsagePct,
  CodexUsageStatus,
  fetchCodexUsagePct,
} from '../../codexUsageFetcher';
import type { ProviderContext, ProviderCreditBalance, ProviderQuotaSnapshot } from '../types';

export interface CodexProviderQuotaSnapshot extends ProviderQuotaSnapshot {
  provider: 'codex';
  status: CodexUsageStatus;
  usage: CodexUsagePct | null;
  authMtimeMs: number | null;
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

export async function fetchCodexQuota(ctx: ProviderContext): Promise<CodexProviderQuotaSnapshot> {
  const result = await fetchCodexUsagePct();
  const source = quotaSource(result.status);
  const usage = result.usage;

  return {
    provider: 'codex',
    source,
    capturedAt: ctx.nowMs,
    planName: usage?.plan || undefined,
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
  };
}

export function isCodexQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is CodexProviderQuotaSnapshot {
  return snapshot.provider === 'codex' && 'status' in snapshot && 'usage' in snapshot;
}
