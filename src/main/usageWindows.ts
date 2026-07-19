import type { UsageProvider } from './jsonlTypes';
import type { ProviderId } from '../shared/quotaTypes';

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

export interface ProviderFixedPeriodUsage {
  periods: Partial<Record<'5h', WindowStats>>;
}

export interface UsageData {
  fixedPeriodByProvider: Partial<Record<ProviderId, ProviderFixedPeriodUsage>>;
  entryStats: Record<string, WindowStats>;
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
