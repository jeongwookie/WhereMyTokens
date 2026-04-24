export type UsageProvider = 'claude' | 'codex' | 'other';

export interface CompactRecentEntry {
  requestId: string;
  timestampMs: number;
  model: string;
  provider: UsageProvider;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

export interface CodexRateLimitWindow {
  pct: number;
  resetsAt: number;
  observedAt: number;
}

export interface ActivityBreakdown {
  read: number;
  editWrite: number;
  search: number;
  git: number;
  buildTest: number;
  terminal: number;
  thinking: number;
  response: number;
  subagents: number;
  web: number;
}

export type ActivityBreakdownKind = 'tokens' | 'events';

export interface SessionSnapshot {
  modelName: string;
  rawModel: string;
  latestInputTokens: number;
  latestCacheCreationTokens: number;
  latestCacheReadTokens: number;
  contextMax?: number;
  codexRateLimits?: {
    h5?: CodexRateLimitWindow;
    week?: CodexRateLimitWindow;
  };
  toolCounts: Record<string, number>;
  activityBreakdown: ActivityBreakdown;
  activityBreakdownKind: ActivityBreakdownKind;
}

export interface HistoricalAggregate {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

export interface HistoricalBucket extends HistoricalAggregate {
  timestampMs: number;
}

export interface HistoricalModelTotal {
  model: string;
  provider: UsageProvider;
  tokens: number;
  costUSD: number;
}

export interface HistoricalRollup {
  aggregate: HistoricalAggregate;
  modelTotals: Record<string, HistoricalModelTotal>;
  hourlyBuckets: Record<string, HistoricalBucket>;
}

export interface RequestIndexEntry extends CompactRecentEntry {
  region: 'recent' | 'historical';
}

export interface FileUsageSummary {
  provider: 'claude' | 'codex';
  sessionSnapshot: SessionSnapshot;
  recentEntries: CompactRecentEntry[];
  historicalRollup: HistoricalRollup;
  byteOffset: number;
  pendingText?: string;
  pendingBytes?: number;
  requestIndex?: Record<string, RequestIndexEntry>;
  mtimeMs: number;
  size: number;
  lastAccessedAt: number;
  rehydratedFromPersistence?: boolean;
}

export function emptyActivityBreakdown(): ActivityBreakdown {
  return {
    read: 0,
    editWrite: 0,
    search: 0,
    git: 0,
    buildTest: 0,
    terminal: 0,
    thinking: 0,
    response: 0,
    subagents: 0,
    web: 0,
  };
}

export function emptyHistoricalAggregate(): HistoricalAggregate {
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

export function emptyHistoricalRollup(): HistoricalRollup {
  return {
    aggregate: emptyHistoricalAggregate(),
    modelTotals: {},
    hourlyBuckets: {},
  };
}

export function emptySessionSnapshot(kind: ActivityBreakdownKind = 'tokens'): SessionSnapshot {
  return {
    modelName: '',
    rawModel: '',
    latestInputTokens: 0,
    latestCacheCreationTokens: 0,
    latestCacheReadTokens: 0,
    toolCounts: {},
    activityBreakdown: emptyActivityBreakdown(),
    activityBreakdownKind: kind,
  };
}
