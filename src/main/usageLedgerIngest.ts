import type { ProviderId } from './providers/types';
import {
  DAILY_MODEL_RETENTION_MS,
  HOURLY_ACTIVITY_RETENTION_MS,
  MINUTE_RECENT_RETENTION_MS,
  SOURCE_REPAIR_RETENTION_MS,
  UsageAggregate,
  UsageLedgerProvider,
  UsageLedgerSnapshot,
  isUsageLedgerProvider,
} from './usageLedgerTypes';
import {
  addUsageAggregate,
  aggregateFromParts,
  dayModelKey,
  emptyUsageAggregate,
  hourProviderKey,
  hourSourceModelKey,
  localDateKey,
  minuteKey,
  monthModelKey,
  subtractUsageAggregate,
} from './usageLedgerAggregates';

export const LEDGER_IMPORT_YIELD_EVERY = 250;

export interface UsageLedgerIngestUsageEntry {
  provider: ProviderId;
  requestId: string;
  timestampMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD?: number;
  cacheSavingsUSD?: number;
}

export interface UsageLedgerIngestEntry {
  entry: UsageLedgerIngestUsageEntry;
  aggregate: UsageAggregate;
}

export interface UsageLedgerIngestSource {
  provider: ProviderId;
  sourceHash: string;
  sourceKey?: string;
  size?: number;
  mtimeMs?: number;
  byteOffset?: number;
  cursor?: string;
  rawModel?: string;
}

