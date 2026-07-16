import {
  BREAKDOWN_KEYS,
  emptyBreakdownDelta,
  type BreakdownDelta,
} from '../../shared/breakdownTypes';
import type { ProviderId } from '../providers/types';
import {
  emptyUsageMetrics,
  type UsageEntry,
  type UsageMetrics,
  type UsageQueryGrain,
} from './types';

export type UsageBucketKind = UsageQueryGrain;

export interface UsageBucketDelta {
  sourceId: string;
  provider: ProviderId;
  model: string;
  kind: UsageBucketKind;
  bucketStartMs: number;
  metrics: UsageMetrics;
  breakdown: BreakdownDelta;
}

export function usageBucketStart(timestampMs: number, kind: UsageQueryGrain): number {
  const date = new Date(timestampMs);
  if (kind === 'hour') date.setMinutes(0, 0, 0);
  if (kind === 'day') date.setHours(0, 0, 0, 0);
  if (kind === 'month') {
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
  }
  return date.getTime();
}

export function usageBucketIdentityKey(
  sourceId: string,
  provider: ProviderId,
  model: string,
  kind: UsageBucketKind,
  bucketStartMs: number,
): string {
  return `${sourceId}\u0000${provider}\u0000${model}\u0000${kind}\u0000${bucketStartMs}`;
}

function addEntryMetrics(target: UsageMetrics, entry: UsageEntry, sign: 1 | -1): void {
  target.requestCount += sign;
  target.inputTokens += sign * entry.inputTokens;
  target.outputTokens += sign * entry.outputTokens;
  target.cacheCreationTokens += sign * entry.cacheCreationTokens;
  target.cacheReadTokens += sign * entry.cacheReadTokens;
  target.totalTokens += sign * (
    entry.inputTokens
    + entry.outputTokens
    + entry.cacheCreationTokens
    + entry.cacheReadTokens
  );
  target.costUSD += sign * entry.costUSD;
  target.cacheSavingsUSD += sign * entry.cacheSavingsUSD;
}

export function collectUsageBucketDeltas(
  target: Map<string, UsageBucketDelta>,
  sourceId: string,
  entries: readonly UsageEntry[],
  sign: 1 | -1,
): void {
  for (const entry of entries) {
    for (const kind of ['hour', 'day', 'month'] as const) {
      const bucketStartMs = usageBucketStart(entry.timestampMs, kind);
      const key = usageBucketIdentityKey(sourceId, entry.provider, entry.model, kind, bucketStartMs);
      let delta = target.get(key);
      if (!delta) {
        delta = {
          sourceId,
          provider: entry.provider,
          model: entry.model,
          kind,
          bucketStartMs,
          metrics: emptyUsageMetrics(),
          breakdown: emptyBreakdownDelta(),
        };
        target.set(key, delta);
      }
      addEntryMetrics(delta.metrics, entry, sign);
      if (entry.breakdown) {
        for (const breakdownKey of BREAKDOWN_KEYS) {
          delta.breakdown[breakdownKey] += sign * entry.breakdown[breakdownKey];
        }
      }
    }
  }
}

export function addUsageMetrics(target: UsageMetrics, delta: UsageMetrics): void {
  target.requestCount += delta.requestCount;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.totalTokens += delta.totalTokens;
  target.costUSD += delta.costUSD;
  target.cacheSavingsUSD += delta.cacheSavingsUSD;
}

export function addUsageBreakdown(target: BreakdownDelta, delta: BreakdownDelta): void {
  for (const key of BREAKDOWN_KEYS) target[key] += delta[key];
}
