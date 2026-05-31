import {
  ApiUsagePct,
  AutoLimits,
  ClaudeApiStatus,
  fetchApiUsagePct,
  fetchAutoLimits,
} from '../../rateLimitFetcher';
import { getOAuthCredentialMarker } from '../../oauthRefresh';
import type { ProviderContext, ProviderCreditBalance, ProviderQuotaSnapshot } from '../types';

export interface ClaudeProviderQuotaSnapshot extends ProviderQuotaSnapshot {
  provider: 'claude';
  status: ClaudeApiStatus;
  usage: ApiUsagePct | null;
  autoLimits: AutoLimits | null;
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

export async function fetchClaudeQuota(ctx: ProviderContext): Promise<ClaudeProviderQuotaSnapshot> {
  const result = await fetchApiUsagePct();
  const autoLimits = await fetchAutoLimits();
  const source = quotaSource(result.status);
  const usage = result.usage;

  return {
    provider: 'claude',
    source,
    capturedAt: ctx.nowMs,
    accountLabel: usage?.plan || autoLimits?.plan || undefined,
    planName: usage?.plan || autoLimits?.plan || undefined,
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
    autoLimits,
    credentialMarker: getOAuthCredentialMarker(),
  };
}

export function isClaudeQuotaSnapshot(snapshot: ProviderQuotaSnapshot): snapshot is ClaudeProviderQuotaSnapshot {
  return snapshot.provider === 'claude' && 'status' in snapshot && 'usage' in snapshot;
}
