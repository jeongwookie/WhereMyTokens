import type {
  ProviderContext,
  ProviderLedgerSource,
  ProviderUsageScanResult,
} from '../types';
import type { FileUsageSummary } from '../../jsonlTypes';
import { replaceProviderUsageSliceInSnapshot } from '../../usageLedgerIngest';
import { buildAntigravitySummary } from './summary';
import { findAntigravityServersCached } from './runtimeCache';
import { AntigravityGmTracker } from './gmTracker';
import { AntigravityUsageCacheStore } from './usageCacheStore';
import type { AntigravityServerInfo } from './types';

const DEFAULT_DEADLINE_MS = 8_000;

function deadlineMs(ctx: ProviderContext): number {
  return Date.now() + Math.min(ctx.scanBudgetMs ?? DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS);
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function buildCacheLedgerSource(cacheStore: AntigravityUsageCacheStore): ProviderLedgerSource {
  const sourceId = 'antigravity:usage-cache';
  return {
    provider: 'antigravity',
    sourceId,
    priority: false,
    importIntoSnapshot: async (snapshot, nowMs) =>
      replaceProviderUsageSliceInSnapshot(snapshot, cacheStore.buildLedgerSlice(nowMs), nowMs),
  };
}

function summariesFromCache(cacheStore: AntigravityUsageCacheStore, nowMs: number): Map<string, FileUsageSummary> {
  const summaries = new Map<string, FileUsageSummary>();
  for (const cascade of cacheStore.listCascades()) {
    const calls = Object.values(cascade.calls).sort((a, b) => a.timestampMs - b.timestampMs);
    if (calls.length === 0) continue;
    summaries.set(`antigravity:cascade:${cascade.cascadeId}`, buildAntigravitySummary({
      cascadeId: cascade.cascadeId,
      calls,
      nowMs,
      lastModifiedMs: cascade.lastModifiedMs,
    }));
  }
  return summaries;
}

export async function scanAntigravityUsageFromServers(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt = deadlineMs(ctx),
  cacheStore = new AntigravityUsageCacheStore(),
): Promise<ProviderUsageScanResult> {
  const tracker = new AntigravityGmTracker(cacheStore);
  const result = await tracker.fetchAllFromServers(ctx, servers, stopAt);
  const summaries = summariesFromCache(cacheStore, ctx.nowMs);
  return {
    summaries,
    ledgerSources: [buildCacheLedgerSource(cacheStore)],
    scannedSources: result.scannedSources,
    partial: result.partial,
  };
}

export async function scanAntigravityUsage(ctx: ProviderContext): Promise<ProviderUsageScanResult> {
  const stopAt = deadlineMs(ctx);
  const servers = await findAntigravityServersCached(ctx.nowMs, remainingTimeoutMs(stopAt));
  return scanAntigravityUsageFromServers(ctx, servers, stopAt);
}
