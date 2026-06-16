import type { ProviderId } from './providers/types';
import {
  DAILY_BREAKDOWN_RETENTION_MS,
  DAILY_MODEL_RETENTION_MS,
  DailyBreakdownRow,
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
  emptyDailyBreakdownRow,
  emptyUsageAggregate,
  hourProviderKey,
  hourSourceModelKey,
  localDateKey,
  minuteKey,
  monthModelKey,
  subtractUsageAggregate,
} from './usageLedgerAggregates';
import { BREAKDOWN_KEYS, type BreakdownDelta } from '../shared/breakdownTypes';

export type { BreakdownDelta };

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
  breakdown?: BreakdownDelta;
  /**
   * R2-001: when false, only `breakdown` is applied. No usage aggregate
   * maps or recentRequestIndex are written.
   */
  countsAsUsage?: boolean;
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

export interface UsageLedgerProviderSlice {
  provider: ProviderId;
  minuteRecent: Record<string, UsageAggregate>;
  recentRequestIndex: UsageLedgerSnapshot['recentRequestIndex'];
  hourlyActivity: Record<string, UsageAggregate>;
  dailyModel: Record<string, UsageAggregate>;
  monthlyModel: Record<string, UsageAggregate>;
  dailyBreakdown: Record<string, DailyBreakdownRow>;
  sourceCheckpoints: UsageLedgerSnapshot['sourceCheckpoints'];
  sourceRepairRollup: Record<string, UsageAggregate>;
}

