import { CompactRecentEntry, FileUsageSummary, UsageProvider } from './jsonlTypes';
import type { ProviderId, ProviderQuotaSnapshot } from './providers/types';
import {
  usageProviderVisible,
  type UsageVisibilityFilter,
} from './usageVisibilityFilter';
import {
  buildProviderWindowTargets,
  targetAcceptsModel,
  type ProviderWindowResetHintMap,
} from './usageWindowTargets';
import { cacheEfficiencyDenominator, cacheEfficiencyPct } from './cacheMetrics';

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

interface AggregateLike {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavingsUSD: number;
}

function emptyWindow(): WindowStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    requestCount: 0,
    cacheEfficiency: 0,
    cacheSavingsUSD: 0,
  };
}

function addAggregate(target: AggregateLike, entry: AggregateLike): void {
  target.requestCount += entry.requestCount;
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cacheCreationTokens += entry.cacheCreationTokens;
  target.cacheReadTokens += entry.cacheReadTokens;
  target.totalTokens += entry.totalTokens;
  target.costUSD += entry.costUSD;
  target.cacheSavingsUSD += entry.cacheSavingsUSD;
}

function addEntry(target: AggregateLike, entry: CompactRecentEntry): void {
  target.requestCount += 1;
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cacheCreationTokens += entry.cacheCreationTokens;
  target.cacheReadTokens += entry.cacheReadTokens;
  target.totalTokens += entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
  target.costUSD += entry.costUSD;
  target.cacheSavingsUSD += entry.cacheSavingsUSD;
}

function finalize(window: WindowStats, provider: UsageProvider): void {
  window.cacheEfficiency = cacheEfficiencyPct(provider, window);
}

