import {
  DAILY_MODEL_RETENTION_MS,
  HOURLY_ACTIVITY_RETENTION_MS,
  MINUTE_RECENT_RETENTION_MS,
  RECENT_REQUEST_INDEX_RETENTION_MS,
  SOURCE_REPAIR_RETENTION_MS,
  USAGE_LEDGER_SCHEMA_VERSION,
  UsageAggregate,
  UsageLedgerSnapshot,
  UsageLedgerProvider,
} from './usageLedgerTypes';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function emptyUsageAggregate(): UsageAggregate {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    cacheSavingsUSD: 0,
  };
}

export function emptyUsageLedgerSnapshot(): UsageLedgerSnapshot {
  return {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: {},
    recentRequestIndex: {},
    hourlyActivity: {},
    dailyModel: {},
    monthlyModel: {},
    sourceCheckpoints: {},
    sourceRepairRollup: {},
    lastCompactedAt: 0,
  };
}

export function addUsageAggregate(target: UsageAggregate, delta: UsageAggregate): void {
  target.requestCount += delta.requestCount;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.totalTokens += delta.totalTokens;
  target.costUSD += delta.costUSD;
  target.cacheSavingsUSD += delta.cacheSavingsUSD;
}

export function subtractUsageAggregate(target: UsageAggregate, delta: UsageAggregate): void {
  target.requestCount -= delta.requestCount;
  target.inputTokens -= delta.inputTokens;
  target.outputTokens -= delta.outputTokens;
  target.cacheCreationTokens -= delta.cacheCreationTokens;
  target.cacheReadTokens -= delta.cacheReadTokens;
  target.totalTokens -= delta.totalTokens;
  target.costUSD -= delta.costUSD;
  target.cacheSavingsUSD -= delta.cacheSavingsUSD;
}

export function aggregateFromParts(parts: Omit<UsageAggregate, 'requestCount' | 'totalTokens'>): UsageAggregate {
  return {
    requestCount: 1,
    inputTokens: parts.inputTokens,
    outputTokens: parts.outputTokens,
    cacheCreationTokens: parts.cacheCreationTokens,
    cacheReadTokens: parts.cacheReadTokens,
    totalTokens: parts.inputTokens + parts.outputTokens + parts.cacheCreationTokens + parts.cacheReadTokens,
    costUSD: parts.costUSD,
    cacheSavingsUSD: parts.cacheSavingsUSD,
  };
}

export function minuteKey(timestampMs: number, provider: UsageLedgerProvider, model: string): string {
  return `${timestampMs - (timestampMs % MINUTE_MS)}|${provider}|${model}`;
}

export function hourProviderKey(timestampMs: number, provider: UsageLedgerProvider): string {
  return `${timestampMs - (timestampMs % HOUR_MS)}|${provider}`;
}

export function hourSourceModelKey(sourceHash: string, timestampMs: number, provider: UsageLedgerProvider, model: string): string {
  return `${sourceHash}|${timestampMs - (timestampMs % HOUR_MS)}|${provider}|${model}`;
}

export function dayModelKey(dateOrTimestamp: string | number, provider: UsageLedgerProvider, model: string): string {
  const date = typeof dateOrTimestamp === 'number' ? localDateKey(dateOrTimestamp) : dateOrTimestamp;
  return `${date}|${provider}|${model}`;
}

export function monthModelKey(dateOrTimestamp: string | number, provider: UsageLedgerProvider, model: string): string {
  const date = typeof dateOrTimestamp === 'number' ? localDateKey(dateOrTimestamp) : dateOrTimestamp;
  return `${date.slice(0, 7)}|${provider}|${model}`;
}

export function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseLeadingTimestamp(key: string): number {
  const first = key.split('|', 1)[0];
  const numeric = Number(first);
  return Number.isFinite(numeric) ? numeric : Date.parse(`${first}T00:00:00`);
}

function keepByTimestamp<T>(entries: Record<string, T>, cutoffMs: number): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    const timestampMs = parseLeadingTimestamp(key);
    if (Number.isFinite(timestampMs) && timestampMs >= cutoffMs) next[key] = value;
  }
  return next;
}

export function compactUsageLedgerSnapshot(snapshot: UsageLedgerSnapshot, nowMs = Date.now()): UsageLedgerSnapshot {
  const sourceRepair: Record<string, UsageAggregate> = {};
  const sourceRepairCutoff = nowMs - SOURCE_REPAIR_RETENTION_MS;
  for (const [key, value] of Object.entries(snapshot.sourceRepairRollup)) {
    const [, hourStart] = key.split('|');
    if (Number(hourStart) >= sourceRepairCutoff) sourceRepair[key] = value;
  }

  const recentIndex: UsageLedgerSnapshot['recentRequestIndex'] = {};
  const indexCutoff = nowMs - RECENT_REQUEST_INDEX_RETENTION_MS;
  for (const [key, value] of Object.entries(snapshot.recentRequestIndex)) {
    if (value.lastSeenMs >= indexCutoff) recentIndex[key] = value;
  }

  return {
    ...snapshot,
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    minuteRecent: keepByTimestamp(snapshot.minuteRecent, nowMs - MINUTE_RECENT_RETENTION_MS),
    recentRequestIndex: recentIndex,
    hourlyActivity: keepByTimestamp(snapshot.hourlyActivity, nowMs - HOURLY_ACTIVITY_RETENTION_MS),
    dailyModel: keepByTimestamp(snapshot.dailyModel, nowMs - DAILY_MODEL_RETENTION_MS),
    sourceRepairRollup: sourceRepair,
    lastCompactedAt: nowMs,
  };
}
