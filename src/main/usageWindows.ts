import type { UsageProvider } from './jsonlTypes';
import type { ProviderId } from './providers/types';
import type { ProviderWindowResetHintMap } from './usageWindowTargets';

export interface WindowStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  requestCount: number;
  cacheEfficiency: number;
  cacheSavingsUSD: number;
}

export interface ModelUsage {
  model: string;
  provider: UsageProvider;
  tokens: number;
  costUSD: number;
}

export interface HourlyBucket {
  dayIndex: number;
  hour: number;
  tokens: number;
}

export interface WeeklyTotal {
  weekIndex: number;
  weekLabel: string;
  tokens: number;
  costUSD: number;
}

export interface TimeOfDayBucket {
  period: 'morning' | 'afternoon' | 'evening' | 'night';
  label: string;
  tokens: number;
  costUSD: number;
  requestCount: number;
}

export interface ProviderWindowUsage {
  windows: Record<string, WindowStats>;
}

export interface ProviderModelWindowUsage {
  windows: Record<string, Record<string, WindowStats>>;
}

export interface UsageData {
  byProvider: Partial<Record<ProviderId, ProviderWindowUsage>>;
  modelWindows: Partial<Record<ProviderId, ProviderModelWindowUsage>>;
  models: ModelUsage[];
  heatmap: HourlyBucket[];
  heatmap30: HourlyBucket[];
  heatmap90: HourlyBucket[];
  weeklyTimeline: WeeklyTotal[];
  todayTokens: number;
  todayCost: number;
  todayRequestCount: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCacheTokens: number;
  todayCacheSavingsUSD: number;
  todayCacheEfficiency: number;
  allTimeRequestCount: number;
  allTimeCost: number;
  allTimeCacheTokens: number;
  allTimeInputTokens: number;
  allTimeOutputTokens: number;
  allTimeSavedUSD: number;
  allTimeAvgCacheEfficiency: number;
  todBuckets: TimeOfDayBucket[];
}

export type UsageWindowResetHints = ProviderWindowResetHintMap;
