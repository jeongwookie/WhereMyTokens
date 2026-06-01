import {
  ApiUsagePct,
  ClaudeApiStatus,
  fetchApiUsagePct,
} from '../../rateLimitFetcher';
import { getOAuthCredentialMarker } from '../../oauthRefresh';
import type { ProviderContext, ProviderCreditBalance, ProviderQuotaSnapshot } from '../types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClaudeProviderQuotaSnapshot extends ProviderQuotaSnapshot {
  provider: 'claude';
  status: ClaudeApiStatus;
  usage: ApiUsagePct | null;
  credentialMarker: string | null;
}

function quotaSource(status: ClaudeApiStatus): ProviderQuotaSnapshot['source'] {
  return status.connected ? 'api' : 'cache';
}

function extraUsageCredits(usage: ApiUsagePct | null): Record<string, ProviderCreditBalance> | undefined {
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

export function buildClaudeQuotaDisplayMetadata(): Pick<ProviderQuotaSnapshot, 'groups' | 'windowDisplay'> {
  return {
    groups: [
      {
        key: 'account',
        label: 'Claude',
        defaultMode: 'rich',
        windowKeys: ['h5', 'week'],
        sortOrder: 0,
      },
      {
        key: 'sonnet',
        label: 'Sonnet',
        defaultMode: 'simple',
        windowKeys: ['sonnetWeek'],
        sortOrder: 10,
      },
    ],
    windowDisplay: {
      h5: {
        label: '5h',
        visualKind: 'pace',
        cacheMetricTitle: 'Cache read / (cache read + cache creation)',
        durationMs: FIVE_HOURS_MS,
      },
      week: {
        label: '1w',
        visualKind: 'pace',
        cacheMetricTitle: 'Cache read / (cache read + cache creation)',
        durationMs: SEVEN_DAYS_MS,
      },
      sonnetWeek: {
        label: '1w',
        visualKind: 'percentOnly',
        durationMs: SEVEN_DAYS_MS,
        hideCost: true,
      },
    },
  };
}

export async function fetchClaudeQuota(ctx: ProviderContext): Promise<ClaudeProviderQuotaSnapshot> {
  const result = await fetchApiUsagePct();
  const source = quotaSource(result.status);
  const usage = result.usage;

  return {
    provider: 'claude',
    source,
    capturedAt: ctx.nowMs,
    accountLabel: usage?.plan || undefined,
    planName: usage?.plan || undefined,
    ...buildClaudeQuotaDisplayMetadata(),
    windows: usage
      ? {
          h5: {
            pct: usage.h5Pct,
            resetMs: usage.h5ResetMs,
            resetLabel: usage.h5ResetMs == null ? 'Claude 5h reset unavailable' : undefined,
            source,
          },
          week: {
            pct: usage.weekPct,
            resetMs: usage.weekResetMs,
            resetLabel: usage.weekResetMs == null ? 'Claude weekly reset unavailable' : undefined,
            source,
          },
          sonnetWeek: {
            pct: usage.soPct,
            resetMs: usage.soResetMs,
            resetLabel: usage.soResetMs == null ? 'Claude Sonnet reset unavailable' : undefined,
            source,
          },
        }
      : undefined,
    credits: extraUsageCredits(usage),
    status: result.status,
    usage,
    credentialMarker: getOAuthCredentialMarker(),
  };
}

export function isClaudeQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is ClaudeProviderQuotaSnapshot {
  return snapshot.provider === 'claude' && 'status' in snapshot && 'usage' in snapshot;
}
