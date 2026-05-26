import Store from 'electron-store';
import { compactUsageLedgerSnapshot, emptyUsageLedgerSnapshot } from './usageLedgerAggregates';
import { SourceCheckpoint, UsageAggregate, USAGE_LEDGER_SCHEMA_VERSION, UsageLedgerSnapshot, UsageLedgerStoreShape } from './usageLedgerTypes';

interface StoreLike {
  get(key: 'ledger'): UsageLedgerSnapshot | undefined;
  set(key: 'ledger', value: UsageLedgerSnapshot): void;
}

function objectRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeAggregate(value: unknown): UsageAggregate | null {
  const raw = objectRecord<unknown>(value);
  const requestCount = finiteNumber(raw.requestCount);
  const inputTokens = finiteNumber(raw.inputTokens);
  const outputTokens = finiteNumber(raw.outputTokens);
  const cacheCreationTokens = finiteNumber(raw.cacheCreationTokens);
  const cacheReadTokens = finiteNumber(raw.cacheReadTokens);
  const totalTokens = finiteNumber(raw.totalTokens);
  const costUSD = finiteNumber(raw.costUSD);
  const cacheSavingsUSD = finiteNumber(raw.cacheSavingsUSD);
  if (requestCount == null || inputTokens == null || outputTokens == null || cacheCreationTokens == null
    || cacheReadTokens == null || totalTokens == null || costUSD == null || cacheSavingsUSD == null) {
    return null;
  }
  return { requestCount, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, costUSD, cacheSavingsUSD };
}

function normalizeAggregateRecord(value: unknown): Record<string, UsageAggregate> {
  const normalized: Record<string, UsageAggregate> = {};
  for (const [key, aggregate] of Object.entries(objectRecord<unknown>(value))) {
    const next = normalizeAggregate(aggregate);
    if (next) normalized[key] = next;
  }
  return normalized;
}

function normalizeRecentRequestIndex(value: unknown): UsageLedgerSnapshot['recentRequestIndex'] {
  const normalized: UsageLedgerSnapshot['recentRequestIndex'] = {};
  for (const [key, entry] of Object.entries(objectRecord<unknown>(value))) {
    const raw = objectRecord<unknown>(entry);
    const aggregate = normalizeAggregate(raw.aggregate);
    const lastSeenMs = finiteNumber(raw.lastSeenMs);
    if (typeof raw.minuteKey !== 'string' || !aggregate || lastSeenMs == null) continue;
    normalized[key] = { minuteKey: raw.minuteKey, aggregate, lastSeenMs };
  }
  return normalized;
}

function normalizeSourceCheckpointRecord(value: unknown): Record<string, SourceCheckpoint> {
  const normalized: Record<string, SourceCheckpoint> = {};
  for (const [key, checkpoint] of Object.entries(objectRecord<unknown>(value))) {
    const raw = objectRecord<unknown>(checkpoint);
    if (raw.provider !== 'claude' && raw.provider !== 'codex') continue;
    if (typeof raw.sourceHash !== 'string') continue;
    const size = finiteNumber(raw.size);
    const mtimeMs = finiteNumber(raw.mtimeMs);
    const byteOffset = finiteNumber(raw.byteOffset);
    const lastImportedAt = finiteNumber(raw.lastImportedAt);
    if (size == null || mtimeMs == null || byteOffset == null || lastImportedAt == null) continue;
    normalized[key] = {
      provider: raw.provider,
      sourceHash: raw.sourceHash,
      size,
      mtimeMs,
      byteOffset,
      lastImportedAt,
      ...(typeof raw.hasUsage === 'boolean' ? { hasUsage: raw.hasUsage } : {}),
      ...(typeof raw.needsRebuild === 'boolean' ? { needsRebuild: raw.needsRebuild } : {}),
      ...(typeof raw.rebuildReason === 'string' ? { rebuildReason: raw.rebuildReason } : {}),
      ...(typeof raw.rawModel === 'string' ? { rawModel: raw.rawModel } : {}),
    };
  }
  return normalized;
}

function normalizeSnapshot(value: unknown): UsageLedgerSnapshot {
  if (!value || typeof value !== 'object') return emptyUsageLedgerSnapshot();
  const raw = value as Partial<UsageLedgerSnapshot>;
  if (raw.schemaVersion !== USAGE_LEDGER_SCHEMA_VERSION) return emptyUsageLedgerSnapshot();
  return {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: normalizeAggregateRecord(raw.minuteRecent),
    recentRequestIndex: normalizeRecentRequestIndex(raw.recentRequestIndex),
    hourlyActivity: normalizeAggregateRecord(raw.hourlyActivity),
    dailyModel: normalizeAggregateRecord(raw.dailyModel),
    monthlyModel: normalizeAggregateRecord(raw.monthlyModel),
    sourceCheckpoints: normalizeSourceCheckpointRecord(raw.sourceCheckpoints),
    sourceRepairRollup: normalizeAggregateRecord(raw.sourceRepairRollup),
    lastCompactedAt: typeof raw.lastCompactedAt === 'number' ? raw.lastCompactedAt : 0,
    lastFullImportAt: typeof raw.lastFullImportAt === 'number' && Number.isFinite(raw.lastFullImportAt) ? raw.lastFullImportAt : 0,
  };
}

export class UsageLedgerStore {
  private readonly store: StoreLike;

  constructor(store?: StoreLike) {
    this.store = store ?? new Store<UsageLedgerStoreShape>({
      name: 'usage-ledger',
      defaults: { ledger: emptyUsageLedgerSnapshot() },
    }) as unknown as StoreLike;
  }

  getSnapshot(): UsageLedgerSnapshot {
    return normalizeSnapshot(this.store.get('ledger'));
  }

  replaceSnapshot(snapshot: UsageLedgerSnapshot): void {
    this.store.set('ledger', normalizeSnapshot(snapshot));
  }

  compact(nowMs = Date.now()): UsageLedgerSnapshot {
    const next = compactUsageLedgerSnapshot(this.getSnapshot(), nowMs);
    this.replaceSnapshot(next);
    return next;
  }

  reset(): void {
    this.replaceSnapshot(emptyUsageLedgerSnapshot());
  }
}
