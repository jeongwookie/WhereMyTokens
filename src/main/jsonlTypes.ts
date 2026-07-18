import type { ProviderId, QuotaEntry } from '../shared/quotaTypes';

export type UsageProvider = ProviderId | 'other';

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
    capturedAt: number;
    position: number;
    sourceId: string;
    entries: QuotaEntry[];
  };
  toolCounts: Record<string, number>;
  activityBreakdown: ActivityBreakdown;
  activityBreakdownKind: ActivityBreakdownKind;
}

export interface FileUsageSummary {
  provider: ProviderId;
  projectKeys?: string[];
  sessionSnapshot: SessionSnapshot;
  mtimeMs: number;
  size: number;
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