function cooperativeYield(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function cloneAggregate(aggregate: UsageAggregate): UsageAggregate {
  return { ...aggregate };
}

function cloneDailyBreakdownRow(row: DailyBreakdownRow): DailyBreakdownRow {
  return { ...row };
}

function cloneBreakdownDelta(delta: BreakdownDelta): BreakdownDelta {
  return { ...delta };
}

export function cloneUsageLedgerSnapshot(snapshot: UsageLedgerSnapshot): UsageLedgerSnapshot {
  return {
    ...snapshot,
    minuteRecent: Object.fromEntries(Object.entries(snapshot.minuteRecent).map(([key, value]) => [key, cloneAggregate(value)])),
    recentRequestIndex: Object.fromEntries(Object.entries(snapshot.recentRequestIndex).map(([key, value]) => [key, { ...value, aggregate: cloneAggregate(value.aggregate) }])),
    hourlyActivity: Object.fromEntries(Object.entries(snapshot.hourlyActivity).map(([key, value]) => [key, cloneAggregate(value)])),
    dailyModel: Object.fromEntries(Object.entries(snapshot.dailyModel).map(([key, value]) => [key, cloneAggregate(value)])),
    monthlyModel: Object.fromEntries(Object.entries(snapshot.monthlyModel).map(([key, value]) => [key, cloneAggregate(value)])),
    dailyBreakdown: Object.fromEntries(Object.entries(snapshot.dailyBreakdown).map(([key, value]) => [key, cloneDailyBreakdownRow(value)])),
    recentBreakdownIndex: Object.fromEntries(Object.entries(snapshot.recentBreakdownIndex).map(([key, value]) => [key, {
      ...value,
      delta: cloneBreakdownDelta(value.delta),
    }])),
    breakdownStartedDate: snapshot.breakdownStartedDate,
    sourceCheckpoints: Object.fromEntries(Object.entries(snapshot.sourceCheckpoints).map(([key, value]) => [key, { ...value }])),
    sourceRepairRollup: Object.fromEntries(Object.entries(snapshot.sourceRepairRollup).map(([key, value]) => [key, cloneAggregate(value)])),
  };
}

function cloneAggregateRecord(record: Record<string, UsageAggregate>): Record<string, UsageAggregate> {
  return Object.fromEntries(Object.entries(record).map(([key, aggregate]) => [key, cloneAggregate(aggregate)]));
}

function providerFromPipeKey(key: string, providerIndex: number): ProviderId | null {
  const parts = key.split('|');
  const provider = parts[providerIndex];
  return provider === 'claude' || provider === 'codex' || provider === 'antigravity' ? provider : null;
}

function withoutProviderAggregateRows(
  record: Record<string, UsageAggregate>,
  provider: ProviderId,
  providerIndex: number,
): Record<string, UsageAggregate> {
  const next: Record<string, UsageAggregate> = {};
  for (const [key, aggregate] of Object.entries(record)) {
    if (providerFromPipeKey(key, providerIndex) !== provider) next[key] = cloneAggregate(aggregate);
  }
  return next;
}

function withoutProviderRecentRequests(
  record: UsageLedgerSnapshot['recentRequestIndex'],
  provider: ProviderId,
): UsageLedgerSnapshot['recentRequestIndex'] {
  const next: UsageLedgerSnapshot['recentRequestIndex'] = {};
  for (const [key, entry] of Object.entries(record)) {
    if (providerFromPipeKey(entry.minuteKey, 1) !== provider) {
      next[key] = { ...entry, aggregate: cloneAggregate(entry.aggregate) };
    }
  }
  return next;
}

function withoutProviderRecentBreakdowns(
  record: UsageLedgerSnapshot['recentBreakdownIndex'],
  provider: ProviderId,
): UsageLedgerSnapshot['recentBreakdownIndex'] {
  const next: UsageLedgerSnapshot['recentBreakdownIndex'] = {};
  for (const [key, entry] of Object.entries(record)) {
    if (providerFromPipeKey(entry.dailyBreakdownKey, 1) !== provider) {
      next[key] = { ...entry, delta: cloneBreakdownDelta(entry.delta) };
    }
  }
  return next;
}

function withoutProviderBreakdownRows(
  record: Record<string, DailyBreakdownRow>,
  provider: ProviderId,
): Record<string, DailyBreakdownRow> {
  const next: Record<string, DailyBreakdownRow> = {};
  for (const [key, row] of Object.entries(record)) {
    if (providerFromPipeKey(key, 1) !== provider) next[key] = cloneDailyBreakdownRow(row);
  }
  return next;
}

function withoutProviderCheckpoints(
  record: UsageLedgerSnapshot['sourceCheckpoints'],
  provider: ProviderId,
): UsageLedgerSnapshot['sourceCheckpoints'] {
  const next: UsageLedgerSnapshot['sourceCheckpoints'] = {};
  for (const [key, checkpoint] of Object.entries(record)) {
    if (checkpoint.provider !== provider) next[key] = { ...checkpoint };
  }
  return next;
}

export function replaceProviderUsageSliceInSnapshot(
  snapshot: UsageLedgerSnapshot,
  slice: UsageLedgerProviderSlice,
  nowMs = Date.now(),
): UsageLedgerSnapshot {
  const next = cloneUsageLedgerSnapshot(snapshot);
  const breakdownBoundary = ensureBreakdownBoundary(next, nowMs);
  next.minuteRecent = {
    ...withoutProviderAggregateRows(snapshot.minuteRecent, slice.provider, 1),
    ...cloneAggregateRecord(slice.minuteRecent),
  };
  next.recentRequestIndex = {
    ...withoutProviderRecentRequests(snapshot.recentRequestIndex, slice.provider),
    ...Object.fromEntries(Object.entries(slice.recentRequestIndex).map(([key, entry]) => [key, {
      ...entry,
      aggregate: cloneAggregate(entry.aggregate),
    }])),
  };
  next.recentBreakdownIndex = withoutProviderRecentBreakdowns(snapshot.recentBreakdownIndex, slice.provider);
  next.hourlyActivity = {
    ...withoutProviderAggregateRows(snapshot.hourlyActivity, slice.provider, 1),
    ...cloneAggregateRecord(slice.hourlyActivity),
  };
  next.dailyModel = {
    ...withoutProviderAggregateRows(snapshot.dailyModel, slice.provider, 1),
    ...cloneAggregateRecord(slice.dailyModel),
  };
  next.monthlyModel = {
    ...withoutProviderAggregateRows(snapshot.monthlyModel, slice.provider, 1),
    ...cloneAggregateRecord(slice.monthlyModel),
  };
  next.dailyBreakdown = {
    ...withoutProviderBreakdownRows(snapshot.dailyBreakdown, slice.provider),
    ...Object.fromEntries(
      Object.entries(slice.dailyBreakdown)
        .filter(([key]) => key.slice(0, key.indexOf('|')) >= breakdownBoundary)
        .map(([key, row]) => [key, cloneDailyBreakdownRow(row)]),
    ),
  };
  next.sourceCheckpoints = {
    ...withoutProviderCheckpoints(snapshot.sourceCheckpoints, slice.provider),
    ...Object.fromEntries(Object.entries(slice.sourceCheckpoints).map(([key, checkpoint]) => [key, { ...checkpoint }])),
  };
  next.sourceRepairRollup = {
    ...withoutProviderAggregateRows(snapshot.sourceRepairRollup, slice.provider, 2),
    ...cloneAggregateRecord(slice.sourceRepairRollup),
  };
  return next;
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

function applyBreakdownDelta(row: DailyBreakdownRow, delta: BreakdownDelta, sign: 1 | -1): void {
  for (const key of BREAKDOWN_KEYS) row[key] += sign * delta[key];
}

function isEmptyBreakdownRow(row: DailyBreakdownRow): boolean {
  return BREAKDOWN_KEYS.every(key => row[key] === 0);
}

function subtractBreakdownIndexEntry(
  snapshot: UsageLedgerSnapshot,
  requestIndexKey: string,
): void {
  const breakdown = snapshot.recentBreakdownIndex[requestIndexKey];
  if (!breakdown) return;
  const row = snapshot.dailyBreakdown[breakdown.dailyBreakdownKey];
  if (row) {
    applyBreakdownDelta(row, breakdown.delta, -1);
    if (isEmptyBreakdownRow(row)) delete snapshot.dailyBreakdown[breakdown.dailyBreakdownKey];
  }
  delete snapshot.recentBreakdownIndex[requestIndexKey];
}

function accumulateBreakdown(
  next: UsageLedgerSnapshot,
  provider: ProviderId,
  requestIndexKey: string,
  entry: UsageLedgerIngestUsageEntry,
  nowMs: number,
): void {
  // Idempotent latest-wins: reverse any prior delta for this request before re-adding,
  // independent of recentRequestIndex lifetime. recentBreakdownIndex follows the daily
  // (breakdown) retention while recentRequestIndex follows the shorter minute retention,
  // so a re-emit of an entry older than the minute window must still subtract here or it
  // would double-count dailyBreakdown.
  subtractBreakdownIndexEntry(next, requestIndexKey);
  if (!entry.breakdown) return;
  if (entry.timestampMs < nowMs - DAILY_BREAKDOWN_RETENTION_MS) return;
  const date = localDateKey(entry.timestampMs);
  const key = `${date}|${provider}`;
  const row = next.dailyBreakdown[key] ?? emptyDailyBreakdownRow(date);
  applyBreakdownDelta(row, entry.breakdown, 1);
  if (date < row.firstSeenDate) row.firstSeenDate = date;
  next.dailyBreakdown[key] = row;
  next.recentBreakdownIndex[requestIndexKey] = {
    dailyBreakdownKey: key,
    delta: cloneBreakdownDelta(entry.breakdown),
  };
}

function parseMinuteLedgerKey(key: string): { timestampMs: number; provider: UsageLedgerProvider; model: string } | null {
  const [timestampRaw, providerRaw, ...modelParts] = key.split('|');
  const timestampMs = Number(timestampRaw);
  const model = modelParts.join('|');
  if (!Number.isFinite(timestampMs) || !isUsageLedgerProvider(providerRaw) || !model) return null;
  return { timestampMs, provider: providerRaw, model };
}

function sameAggregate(a: UsageAggregate, b: UsageAggregate): boolean {
  return a.requestCount === b.requestCount
    && a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheCreationTokens === b.cacheCreationTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.totalTokens === b.totalTokens
    && a.costUSD === b.costUSD
    && a.cacheSavingsUSD === b.cacheSavingsUSD;
}

function shouldKeepExistingRecentRequest(
  existing: UsageLedgerSnapshot['recentRequestIndex'][string],
  sourceEntry: UsageLedgerIngestEntry,
): boolean {
  if (existing.aggregate.outputTokens > sourceEntry.aggregate.outputTokens) return true;
  const existingRow = parseMinuteLedgerKey(existing.minuteKey);
  return !!existingRow
    && existingRow.model === sourceEntry.entry.model
    && sameAggregate(existing.aggregate, sourceEntry.aggregate);
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
  subtractBreakdownIndexEntry(snapshot, requestIndexKey);
}

function filterEntriesAfterCursor(
  snapshot: UsageLedgerSnapshot,
  source: UsageLedgerIngestSource,
  entries: UsageLedgerIngestEntry[],
): { entries: UsageLedgerIngestEntry[]; missingCursor: boolean } {
  const currentCursor = snapshot.sourceCheckpoints[source.sourceHash]?.cursor;
  if (!currentCursor || !source.cursor) return { entries, missingCursor: false };

  const cursorIndex = entries.findIndex(sourceEntry => sourceEntry.entry.requestId === currentCursor);
  if (cursorIndex >= 0) return { entries: entries.slice(cursorIndex + 1), missingCursor: false };
  if (currentCursor === source.cursor) return { entries: [], missingCursor: false };
  return { entries: [], missingCursor: true };
}

function addEntryToSnapshot(next: UsageLedgerSnapshot, sourceHash: string, sourceEntry: UsageLedgerIngestEntry, nowMs: number): void {
  const { entry, aggregate } = sourceEntry;
  const provider = entry.provider;
  const requestIndexKey = `${sourceHash}|${entry.requestId}`;

  if (entry.countsAsUsage === false) {
    // accumulateBreakdown reverses any prior delta first (idempotent), so a re-scan of the
    // same breakdown-only event replaces rather than doubles.
    accumulateBreakdown(next, provider, requestIndexKey, entry, nowMs);
    return;
  }

  const existing = next.recentRequestIndex[requestIndexKey];
  if (existing) {
    if (shouldKeepExistingRecentRequest(existing, sourceEntry)) return;
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

  accumulateBreakdown(next, provider, requestIndexKey, entry, nowMs);
}

export function ensureBreakdownBoundary(snapshot: UsageLedgerSnapshot, nowMs: number): string {
  if (snapshot.breakdownStartedDate === null) snapshot.breakdownStartedDate = localDateKey(nowMs);
  return snapshot.breakdownStartedDate;
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
  ensureBreakdownBoundary(next, nowMs);
  const filtered = filterEntriesAfterCursor(snapshot, source, entries);
  if (filtered.missingCursor) {
    const currentCheckpoint = snapshot.sourceCheckpoints[source.sourceHash];
    next.sourceCheckpoints[source.sourceHash] = {
      provider: source.provider,
      sourceHash: source.sourceHash,
      lastImportedAt: nowMs,
      hasUsage: currentCheckpoint?.hasUsage ?? entries.length > 0,
      needsRebuild: true,
      rebuildReason: 'source cursor missing from generic provider source',
      ...(source.sourceKey ? { sourceKey: source.sourceKey } : (currentCheckpoint?.sourceKey ? { sourceKey: currentCheckpoint.sourceKey } : {})),
      ...(source.cursor ? { cursor: source.cursor } : (currentCheckpoint?.cursor ? { cursor: currentCheckpoint.cursor } : {})),
      ...(source.rawModel ? { rawModel: source.rawModel } : (currentCheckpoint?.rawModel ? { rawModel: currentCheckpoint.rawModel } : {})),
    };
    return next;
  }

  let processedEntries = 0;
  for (const entry of filtered.entries) {
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
