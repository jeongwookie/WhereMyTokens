import { UsageProvider } from './jsonlTypes';

export const USAGE_LEDGER_SCHEMA_VERSION = 2;
export const MINUTE_RECENT_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const RECENT_REQUEST_INDEX_RETENTION_MS = MINUTE_RECENT_RETENTION_MS;
export const HOURLY_ACTIVITY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const DAILY_MODEL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const SOURCE_REPAIR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface UsageAggregate {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

export interface RecentRequestIndexEntry {
  minuteKey: string;
  aggregate: UsageAggregate;
  lastSeenMs: number;
}

export interface SourceCheckpoint {
  provider: 'claude' | 'codex';
  sourceHash: string;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  lastImportedAt: number;
  hasUsage?: boolean;
  needsRebuild?: boolean;
  rebuildReason?: string;
  rawModel?: string;
}

export interface UsageLedgerSnapshot {
  schemaVersion: number;
  minuteRecent: Record<string, UsageAggregate>;
  recentRequestIndex: Record<string, RecentRequestIndexEntry>;
  hourlyActivity: Record<string, UsageAggregate>;
  dailyModel: Record<string, UsageAggregate>;
  monthlyModel: Record<string, UsageAggregate>;
  sourceCheckpoints: Record<string, SourceCheckpoint>;
  sourceRepairRollup: Record<string, UsageAggregate>;
  lastCompactedAt: number;
  lastFullImportAt?: number;
}

export interface UsageLedgerStoreShape {
  ledger: UsageLedgerSnapshot;
}

export type UsageLedgerProvider = UsageProvider;
