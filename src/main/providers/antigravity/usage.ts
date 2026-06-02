import type {
  ProviderContext,
  ProviderLedgerSource,
  ProviderUsageScanResult,
} from '../types';
import type { FileUsageSummary } from '../../jsonlTypes';
import { replaceProviderUsageSliceInSnapshot } from '../../usageLedgerIngest';
import { buildAntigravitySummary } from './summary';
import { findAntigravityServersCached, getTrajectorySummariesCached } from './runtimeCache';
import { AntigravityGmTracker } from './gmTracker';
import { AntigravityUsageCacheStore } from './usageCacheStore';
import { antigravityCascadeSummaryKey, antigravityServerOwnerKey } from './serverIdentity';
import type { AntigravityServerInfo } from './types';

const DEFAULT_DEADLINE_MS = 8_000;

function deadlineMs(ctx: ProviderContext): number {
  return Date.now() + Math.min(ctx.scanBudgetMs ?? DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS);
}

function remainingTimeoutMs(stopAt: number): number {
  return Math.max(1, Math.min(8_000, stopAt - Date.now()));
}

function newestCascadeMs(response: unknown): number {
  const rawSummaries = (response as { trajectorySummaries?: unknown } | null)?.trajectorySummaries;
  const summaries = rawSummaries && typeof rawSummaries === 'object' && !Array.isArray(rawSummaries)
    ? rawSummaries as Record<string, unknown>
    : {};
  let newest = 0;
  for (const summary of Object.values(summaries)) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    const value = (summary as { lastModifiedTime?: unknown; createdTime?: unknown }).lastModifiedTime
      ?? (summary as { createdTime?: unknown }).createdTime;
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? new Date(value).getTime() : 0;
    if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp);
  }
  return newest;
}

async function selectPrimaryUsageServer(
  ctx: ProviderContext,
  servers: AntigravityServerInfo[],
  stopAt: number,
): Promise<AntigravityServerInfo | null> {
  let best: { server: AntigravityServerInfo; score: number } | null = null;
  for (const server of servers) {
    if (Date.now() >= stopAt) break;
    const trajectories = await getTrajectorySummariesCached(server, ctx.nowMs, remainingTimeoutMs(stopAt));
    const score = newestCascadeMs(trajectories) + ((server.processStartedAtMs ?? 0) / 10_000);
    if (!best || score > best.score) best = { server, score };
  }
  return best?.server ?? null;
}

function buildCacheLedgerSource(cacheStore: AntigravityUsageCacheStore, ownerKey?: string): ProviderLedgerSource {
  const sourceId = 'antigravity:usage-cache';
  return {
    provider: 'antigravity',
    sourceId,
    priority: false,
    importIntoSnapshot: async (snapshot, nowMs) =>
      replaceProviderUsageSliceInSnapshot(snapshot, cacheStore.buildLedgerSlice(nowMs, ownerKey), nowMs),
  };
}

function summariesFromCache(cacheStore: AntigravityUsageCacheStore, nowMs: number, ownerKey?: string): Map<string, FileUsageSummary> {
  const summaries = new Map<string, FileUsageSummary>();
  for (const cascade of cacheStore.listCascades(ownerKey)) {
    const calls = Object.values(cascade.calls).sort((a, b) => a.timestampMs - b.timestampMs);
    if (calls.length === 0) continue;
    summaries.set(antigravityCascadeSummaryKey(cascade.ownerKey, cascade.cascadeId), buildAntigravitySummary({
      cascadeId: cascade.cascadeId,
      projectKeys: cascade.projectKeys,
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
  const primaryServer = await selectPrimaryUsageServer(ctx, servers, stopAt);
  const ownerKey = primaryServer ? antigravityServerOwnerKey(primaryServer) : undefined;
  const tracker = new AntigravityGmTracker(cacheStore);
  const result = await tracker.fetchAllFromServers(ctx, primaryServer ? [primaryServer] : servers, stopAt);
  const summaries = summariesFromCache(cacheStore, ctx.nowMs, ownerKey);
  return {
    summaries,
    ledgerSources: [buildCacheLedgerSource(cacheStore, ownerKey)],
    scannedSources: result.scannedSources,
    partial: result.partial,
  };
}

export async function scanAntigravityUsage(ctx: ProviderContext): Promise<ProviderUsageScanResult> {
  const stopAt = deadlineMs(ctx);
  const servers = await findAntigravityServersCached(ctx.nowMs, remainingTimeoutMs(stopAt));
  return scanAntigravityUsageFromServers(ctx, servers, stopAt);
}
