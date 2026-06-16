import Store from 'electron-store';
import { BREAKDOWN_KEYS, type BreakdownDelta } from '../shared/breakdownTypes';
import type { ProviderId } from './providers/types';
import { compactUsageLedgerSnapshot, emptyUsageLedgerSnapshot } from './usageLedgerAggregates';
import { DailyBreakdownRow, SourceCheckpoint, UsageAggregate, USAGE_LEDGER_SCHEMA_VERSION, UsageLedgerSnapshot, UsageLedgerStoreShape } from './usageLedgerTypes';

interface StoreLike {
  get(key: 'ledger'): UsageLedgerSnapshot | undefined;
  set(key: 'ledger', value: UsageLedgerSnapshot): void;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

function objectRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, T>
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isProviderId(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex' || value === 'antigravity';
}

function isUsageLedgerProviderId(value: unknown): boolean {
  return isProviderId(value) || value === 'other';
}

function validDateKey(value: string): boolean {
  if (!DATE_KEY_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

function validMonthKey(value: string): boolean {
  if (!MONTH_KEY_RE.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

function validDailyModelKey(key: string): boolean {
  const [date, provider, ...modelParts] = key.split('|');
  return validDateKey(date) && isUsageLedgerProviderId(provider) && modelParts.join('|').length > 0;
}

function validMonthlyModelKey(key: string): boolean {
  const [month, provider, ...modelParts] = key.split('|');
  return validMonthKey(month) && isUsageLedgerProviderId(provider) && modelParts.join('|').length > 0;
}

function validDailyBreakdownKey(key: string): boolean {
  const parts = key.split('|');
  return parts.length === 2 && validDateKey(parts[0]) && isUsageLedgerProviderId(parts[1]);
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

function normalizeAggregateRecord(
  value: unknown,
  keyValidator?: (key: string) => boolean,
): Record<string, UsageAggregate> {
  const normalized: Record<string, UsageAggregate> = {};
  for (const [key, aggregate] of Object.entries(objectRecord<unknown>(value))) {
    const next = normalizeAggregate(aggregate);
    if (next && keyValidator && !keyValidator(key)) throw new Error(`dirty aggregate key ${key}`);
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

function normalizeBreakdownDelta(value: unknown): BreakdownDelta | null {
  const raw = objectRecord<unknown>(value);
  const delta = {} as BreakdownDelta;
  for (const key of BREAKDOWN_KEYS) {
    const next = finiteNumber(raw[key]);
    if (next == null || next < 0) return null;
    delta[key] = next;
  }
  return delta;
}

function normalizeDailyBreakdownRecord(value: unknown): Record<string, DailyBreakdownRow> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, DailyBreakdownRow> = {};
  for (const [key, rowValue] of Object.entries(value as Record<string, unknown>)) {
    if (!validDailyBreakdownKey(key)) throw new Error(`dirty dailyBreakdown key ${key}`);
    const raw = objectRecord<unknown>(rowValue);
    const delta = normalizeBreakdownDelta(raw);
    if (!delta) throw new Error(`dirty dailyBreakdown row ${key}`);
    if (typeof raw.firstSeenDate !== 'string' || !DATE_KEY_RE.test(raw.firstSeenDate)) {
      throw new Error(`dirty firstSeenDate ${key}`);
    }
    normalized[key] = { ...delta, firstSeenDate: raw.firstSeenDate };
  }
  return normalized;
}

function normalizeRecentBreakdownIndex(value: unknown): UsageLedgerSnapshot['recentBreakdownIndex'] {
  const normalized: UsageLedgerSnapshot['recentBreakdownIndex'] = {};
  for (const [key, entry] of Object.entries(objectRecord<unknown>(value))) {
    const raw = objectRecord<unknown>(entry);
    const delta = normalizeBreakdownDelta(raw.delta);
    if (!delta) throw new Error(`dirty recentBreakdownIndex delta ${key}`);
    if (typeof raw.dailyBreakdownKey !== 'string' || !validDailyBreakdownKey(raw.dailyBreakdownKey)) {
      throw new Error(`dirty recentBreakdownIndex key ${key}`);
    }
    normalized[key] = { dailyBreakdownKey: raw.dailyBreakdownKey, delta };
  }
  return normalized;
}

function normalizeSourceCheckpointRecord(value: unknown): Record<string, SourceCheckpoint> {
  const normalized: Record<string, SourceCheckpoint> = {};
  for (const [key, checkpoint] of Object.entries(objectRecord<unknown>(value))) {
    const raw = objectRecord<unknown>(checkpoint);
    if (!isProviderId(raw.provider)) continue;
    if (typeof raw.sourceHash !== 'string') continue;
    const size = finiteNumber(raw.size);
    const mtimeMs = finiteNumber(raw.mtimeMs);
    const byteOffset = finiteNumber(raw.byteOffset);
    const lastImportedAt = finiteNumber(raw.lastImportedAt);
    if (lastImportedAt == null) continue;
    normalized[key] = {
      provider: raw.provider,
      sourceHash: raw.sourceHash,
      lastImportedAt,
      ...(typeof raw.sourceKey === 'string' ? { sourceKey: raw.sourceKey } : {}),
      ...(size == null ? {} : { size }),
      ...(mtimeMs == null ? {} : { mtimeMs }),
      ...(byteOffset == null ? {} : { byteOffset }),
      ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
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
  try {
    if (raw.breakdownStartedDate !== null && raw.breakdownStartedDate !== undefined
      && (typeof raw.breakdownStartedDate !== 'string' || !DATE_KEY_RE.test(raw.breakdownStartedDate))) {
      throw new Error('dirty breakdownStartedDate');
    }

    return {
      schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
      minuteRecent: normalizeAggregateRecord(raw.minuteRecent),
      recentRequestIndex: normalizeRecentRequestIndex(raw.recentRequestIndex),
      hourlyActivity: normalizeAggregateRecord(raw.hourlyActivity),
      dailyModel: normalizeAggregateRecord(raw.dailyModel, validDailyModelKey),
      monthlyModel: normalizeAggregateRecord(raw.monthlyModel, validMonthlyModelKey),
      dailyBreakdown: normalizeDailyBreakdownRecord(raw.dailyBreakdown),
      recentBreakdownIndex: normalizeRecentBreakdownIndex(raw.recentBreakdownIndex),
      breakdownStartedDate: raw.breakdownStartedDate ?? null,
      sourceCheckpoints: normalizeSourceCheckpointRecord(raw.sourceCheckpoints),
      sourceRepairRollup: normalizeAggregateRecord(raw.sourceRepairRollup),
      lastCompactedAt: typeof raw.lastCompactedAt === 'number' ? raw.lastCompactedAt : 0,
      lastFullImportAt: typeof raw.lastFullImportAt === 'number' && Number.isFinite(raw.lastFullImportAt) ? raw.lastFullImportAt : 0,
    };
  } catch {
    // Persisted dirty breakdown state follows the same load-time hard-cut policy as schema mismatches.
    return emptyUsageLedgerSnapshot();
  }
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
