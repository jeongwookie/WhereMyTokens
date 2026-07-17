import type { ProviderId, ProviderQuotaSnapshot } from './providers/types';
import { cacheEfficiencyDenominator, cacheEfficiencyPct } from './cacheMetrics';
import { weekKey } from '../shared/bucketKey';
import {
  buildProviderWindowTargets,
  targetAcceptsModel,
} from './usageWindowTargets';
import type { UsageData, UsageWindowResetHints, WindowStats } from './usageWindows';
import type { UsageTrendData, UsageTrendPoint } from './usageTrendTypes';
import {
  usageProviderVisible,
  type UsageVisibilityFilter,
} from './usageVisibilityFilter';
import type {
  UsageEntry,
  UsageIndex,
  UsageMetrics,
  UsageQueryResult,
} from './usageIndex';
import { usageRetentionCutoffs } from './usageIndex/retention';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;

export interface UsageIndexProjection {
  provider: ProviderId;
  recentEntries: UsageEntry[];
  hourly: UsageQueryResult;
  daily: UsageQueryResult;
  monthly: UsageQueryResult;
}

function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDateMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

function weekStartMs(timestampMs: number): number {
  return parseLocalDateMs(weekKey(localDateKey(timestampMs)));
}

function weekLabel(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getMonth() + 1}/${date.getDate()}`;
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

function addMetrics(target: WindowStats, metrics: UsageMetrics): void {
  target.inputTokens += metrics.inputTokens;
  target.outputTokens += metrics.outputTokens;
  target.cacheCreationTokens += metrics.cacheCreationTokens;
  target.cacheReadTokens += metrics.cacheReadTokens;
  target.totalTokens += metrics.totalTokens;
  target.costUSD += metrics.costUSD;
  target.requestCount += metrics.requestCount;
  target.cacheSavingsUSD += metrics.cacheSavingsUSD;
}

function metricsFromEntry(entry: UsageEntry): UsageMetrics {
  return {
    requestCount: 1,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    cacheReadTokens: entry.cacheReadTokens,
    totalTokens: entry.inputTokens + entry.outputTokens + entry.cacheCreationTokens + entry.cacheReadTokens,
    costUSD: entry.costUSD,
    cacheSavingsUSD: entry.cacheSavingsUSD,
  };
}

export async function loadUsageIndexProjection(
  usageIndex: UsageIndex,
  provider: ProviderId,
  excludedProjectKeys: readonly string[],
  nowMs = Date.now(),
): Promise<UsageIndexProjection> {
  const providers = new Set<ProviderId>([provider]);
  const cutoffs = usageRetentionCutoffs(nowMs);
  const filter = { providers, excludedProjectKeys };
  const [recentEntries, hourly, daily, monthly] = await Promise.all([
    usageIndex.readProjectionEntries({ ...filter, fromMs: cutoffs.requestMs }),
    usageIndex.queryUsage({ ...filter, grain: 'hour', fromMs: cutoffs.hourMs }),
    usageIndex.queryUsage({ ...filter, grain: 'day', fromMs: cutoffs.dayMs }),
    usageIndex.queryUsage({ ...filter, grain: 'month' }),
  ]);
  return { provider, recentEntries, hourly, daily, monthly };
}

export function computeUsageFromUsageIndex(
  projections: readonly UsageIndexProjection[],
  resets: UsageWindowResetHints = {},
  nowMs = Date.now(),
  visibilityFilter?: UsageVisibilityFilter,
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {},
): UsageData {
  const todayStart = parseLocalDateMs(localDateKey(nowMs));
  const day7Start = todayStart - 6 * DAY_MS;
  const day30Start = todayStart - 29 * DAY_MS;
  const day150Start = todayStart - 149 * DAY_MS;
  const currentWeekStart = weekStartMs(nowMs);
  const timelineStart = currentWeekStart - 19 * WEEK_MS;
  const visibleProjections = projections.filter(projection => usageProviderVisible(visibilityFilter, projection.provider));
  const visibleProviders = new Set(visibleProjections.map(projection => projection.provider));
  const providerWindowTargets = buildProviderWindowTargets(
    visibleProviders,
    providerQuotas,
    resets,
    nowMs,
    currentWeekStart,
  );
  const providerWindows = new Map<ProviderId, NonNullable<UsageData['byProvider'][ProviderId]>>();
  const providerModelWindows = new Map<ProviderId, NonNullable<UsageData['modelWindows'][ProviderId]>>();
  const modelMap = new Map<string, UsageData['models'][number]>();
  const heatMap7 = new Map<string, UsageData['heatmap'][number]>();
  const heatMap30 = new Map<string, UsageData['heatmap30'][number]>();
  const heatMap150 = new Map<string, UsageData['heatmap90'][number]>();
  const timelineMap = new Map<number, UsageData['weeklyTimeline'][number]>();
  const allTime = emptyWindow();
  let allTimeCacheDenominator = 0;
  let todayTokens = 0;
  let todayCost = 0;
  let todayRequestCount = 0;
  let todayInputTokens = 0;
  let todayOutputTokens = 0;
  let todayCacheTokens = 0;
  let todayCacheReadTokens = 0;
  let todayCacheSavingsUSD = 0;
  let todayCacheDenominator = 0;
  const todBuckets: UsageData['todBuckets'] = [
    { period: 'night', label: 'Night (0-6h)', tokens: 0, costUSD: 0, requestCount: 0 },
    { period: 'morning', label: 'Morning (6-12h)', tokens: 0, costUSD: 0, requestCount: 0 },
    { period: 'afternoon', label: 'Afternoon (12-18h)', tokens: 0, costUSD: 0, requestCount: 0 },
    { period: 'evening', label: 'Evening (18-24h)', tokens: 0, costUSD: 0, requestCount: 0 },
  ];

  const getProviderWindowUsage = (provider: ProviderId): NonNullable<UsageData['byProvider'][ProviderId]> => {
    const existing = providerWindows.get(provider);
    if (existing) return existing;
    const next = { windows: {} };
    providerWindows.set(provider, next);
    return next;
  };
  const getProviderModelWindowUsage = (provider: ProviderId): NonNullable<UsageData['modelWindows'][ProviderId]> => {
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
  const addHeatmap = (
    map: Map<string, UsageData['heatmap'][number]>,
    rangeStart: number,
    timestampMs: number,
    tokens: number,
  ): void => {
    if (timestampMs < rangeStart) return;
    const dayIndex = Math.floor((timestampMs - rangeStart) / DAY_MS);
    const hour = new Date(timestampMs).getHours();
    const key = `${dayIndex}-${hour}`;
    const row = map.get(key);
    if (row) row.tokens += tokens;
    else map.set(key, { dayIndex, hour, tokens });
  };
  const addTimeline = (timestampMs: number, metrics: UsageMetrics): void => {
    const rowWeekStart = weekStartMs(timestampMs);
    if (rowWeekStart < timelineStart || rowWeekStart > currentWeekStart) return;
    const weekIndex = 19 - Math.round((currentWeekStart - rowWeekStart) / WEEK_MS);
    const row = timelineMap.get(weekIndex);
    if (row) {
      row.tokens += metrics.totalTokens;
      row.costUSD += metrics.costUSD;
    } else {
      timelineMap.set(weekIndex, {
        weekIndex,
        weekLabel: weekLabel(rowWeekStart),
        tokens: metrics.totalTokens,
        costUSD: metrics.costUSD,
      });
    }
  };

  for (const [provider, targets] of providerWindowTargets) {
    if (!usageProviderVisible(visibilityFilter, provider)) continue;
    const usage = getProviderWindowUsage(provider);
    for (const target of targets) usage.windows[target.windowKey] ??= emptyWindow();
  }

  for (const projection of visibleProjections) {
    const providerMetrics = projection.monthly.byProvider[projection.provider] ?? projection.monthly.aggregate;
    addMetrics(allTime, providerMetrics);
    allTimeCacheDenominator += cacheEfficiencyDenominator(projection.provider, providerMetrics);

    for (const model of projection.monthly.models) {
      if (model.provider !== projection.provider) continue;
      const key = `${model.provider}:${model.model}`;
      const row = modelMap.get(key) ?? { model: model.model, provider: model.provider, tokens: 0, costUSD: 0 };
      row.tokens += model.metrics.totalTokens;
      row.costUSD += model.metrics.costUSD;
      modelMap.set(key, row);
    }

    for (const bucket of projection.daily.buckets) {
      addTimeline(bucket.bucketStartMs, bucket.metrics);
      addHeatmap(heatMap150, day150Start, bucket.bucketStartMs, bucket.metrics.totalTokens);
    }

    for (const bucket of projection.hourly.buckets) {
      addHeatmap(heatMap7, day7Start, bucket.bucketStartMs, bucket.metrics.totalTokens);
      addHeatmap(heatMap30, day30Start, bucket.bucketStartMs, bucket.metrics.totalTokens);
      if (bucket.bucketStartMs >= day30Start) {
        const hour = new Date(bucket.bucketStartMs).getHours();
        const todIndex = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
        todBuckets[todIndex].tokens += bucket.metrics.totalTokens;
        todBuckets[todIndex].costUSD += bucket.metrics.costUSD;
        todBuckets[todIndex].requestCount += bucket.metrics.requestCount;
      }
    }

    for (const entry of projection.recentEntries) {
      const metrics = metricsFromEntry(entry);
      if (entry.timestampMs >= todayStart) {
        todayTokens += metrics.totalTokens;
        todayCost += metrics.costUSD;
        todayRequestCount += 1;
        todayInputTokens += metrics.inputTokens;
        todayOutputTokens += metrics.outputTokens;
        todayCacheTokens += metrics.cacheReadTokens + metrics.cacheCreationTokens;
        todayCacheReadTokens += metrics.cacheReadTokens;
        todayCacheSavingsUSD += metrics.cacheSavingsUSD;
        todayCacheDenominator += cacheEfficiencyDenominator(entry.provider, metrics);
      }

      const usage = getProviderWindowUsage(entry.provider);
      const addedWindowKeys = new Set<string>();
      for (const target of providerWindowTargets.get(entry.provider) ?? []) {
        if (entry.timestampMs < target.startMs || !targetAcceptsModel(target, entry.model)) continue;
        const key = `${target.windowKey}\0${entry.model}`;
        if (addedWindowKeys.has(key)) continue;
        addedWindowKeys.add(key);
        usage.windows[target.windowKey] ??= emptyWindow();
        addMetrics(usage.windows[target.windowKey], metrics);
        addMetrics(getProviderModelWindow(entry.provider, target.windowKey, entry.model), metrics);
      }
    }
  }

  for (const [provider, usage] of providerWindows) {
    for (const window of Object.values(usage.windows)) window.cacheEfficiency = cacheEfficiencyPct(provider, window);
  }
  for (const [provider, usage] of providerModelWindows) {
    for (const models of Object.values(usage.windows)) {
      for (const window of Object.values(models)) window.cacheEfficiency = cacheEfficiencyPct(provider, window);
    }
  }

  return {
    byProvider: Object.fromEntries(providerWindows),
    modelWindows: Object.fromEntries(providerModelWindows),
    models: [...modelMap.values()].filter(model => model.tokens > 0).sort((a, b) => b.tokens - a.tokens),
    heatmap: [...heatMap7.values()],
    heatmap30: [...heatMap30.values()],
    heatmap90: [...heatMap150.values()],
    weeklyTimeline: [...timelineMap.values()].sort((a, b) => a.weekIndex - b.weekIndex),
    todayTokens,
    todayCost,
    todayRequestCount,
    todayInputTokens,
    todayOutputTokens,
    todayCacheTokens,
    todayCacheSavingsUSD,
    todayCacheEfficiency: todayCacheDenominator > 0 ? (todayCacheReadTokens / todayCacheDenominator) * 100 : 0,
    allTimeRequestCount: allTime.requestCount,
    allTimeCost: allTime.costUSD,
    allTimeCacheTokens: allTime.cacheReadTokens + allTime.cacheCreationTokens,
    allTimeInputTokens: allTime.inputTokens,
    allTimeOutputTokens: allTime.outputTokens,
    allTimeSavedUSD: allTime.cacheSavingsUSD,
    allTimeAvgCacheEfficiency: allTimeCacheDenominator > 0
      ? (allTime.cacheReadTokens / allTimeCacheDenominator) * 100
      : 0,
    todBuckets,
  };
}

function addTrendPoint(
  map: Map<string, UsageTrendPoint>,
  key: string,
  field: 'date' | 'weekStart' | 'month',
  metrics: UsageMetrics,
): void {
  const row = map.get(key) ?? { [field]: key, tokens: 0, noCacheTokens: 0, costUSD: 0, requestCount: 0 };
  row.tokens += metrics.totalTokens;
  row.noCacheTokens += metrics.inputTokens + metrics.outputTokens;
  row.costUSD += metrics.costUSD;
  row.requestCount += metrics.requestCount;
  map.set(key, row);
}

export function buildTrendDataFromUsageIndex(
  projections: readonly UsageIndexProjection[],
  visibilityFilter?: UsageVisibilityFilter,
): UsageTrendData {
  const daily = new Map<string, UsageTrendPoint>();
  const weekly = new Map<string, UsageTrendPoint>();
  const monthly = new Map<string, UsageTrendPoint>();
  for (const projection of projections) {
    if (!usageProviderVisible(visibilityFilter, projection.provider)) continue;
    for (const bucket of projection.daily.buckets) {
      const date = localDateKey(bucket.bucketStartMs);
      addTrendPoint(daily, date, 'date', bucket.metrics);
      addTrendPoint(weekly, weekKey(date), 'weekStart', bucket.metrics);
    }
    for (const bucket of projection.monthly.buckets) {
      addTrendPoint(monthly, localDateKey(bucket.bucketStartMs).slice(0, 7), 'month', bucket.metrics);
    }
  }
  return {
    daily: [...daily.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    weekly: [...weekly.values()].sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart))).slice(-52),
    monthly: [...monthly.values()].sort((a, b) => String(a.month).localeCompare(String(b.month))),
  };
}
