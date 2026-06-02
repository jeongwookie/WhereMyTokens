import type { CompactRecentEntry, FileUsageSummary, HistoricalModelTotal, HistoricalRollup } from '../../jsonlTypes';
import {
  emptyHistoricalAggregate,
  emptyHistoricalRollup,
  emptySessionSnapshot,
} from '../../jsonlTypes';
import { aggregateFromUsageEntry } from '../../usageLedgerIngest';
import type { AntigravityUsageCall } from './gmParser';
import { activityBreakdownFromCalls, antigravityCallRequestId } from './gmParser';
import { estimateAntigravityCacheSavingsUSD, estimateAntigravityCostUSD } from './pricing';

const RECENT_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
const HOURLY_BUCKET_WINDOW_MS = 150 * 24 * 60 * 60 * 1000;

type AntigravityRecentEntry = CompactRecentEntry & { provider: 'antigravity' };

export function antigravityUsageEntryFromCall(call: AntigravityUsageCall): AntigravityRecentEntry {
  return {
    requestId: antigravityCallRequestId(call),
    timestampMs: call.timestampMs,
    model: call.model,
    provider: 'antigravity',
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationTokens: call.cacheCreationTokens,
    cacheReadTokens: call.cacheReadTokens,
    costUSD: estimateAntigravityCostUSD(call),
    cacheSavingsUSD: estimateAntigravityCacheSavingsUSD(call),
  };
}

function addToRollup(rollup: HistoricalRollup, entry: AntigravityRecentEntry, nowMs: number): void {
  const aggregate = aggregateFromUsageEntry(entry);
  Object.assign(rollup.aggregate, {
    requestCount: rollup.aggregate.requestCount + aggregate.requestCount,
    inputTokens: rollup.aggregate.inputTokens + aggregate.inputTokens,
    outputTokens: rollup.aggregate.outputTokens + aggregate.outputTokens,
    cacheCreationTokens: rollup.aggregate.cacheCreationTokens + aggregate.cacheCreationTokens,
    cacheReadTokens: rollup.aggregate.cacheReadTokens + aggregate.cacheReadTokens,
    totalTokens: rollup.aggregate.totalTokens + aggregate.totalTokens,
    costUSD: rollup.aggregate.costUSD + aggregate.costUSD,
    cacheSavingsUSD: rollup.aggregate.cacheSavingsUSD + aggregate.cacheSavingsUSD,
  });

  const modelKey = `${entry.provider}:${entry.model}`;
  const modelTotal: HistoricalModelTotal = rollup.modelTotals[modelKey] ?? {
    model: entry.model,
    provider: entry.provider,
    tokens: 0,
    costUSD: 0,
  };
  modelTotal.tokens += aggregate.totalTokens;
  modelTotal.costUSD += aggregate.costUSD;
  rollup.modelTotals[modelKey] = modelTotal;

  if (entry.timestampMs < nowMs - HOURLY_BUCKET_WINDOW_MS) return;
  const bucketStartMs = entry.timestampMs - (entry.timestampMs % (60 * 60 * 1000));
  const bucketKey = String(bucketStartMs);
  const bucket = rollup.hourlyBuckets[bucketKey] ?? {
    timestampMs: bucketStartMs,
    ...emptyHistoricalAggregate(),
  };
  bucket.requestCount += aggregate.requestCount;
  bucket.inputTokens += aggregate.inputTokens;
  bucket.outputTokens += aggregate.outputTokens;
  bucket.cacheCreationTokens += aggregate.cacheCreationTokens;
  bucket.cacheReadTokens += aggregate.cacheReadTokens;
  bucket.totalTokens += aggregate.totalTokens;
  bucket.costUSD += aggregate.costUSD;
  bucket.cacheSavingsUSD += aggregate.cacheSavingsUSD;
  rollup.hourlyBuckets[bucketKey] = bucket;
}

export function buildAntigravitySummary(params: {
  cascadeId: string;
  calls: AntigravityUsageCall[];
  nowMs: number;
  lastModifiedMs: number;
}): FileUsageSummary {
  const recentEntries: CompactRecentEntry[] = [];
  const historicalRollup = emptyHistoricalRollup();
  const cutoff = params.nowMs - RECENT_WINDOW_MS;
  const entries = params.calls.map(antigravityUsageEntryFromCall);

  for (const entry of entries) {
    if (entry.timestampMs >= cutoff) recentEntries.push(entry);
    else addToRollup(historicalRollup, entry, params.nowMs);
  }

  const latest = params.calls[params.calls.length - 1];
  const snapshot = emptySessionSnapshot('tokens');
  if (latest) {
    snapshot.modelName = latest.model;
    snapshot.rawModel = latest.rawModel;
    snapshot.latestInputTokens = latest.inputTokens;
    snapshot.latestCacheCreationTokens = latest.cacheCreationTokens;
    snapshot.latestCacheReadTokens = latest.cacheReadTokens;
    if (latest.contextMax) snapshot.contextMax = latest.contextMax;
  }

  const toolCounts: Record<string, number> = {};
  for (const call of params.calls) {
    for (const tool of call.toolNames) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
  }

  snapshot.toolCounts = toolCounts;
  snapshot.activityBreakdown = activityBreakdownFromCalls(params.calls);
  snapshot.activityBreakdownKind = 'tokens';

  return {
    provider: 'antigravity',
    sessionSnapshot: snapshot,
    recentEntries,
    historicalRollup,
    byteOffset: 0,
    mtimeMs: params.lastModifiedMs,
    size: 0,
    lastAccessedAt: params.nowMs,
    rehydratedFromPersistence: false,
  };
}