function getWeekStart(timestampMs = Date.now()): Date {
  const date = new Date(timestampMs);
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(date);
  start.setDate(date.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function weekLabelFromStart(startMs: number): string {
  const date = new Date(startMs);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function modelMapKey(model: string, provider: ModelUsage['provider']): string {
  return `${provider}:${model}`;
}

function isProviderId(provider: UsageProvider): provider is ProviderId {
  return provider === 'claude' || provider === 'codex' || provider === 'antigravity';
}

export function computeUsage(
  summaries: FileUsageSummary[],
  resets: UsageWindowResetHints = {},
  visibilityFilter?: UsageVisibilityFilter,
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {},
): UsageData {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const weekMs = 7 * dayMs;

  const currentWeekStart = getWeekStart(now).getTime();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMidnight = todayStart.getTime();
  const day7Start = todayMidnight - 6 * dayMs;
  const day30Start = todayMidnight - 29 * dayMs;
  const day90Start = todayMidnight - 149 * dayMs;
  const timelineStart = currentWeekStart - 19 * weekMs;

  const providerIds = new Set<ProviderId>(summaries.map(summary => summary.provider).filter(isProviderId));
  const providerWindowTargets = buildProviderWindowTargets(providerIds, providerQuotas, resets, now, currentWeekStart);
  const providerWindows = new Map<ProviderId, ProviderWindowUsage>();
  const providerModelWindows = new Map<ProviderId, ProviderModelWindowUsage>();
  const modelMap = new Map<string, ModelUsage>();
  const heatMap7 = new Map<string, HourlyBucket>();
  const heatMap30 = new Map<string, HourlyBucket>();
  const heatMap90 = new Map<string, HourlyBucket>();
  const timelineMap = new Map<number, WeeklyTotal>();
  const allTime = emptyWindow();
  let todayTokens = 0;
  let todayCost = 0;
  let todayRequestCount = 0;
  let todayInputTokens = 0;
  let todayOutputTokens = 0;
  let todayCacheTokens = 0;
  let todayCacheReadTokens = 0;
  let todayCacheSavingsUSD = 0;
  let todayCacheDenominator = 0;
  let allTimeCacheDenominator = 0;

  const todMap: Record<TimeOfDayBucket['period'], TimeOfDayBucket> = {
    night: { period: 'night', label: 'Night (0-6h)', tokens: 0, costUSD: 0, requestCount: 0 },
    morning: { period: 'morning', label: 'Morning (6-12h)', tokens: 0, costUSD: 0, requestCount: 0 },
    afternoon: { period: 'afternoon', label: 'Afternoon (12-18h)', tokens: 0, costUSD: 0, requestCount: 0 },
    evening: { period: 'evening', label: 'Evening (18-24h)', tokens: 0, costUSD: 0, requestCount: 0 },
  };

  const addToHeatmap = (map: Map<string, HourlyBucket>, rangeStart: number, timestampMs: number, tokens: number) => {
    if (timestampMs < rangeStart) return;
    const dayIndex = Math.floor((timestampMs - rangeStart) / dayMs);
    const hour = new Date(timestampMs).getHours();
    const key = `${dayIndex}-${hour}`;
    const bucket = map.get(key);
    if (bucket) bucket.tokens += tokens;
    else map.set(key, { dayIndex, hour, tokens });
  };

  const addToTimeline = (timestampMs: number, tokens: number, costUSD: number) => {
    const rowWeekStart = getWeekStart(timestampMs).getTime();
    if (rowWeekStart < timelineStart || rowWeekStart > currentWeekStart) return;
    const weeksAgo = Math.round((currentWeekStart - rowWeekStart) / weekMs);
    const weekIndex = 19 - weeksAgo;
    const current = timelineMap.get(weekIndex);
    if (current) {
      current.tokens += tokens;
      current.costUSD += costUSD;
    } else {
      timelineMap.set(weekIndex, {
        weekIndex,
        weekLabel: weekLabelFromStart(rowWeekStart),
        tokens,
        costUSD,
      });
    }
  };

  const addToTod = (timestampMs: number, tokens: number, costUSD: number, requestCount: number) => {
    if (timestampMs < day30Start) return;
    const hour = new Date(timestampMs).getHours();
    const period = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    todMap[period].tokens += tokens;
    todMap[period].costUSD += costUSD;
    todMap[period].requestCount += requestCount;
  };

  const addModelTotal = (model: string, provider: ModelUsage['provider'], tokens: number, costUSD: number) => {
    const key = modelMapKey(model, provider);
    const modelUsage = modelMap.get(key) ?? { model, provider, tokens: 0, costUSD: 0 };
    modelUsage.tokens += tokens;
    modelUsage.costUSD += costUSD;
    modelMap.set(key, modelUsage);
  };

  const getProviderWindowUsage = (provider: ProviderId): ProviderWindowUsage => {
    const existing = providerWindows.get(provider);
    if (existing) return existing;
    const next = { windows: {} };
    providerWindows.set(provider, next);
    return next;
  };

  const getProviderModelWindowUsage = (provider: ProviderId): ProviderModelWindowUsage => {
    const existing = providerModelWindows.get(provider);
    if (existing) return existing;
    const next = { windows: {} };
    providerModelWindows.set(provider, next);
    return next;
  };

  const getProviderModelWindow = (provider: ProviderId, windowKey: string, model: string): WindowStats => {
    const usage = getProviderModelWindowUsage(provider);
    usage.windows[windowKey] ??= {};
    usage.windows[windowKey][model] ??= emptyWindow();
    return usage.windows[windowKey][model];
  };

  for (const [provider, targets] of providerWindowTargets) {
    const usage = getProviderWindowUsage(provider);
    for (const target of targets) {
      usage.windows[target.windowKey] ??= emptyWindow();
    }
  }

  const addProviderWindowEntry = (entry: CompactRecentEntry, timestampMs: number) => {
    if (!isProviderId(entry.provider)) return;
    const usage = getProviderWindowUsage(entry.provider);
    for (const target of providerWindowTargets.get(entry.provider) ?? []) {
      if (timestampMs < target.startMs) continue;
      if (!targetAcceptsModel(target, entry.model)) continue;
      usage.windows[target.windowKey] ??= emptyWindow();
      addEntry(usage.windows[target.windowKey], entry);
      addEntry(getProviderModelWindow(entry.provider, target.windowKey, entry.model), entry);
    }
  };

  const summaryProviderVisible = (summary: FileUsageSummary): boolean =>
    isProviderId(summary.provider) && usageProviderVisible(visibilityFilter, summary.provider);

  const entryVisible = (entry: CompactRecentEntry): boolean =>
    isProviderId(entry.provider) && usageProviderVisible(visibilityFilter, entry.provider);

  for (const summary of summaries) {
    const providerVisible = summaryProviderVisible(summary);
    if (providerVisible) {
      addAggregate(allTime, summary.historicalRollup.aggregate);
      if (Object.values(summary.historicalRollup.modelTotals).length > 0) {
        allTimeCacheDenominator += cacheEfficiencyDenominator(summary.provider, summary.historicalRollup.aggregate);
      }
    }

    for (const modelTotal of Object.values(summary.historicalRollup.modelTotals)) {
      if (!isProviderId(modelTotal.provider) || !usageProviderVisible(visibilityFilter, modelTotal.provider)) continue;
      addModelTotal(modelTotal.model, modelTotal.provider, modelTotal.tokens, modelTotal.costUSD);
    }

    if (providerVisible) {
      for (const bucket of Object.values(summary.historicalRollup.hourlyBuckets)) {
        addToHeatmap(heatMap30, day30Start, bucket.timestampMs, bucket.totalTokens);
        addToHeatmap(heatMap90, day90Start, bucket.timestampMs, bucket.totalTokens);
        addToTimeline(bucket.timestampMs, bucket.totalTokens, bucket.costUSD);
        addToTod(bucket.timestampMs, bucket.totalTokens, bucket.costUSD, bucket.requestCount);
      }
    }

    for (const entry of summary.recentEntries) {
      if (!entryVisible(entry)) continue;
      const ts = entry.timestampMs;
      const tokens = entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;

      addAggregate(allTime, {
        requestCount: 1,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
        totalTokens: tokens,
        costUSD: entry.costUSD,
        cacheSavingsUSD: entry.cacheSavingsUSD,
      });
      allTimeCacheDenominator += cacheEfficiencyDenominator(entry.provider, entry);

      addModelTotal(entry.model, entry.provider, tokens, entry.costUSD);
      addToHeatmap(heatMap7, day7Start, ts, tokens);
      addToHeatmap(heatMap30, day30Start, ts, tokens);
      addToHeatmap(heatMap90, day90Start, ts, tokens);
      addToTimeline(ts, tokens, entry.costUSD);
      addToTod(ts, tokens, entry.costUSD, 1);

      if (ts >= todayMidnight) {
        todayTokens += tokens;
        todayCost += entry.costUSD;
        todayRequestCount += 1;
        todayInputTokens += entry.inputTokens;
        todayOutputTokens += entry.outputTokens;
        todayCacheTokens += entry.cacheReadTokens + entry.cacheCreationTokens;
        todayCacheReadTokens += entry.cacheReadTokens;
        todayCacheSavingsUSD += entry.cacheSavingsUSD;
        todayCacheDenominator += cacheEfficiencyDenominator(entry.provider, entry);
      }

      addProviderWindowEntry(entry, ts);
    }
  }

  for (const [provider, usage] of providerWindows) {
    for (const window of Object.values(usage.windows)) finalize(window, provider);
  }
  for (const [provider, usage] of providerModelWindows) {
    for (const models of Object.values(usage.windows)) {
      for (const window of Object.values(models)) finalize(window, provider);
    }
  }

  const models = Array.from(modelMap.values())
    .filter(model => model.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const allTimeAvgCacheEfficiency = allTimeCacheDenominator > 0
    ? (allTime.cacheReadTokens / allTimeCacheDenominator) * 100
    : 0;
  const todayCacheEfficiency = todayCacheDenominator > 0
    ? (todayCacheReadTokens / todayCacheDenominator) * 100
    : 0;

  return {
    byProvider: Object.fromEntries(providerWindows),
    modelWindows: Object.fromEntries(providerModelWindows),
    models,
    heatmap: Array.from(heatMap7.values()),
    heatmap30: Array.from(heatMap30.values()),
    heatmap90: Array.from(heatMap90.values()),
    weeklyTimeline: Array.from(timelineMap.values()).sort((a, b) => a.weekIndex - b.weekIndex),
    todayTokens,
    todayCost,
    todayRequestCount,
    todayInputTokens,
    todayOutputTokens,
    todayCacheTokens,
    todayCacheSavingsUSD,
    todayCacheEfficiency,
    allTimeRequestCount: allTime.requestCount,
    allTimeCost: allTime.costUSD,
    allTimeCacheTokens: allTime.cacheReadTokens + allTime.cacheCreationTokens,
    allTimeInputTokens: allTime.inputTokens,
    allTimeOutputTokens: allTime.outputTokens,
    allTimeSavedUSD: allTime.cacheSavingsUSD,
    allTimeAvgCacheEfficiency,
    todBuckets: [todMap.night, todMap.morning, todMap.afternoon, todMap.evening],
  };
}
