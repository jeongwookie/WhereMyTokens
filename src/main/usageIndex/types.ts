import type { BreakdownDelta } from '../../shared/breakdownTypes';
import type { ProviderId } from '../../shared/quotaTypes';

export type UsageSourceKind = 'file' | 'remote';
export type UsageScanMode = 'tail' | 'rebuild';
export type UsageRefreshStatus = 'unchanged' | 'tailed' | 'rebuilt';

export interface UsageMetrics {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

export interface UsageSourceVersion {
  /** Opaque provider-owned version token. Equal tokens mean equal payload. */
  token: string;
  size?: number;
  mtimeMs?: number;
}

export interface UsageSourceDescriptor {
  sourceId: string;
  provider: ProviderId;
  kind: UsageSourceKind;
  parserVersion: number;
  version: UsageSourceVersion;
  /** Omit when discovery can identify the source version without reading payload bytes. */
  projectKeys?: readonly string[];
}

export interface UsageSourceCheckpoint {
  byteOffset?: number;
  cursor?: string;
  resumeState?: string;
  rawModel?: string;
}

export interface UsageEntry {
  requestId: string;
  timestampMs: number;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
  breakdown?: BreakdownDelta;
}

export interface UsageEntryProjection {
  count: number;
  providers: ProviderId[];
  models: string[];
  providerIndexes: Uint32Array<ArrayBufferLike>;
  timestampMs: Float64Array<ArrayBufferLike>;
  modelIndexes: Uint32Array<ArrayBufferLike>;
  inputTokens: Float64Array<ArrayBufferLike>;
  outputTokens: Float64Array<ArrayBufferLike>;
  cacheCreationTokens: Float64Array<ArrayBufferLike>;
  cacheReadTokens: Float64Array<ArrayBufferLike>;
  costUSD: Float64Array<ArrayBufferLike>;
  cacheSavingsUSD: Float64Array<ArrayBufferLike>;
}

export interface UsageSessionProjection {
  sourceId: string;
  provider: ProviderId;
  updatedAt: number;
  byteSize: number;
  payload: Record<string, unknown>;
}

export type UsageRebuildCoverage =
  | { kind: 'full' }
  | { kind: 'range'; fromMs: number; toMs: number }
  | { kind: 'none' };

export interface UsageSourceBatch {
  checkpoint: UsageSourceCheckpoint;
  entries: readonly UsageEntry[];
  /** Fresh source attribution discovered by the scanner in the same payload pass. */
  projectKeys?: readonly string[];
  rebuildCoverage?: UsageRebuildCoverage;
  providerMetadata?: Record<string, unknown>;
  sessionProjection?: UsageSessionProjection | null;
}

export interface UsageSourceScanPlan {
  mode: UsageScanMode;
  source: UsageSourceDescriptor;
  checkpoint: UsageSourceCheckpoint | null;
  previousSessionProjection: UsageSessionProjection | null;
}

export interface UsageSourceScanner {
  scan(plan: UsageSourceScanPlan): Promise<UsageSourceBatch>;
}

export interface UsageSourceRefreshResult {
  sourceId: string;
  status: UsageRefreshStatus;
  scannedEntries: number;
}

export interface UsageFilter {
  fromMs?: number;
  toMs?: number;
  excludedProjectKeys?: readonly string[];
  providers?: ReadonlySet<ProviderId>;
}

export type UsageQueryGrain = 'hour' | 'day' | 'month';

export interface UsageEntryQuery extends UsageFilter {}

export interface UsageQuery extends UsageFilter {
  grain: UsageQueryGrain;
}

export interface UsageModelTotal {
  provider: ProviderId;
  model: string;
  metrics: UsageMetrics;
}

export interface UsageTimeBucketTotal {
  bucketStartMs: number;
  metrics: UsageMetrics;
}

export interface UsageIndexCoverage {
  state: 'complete' | 'incomplete';
  requiredSourceCount: number;
  indexedSourceCount: number;
  pendingSourceCount: number;
  failedSourceCount: number;
}

export interface UsageIndexHealth {
  state: 'ready' | 'recovered' | 'unavailable';
  message?: string;
  preservedPath?: string;
}

export interface UsageQueryData {
  grain: UsageQueryGrain;
  aggregate: UsageMetrics;
  byProvider: Partial<Record<ProviderId, UsageMetrics>>;
  models: UsageModelTotal[];
  buckets: UsageTimeBucketTotal[];
}

export interface UsageQueryResult extends UsageQueryData {
  coverage: UsageIndexCoverage;
}

export interface UsageBreakdownQuery extends UsageQuery {}

export interface UsageTimeBucketBreakdown {
  bucketStartMs: number;
  breakdown: BreakdownDelta;
}

export interface UsageBreakdownData {
  grain: UsageQueryGrain;
  aggregate: BreakdownDelta;
  buckets: UsageTimeBucketBreakdown[];
}

export interface UsageBreakdownResult extends UsageBreakdownData {
  coverage: UsageIndexCoverage;
}

export interface StoredUsageSource {
  descriptor: UsageSourceDescriptor;
  checkpoint: UsageSourceCheckpoint;
  sealedBeforeMs?: number;
  providerMetadata?: Record<string, unknown>;
  sessionProjection?: UsageSessionProjection;
}

export interface UsageSourceCommit {
  mode: UsageScanMode;
  source: UsageSourceDescriptor;
  batch: UsageSourceBatch;
}

export interface UsageCompactionResult {
  deletedRequestRows: number;
  deletedHourBuckets: number;
  deletedDayBuckets: number;
}

export interface UsageIndexStorage {
  getSource(sourceId: string): Promise<StoredUsageSource | null>;
  updateSourceDescriptor(source: UsageSourceDescriptor): Promise<void>;
  commitSource(commit: UsageSourceCommit): Promise<void>;
  queryUsage(query: UsageQuery): Promise<UsageQueryData>;
  queryBreakdown(query: UsageBreakdownQuery): Promise<UsageBreakdownData>;
  queryEntries(query: UsageEntryQuery): Promise<UsageEntry[]>;
  queryEntryProjection(query: UsageEntryQuery): Promise<UsageEntryProjection>;
  readSessionProjections(sourceIds?: readonly string[]): Promise<UsageSessionProjection[]>;
  compact(nowMs: number): Promise<UsageCompactionResult>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface UsageIndex {
  getHealth(): UsageIndexHealth;
  declareSources(
    provider: ProviderId,
    sources: readonly UsageSourceDescriptor[],
    discoveryComplete: boolean,
  ): void;
  refreshSource(
    source: UsageSourceDescriptor,
    scanner: UsageSourceScanner,
  ): Promise<UsageSourceRefreshResult>;
  queryUsage(request: UsageQuery): Promise<UsageQueryResult>;
  queryBreakdown(request: UsageBreakdownQuery): Promise<UsageBreakdownResult>;
  readProjectionEntries(request: UsageEntryQuery): Promise<UsageEntry[]>;
  readProjectionEntryData(request: UsageEntryQuery): Promise<UsageEntryProjection>;
  readSessionProjections(sourceIds?: readonly string[]): Promise<UsageSessionProjection[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export function emptyUsageMetrics(): UsageMetrics {
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
