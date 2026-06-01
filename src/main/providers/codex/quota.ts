import {
  CodexUsagePct,
  CodexUsageStatus,
  fetchCodexUsagePct,
} from '../../codexUsageFetcher';
import type { ProviderContext, ProviderCreditBalance, ProviderQuotaSnapshot } from '../types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
  const result = await fetchCodexUsagePct();
  const source = quotaSource(result.status);
  const usage = result.usage;

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
  };
}

export function isCodexQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is CodexProviderQuotaSnapshot {
  return snapshot.provider === 'codex' && 'status' in snapshot && 'usage' in snapshot;
}