function cooperativeYield(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function cloneAggregate(aggregate: UsageAggregate): UsageAggregate {
  return { ...aggregate };
}

export function cloneUsageLedgerSnapshot(snapshot: UsageLedgerSnapshot): UsageLedgerSnapshot {
  return {
    ...snapshot,
    minuteRecent: Object.fromEntries(Object.entries(snapshot.minuteRecent).map(([key, value]) => [key, cloneAggregate(value)])),
    recentRequestIndex: Object.fromEntries(Object.entries(snapshot.recentRequestIndex).map(([key, value]) => [key, { ...value, aggregate: cloneAggregate(value.aggregate) }])),
    hourlyActivity: Object.fromEntries(Object.entries(snapshot.hourlyActivity).map(([key, value]) => [key, cloneAggregate(value)])),
    dailyModel: Object.fromEntries(Object.entries(snapshot.dailyModel).map(([key, value]) => [key, cloneAggregate(value)])),
    monthlyModel: Object.fromEntries(Object.entries(snapshot.monthlyModel).map(([key, value]) => [key, cloneAggregate(value)])),
    sourceCheckpoints: Object.fromEntries(Object.entries(snapshot.sourceCheckpoints).map(([key, value]) => [key, { ...value }])),
    sourceRepairRollup: Object.fromEntries(Object.entries(snapshot.sourceRepairRollup).map(([key, value]) => [key, cloneAggregate(value)])),
  };
}

export function aggregateFromUsageEntry(entry: UsageLedgerIngestUsageEntry): UsageAggregate {
  return aggregateFromParts({
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    cacheReadTokens: entry.cacheReadTokens,
    costUSD: entry.costUSD ?? 0,
    cacheSavingsUSD: entry.cacheSavingsUSD ?? 0,
  });
}

function addToRecord(record: Record<string, UsageAggregate>, key: string, aggregate: UsageAggregate): void {
  const current = record[key] ?? emptyUsageAggregate();
  addUsageAggregate(current, aggregate);
  record[key] = current;
}

function subtractFromRecord(record: Record<string, UsageAggregate>, key: string, aggregate: UsageAggregate): void {
  const current = record[key];
  if (!current) return;
  subtractUsageAggregate(current, aggregate);
  if (current.requestCount <= 0 || current.totalTokens <= 0) delete record[key];
  else record[key] = current;
}

function parseMinuteLedgerKey(key: string): { timestampMs: number; provider: UsageLedgerProvider; model: string } | null {
  const [timestampRaw, providerRaw, ...modelParts] = key.split('|');
  const timestampMs = Number(timestampRaw);
  const model = modelParts.join('|');
  if (!Number.isFinite(timestampMs) || !isUsageLedgerProvider(providerRaw) || !model) return null;
  return { timestampMs, provider: providerRaw, model };
}

function subtractExistingRecentRequest(
  snapshot: UsageLedgerSnapshot,
  sourceHash: string,
  requestIndexKey: string,
  existing: UsageLedgerSnapshot['recentRequestIndex'][string],
): void {
  const row = parseMinuteLedgerKey(existing.minuteKey);
  if (!row) {
    delete snapshot.recentRequestIndex[requestIndexKey];
    return;
  }
  subtractFromRecord(snapshot.minuteRecent, existing.minuteKey, existing.aggregate);
  subtractFromRecord(snapshot.hourlyActivity, hourProviderKey(row.timestampMs, row.provider), existing.aggregate);
  subtractFromRecord(snapshot.dailyModel, dayModelKey(row.timestampMs, row.provider, row.model), existing.aggregate);
  subtractFromRecord(snapshot.monthlyModel, monthModelKey(row.timestampMs, row.provider, row.model), existing.aggregate);
  subtractFromRecord(snapshot.sourceRepairRollup, hourSourceModelKey(sourceHash, row.timestampMs, row.provider, row.model), existing.aggregate);
  delete snapshot.recentRequestIndex[requestIndexKey];
}

function addEntryToSnapshot(next: UsageLedgerSnapshot, sourceHash: string, sourceEntry: UsageLedgerIngestEntry, nowMs: number): void {
  const { entry, aggregate } = sourceEntry;
  const provider = entry.provider;
  const requestIndexKey = `${sourceHash}|${entry.requestId}`;
  const existing = next.recentRequestIndex[requestIndexKey];
  if (existing) {
    if (existing.aggregate.outputTokens >= aggregate.outputTokens) return;
    subtractExistingRecentRequest(next, sourceHash, requestIndexKey, existing);
  }

  if (entry.timestampMs >= nowMs - MINUTE_RECENT_RETENTION_MS) {
    const key = minuteKey(entry.timestampMs, provider, entry.model);
    addToRecord(next.minuteRecent, key, aggregate);
    next.recentRequestIndex[requestIndexKey] = {
      minuteKey: key,
      aggregate: cloneAggregate(aggregate),
      lastSeenMs: nowMs,
    };
  }

  if (entry.timestampMs >= nowMs - HOURLY_ACTIVITY_RETENTION_MS) {
    addToRecord(next.hourlyActivity, hourProviderKey(entry.timestampMs, provider), aggregate);
  }

  if (entry.timestampMs >= nowMs - DAILY_MODEL_RETENTION_MS) {
    addToRecord(next.dailyModel, dayModelKey(localDateKey(entry.timestampMs), provider, entry.model), aggregate);
  }

  addToRecord(next.monthlyModel, monthModelKey(localDateKey(entry.timestampMs), provider, entry.model), aggregate);

  if (entry.timestampMs >= nowMs - SOURCE_REPAIR_RETENTION_MS) {
    addToRecord(next.sourceRepairRollup, hourSourceModelKey(sourceHash, entry.timestampMs, provider, entry.model), aggregate);
  }
}

export async function importUsageEntriesIntoSnapshot(
  snapshot: UsageLedgerSnapshot,
  source: UsageLedgerIngestSource,
  entries: UsageLedgerIngestEntry[],
  nowMs = Date.now(),
): Promise<UsageLedgerSnapshot> {
  for (const sourceEntry of entries) {
    if (sourceEntry.entry.provider !== source.provider) {
      throw new Error(`Provider mismatch for source ${source.sourceHash}: entry ${sourceEntry.entry.requestId} uses ${sourceEntry.entry.provider}, expected ${source.provider}`);
    }
  }

  const next = cloneUsageLedgerSnapshot(snapshot);
  let processedEntries = 0;
  for (const entry of entries) {
    addEntryToSnapshot(next, source.sourceHash, entry, nowMs);
    processedEntries += 1;
    if (processedEntries % LEDGER_IMPORT_YIELD_EVERY === 0) await cooperativeYield();
  }

  const currentCheckpoint = snapshot.sourceCheckpoints[source.sourceHash];
  next.sourceCheckpoints[source.sourceHash] = {
    provider: source.provider,
    sourceHash: source.sourceHash,
    lastImportedAt: nowMs,
    hasUsage: (currentCheckpoint?.hasUsage ?? false) || entries.length > 0,
    ...(source.sourceKey ? { sourceKey: source.sourceKey } : {}),
    ...(Number.isFinite(source.size) ? { size: source.size } : {}),
    ...(Number.isFinite(source.mtimeMs) ? { mtimeMs: source.mtimeMs } : {}),
    ...(Number.isFinite(source.byteOffset) ? { byteOffset: source.byteOffset } : {}),
    ...(source.cursor ? { cursor: source.cursor } : {}),
    ...(source.rawModel ? { rawModel: source.rawModel } : (currentCheckpoint?.rawModel ? { rawModel: currentCheckpoint.rawModel } : {})),
  };

  return next;
}
