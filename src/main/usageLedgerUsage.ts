import { UsageData, UsageWindowResetHints, WindowStats, ModelUsage, HourlyBucket, WeeklyTotal, TimeOfDayBucket } from './usageWindows';
import { UsageAggregate, UsageLedgerProvider, UsageLedgerSnapshot, isUsageLedgerProvider } from './usageLedgerTypes';
import type { ProviderId, ProviderQuotaSnapshot } from './providers/types';
import {
  usageProviderVisible,
  type UsageVisibilityFilter,
} from './usageVisibilityFilter';
import { buildProviderWindowTargets, targetAcceptsModel } from './usageWindowTargets';
import { cacheEfficiencyDenominator, cacheEfficiencyPct } from './cacheMetrics';

export interface UsageTrendPoint {
  date?: string;
  weekStart?: string;
  month?: string;
  tokens: number;
  costUSD: number;
  requestCount: number;
}

export interface UsageTrendData {
  daily: UsageTrendPoint[];
  weekly: UsageTrendPoint[];
  monthly: UsageTrendPoint[];
}

export type UsageProviderFilter = ReadonlySet<UsageLedgerProvider>;
export type UsageLedgerVisibilityFilter = UsageProviderFilter | UsageVisibilityFilter;

interface KeyedAggregate {
  key: string;
  provider: UsageLedgerProvider;
  model: string;
  timestampMs: number;
  date?: string;
  month?: string;
  aggregate: UsageAggregate;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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

function addAggregate(target: UsageAggregate, aggregate: UsageAggregate): void {
  target.requestCount += aggregate.requestCount;
  target.inputTokens += aggregate.inputTokens;
  target.outputTokens += aggregate.outputTokens;
  target.cacheCreationTokens += aggregate.cacheCreationTokens;
  target.cacheReadTokens += aggregate.cacheReadTokens;
  target.totalTokens += aggregate.totalTokens;
  target.costUSD += aggregate.costUSD;
  target.cacheSavingsUSD += aggregate.cacheSavingsUSD;
}

function finalize(window: WindowStats, provider: UsageLedgerProvider): void {
  window.cacheEfficiency = cacheEfficiencyPct(provider, window);
}

function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDateMs(date: string): number {
  return new Date(`${date}T00:00:00`).getTime();
}

function getWeekStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setDate(now.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function weekStartForDateMs(timestampMs: number): string {
  return localDateKey(getWeekStartMs(timestampMs));
}

function weekLabelFromStart(startMs: number): string {
  const date = new Date(startMs);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function parseModelKey(key: string, aggregate: UsageAggregate, kind: 'daily' | 'monthly'): KeyedAggregate | null {
  const [period, provider, ...modelParts] = key.split('|');
  const model = modelParts.join('|');
  if (!period || !isUsageLedgerProvider(provider) || !model) return null;
  const timestampMs = kind === 'daily' ? parseDateMs(period) : parseDateMs(`${period}-01`);
  if (!Number.isFinite(timestampMs)) return null;
  return {
    key,
    provider,
    model,
    timestampMs,
    ...(kind === 'daily' ? { date: period } : { month: period }),
    aggregate,
  };
}

function parseMinuteKey(key: string, aggregate: UsageAggregate): KeyedAggregate | null {
  const [timestamp, provider, ...modelParts] = key.split('|');
  const model = modelParts.join('|');
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || !isUsageLedgerProvider(provider) || !model) return null;
  return { key, provider, model, timestampMs, aggregate };
}

function parseHourKey(key: string, aggregate: UsageAggregate): { timestampMs: number; provider: UsageLedgerProvider; aggregate: UsageAggregate } | null {
  const [timestamp, provider] = key.split('|');
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || !isUsageLedgerProvider(provider)) return null;
  return { timestampMs, provider, aggregate };
}

function isProviderId(provider: UsageLedgerProvider): provider is ProviderId {
  return provider === 'claude' || provider === 'codex' || provider === 'antigravity';
}

function isUsageVisibilityFilter(filter: UsageLedgerVisibilityFilter | undefined): filter is UsageVisibilityFilter {
  return !!filter && 'providerScopes' in filter;
}

function modelMatchesFilter(provider: UsageLedgerProvider, _model: string, filter?: UsageLedgerVisibilityFilter): boolean {
  if (!filter) return true;
  if (!isUsageVisibilityFilter(filter)) return filter.has(provider);
  return isProviderId(provider) && usageProviderVisible(filter, provider);
}

function providerHourlyVisible(provider: UsageLedgerProvider, filter?: UsageLedgerVisibilityFilter): boolean {
  if (!filter) return true;
  if (!isUsageVisibilityFilter(filter)) return filter.has(provider);
  return isProviderId(provider) && usageProviderVisible(filter, provider);
}

function addModelTotal(modelMap: Map<string, ModelUsage>, model: string, provider: ModelUsage['provider'], tokens: number, costUSD: number): void {
  const key = `${provider}:${model}`;
  const modelUsage = modelMap.get(key) ?? { model, provider, tokens: 0, costUSD: 0 };
  modelUsage.tokens += tokens;
  modelUsage.costUSD += costUSD;
  modelMap.set(key, modelUsage);
}

function addTrendPoint(map: Map<string, UsageTrendPoint>, key: string, aggregate: UsageAggregate, field: 'date' | 'weekStart' | 'month'): void {
  const current = map.get(key) ?? { [field]: key, tokens: 0, costUSD: 0, requestCount: 0 };
  current.tokens += aggregate.totalTokens;
  current.costUSD += aggregate.costUSD;
  current.requestCount += aggregate.requestCount;
  map.set(key, current);
}

export function emptyUsageTrendData(): UsageTrendData {
  return { daily: [], weekly: [], monthly: [] };
}

export function buildTrendDataFromLedger(snapshot: UsageLedgerSnapshot, nowMs = Date.now(), providerFilter?: UsageLedgerVisibilityFilter): UsageTrendData {
  const daily = new Map<string, UsageTrendPoint>();
  const weekly = new Map<string, UsageTrendPoint>();
  const monthly = new Map<string, UsageTrendPoint>();

  for (const [key, aggregate] of Object.entries(snapshot.dailyModel)) {
    const row = parseModelKey(key, aggregate, 'daily');
    if (!row?.date) continue;
    if (!modelMatchesFilter(row.provider, row.model, providerFilter)) continue;
    addTrendPoint(daily, row.date, aggregate, 'date');
    addTrendPoint(weekly, weekStartForDateMs(row.timestampMs), aggregate, 'weekStart');
  }

  for (const [key, aggregate] of Object.entries(snapshot.monthlyModel)) {
    const row = parseModelKey(key, aggregate, 'monthly');
    if (!row?.month) continue;
    if (!modelMatchesFilter(row.provider, row.model, providerFilter)) continue;
    addTrendPoint(monthly, row.month, aggregate, 'month');
  }

  return {
    daily: [...daily.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-90),
    weekly: [...weekly.values()].sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart))).slice(-52),
    monthly: [...monthly.values()].sort((a, b) => String(a.month).localeCompare(String(b.month))),
  };
}

export function computeUsageFromLedger(
  snapshot: UsageLedgerSnapshot,
  resets: UsageWindowResetHints = {},
  nowMs = Date.now(),
  providerFilter?: UsageLedgerVisibilityFilter,
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>> = {},
): UsageData {
  const weekStart = getWeekStartMs(nowMs);
  const today = localDateKey(nowMs);
  const todayStart = parseDateMs(today);
  const day7Start = todayStart - 6 * DAY_MS;
  const day30Start = todayStart - 29 * DAY_MS;
  const day150Start = todayStart - 149 * DAY_MS;
  const currentWeekStart = getWeekStartMs(nowMs);
  const timelineStart = currentWeekStart - 19 * WEEK_MS;

  const windowProviders = new Set<ProviderId>();
  for (const [key, aggregate] of Object.entries(snapshot.minuteRecent)) {
    const row = parseMinuteKey(key, aggregate);
    if (row && isProviderId(row.provider)) windowProviders.add(row.provider);
  }
  const providerWindowTargets = buildProviderWindowTargets(windowProviders, providerQuotas, resets, nowMs, weekStart);
  const providerWindows = new Map<ProviderId, NonNullable<UsageData['byProvider'][ProviderId]>>();
  const providerModelWindows = new Map<ProviderId, NonNullable<UsageData['modelWindows'][ProviderId]>>();
  const allTime = emptyWindow();
  const modelMap = new Map<string, ModelUsage>();
  const heatMap7 = new Map<string, HourlyBucket>();
  const heatMap30 = new Map<string, HourlyBucket>();
  const heatMap150 = new Map<string, HourlyBucket>();
  const timelineMap = new Map<number, WeeklyTotal>();
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
    const dayIndex = Math.floor((timestampMs - rangeStart) / DAY_MS);
    const hour = new Date(timestampMs).getHours();
    const key = `${dayIndex}-${hour}`;
    const bucket = map.get(key);
    if (bucket) bucket.tokens += tokens;
    else map.set(key, { dayIndex, hour, tokens });
  };

  const addToTimeline = (timestampMs: number, tokens: number, costUSD: number) => {
    const rowWeekStart = getWeekStartMs(timestampMs);
    if (rowWeekStart < timelineStart || rowWeekStart > currentWeekStart) return;
    const weeksAgo = Math.round((currentWeekStart - rowWeekStart) / WEEK_MS);
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

  const addToTod = (timestampMs: number, aggregate: UsageAggregate) => {
    if (timestampMs < day30Start) return;
    const hour = new Date(timestampMs).getHours();
    const period = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    todMap[period].tokens += aggregate.totalTokens;
    todMap[period].costUSD += aggregate.costUSD;
    todMap[period].requestCount += aggregate.requestCount;
  };

  const addAllTime = (provider: UsageLedgerProvider, aggregate: UsageAggregate) => {
    addAggregate(allTime, aggregate);
    allTimeCacheDenominator += cacheEfficiencyDenominator(provider, aggregate);
  };

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

  for (const [provider, targets] of providerWindowTargets) {
    const usage = getProviderWindowUsage(provider);
    for (const target of targets) {
      usage.windows[target.windowKey] ??= emptyWindow();
    }
  }

  const addProviderWindowAggregate = (row: KeyedAggregate, aggregate: UsageAggregate): void => {
    if (!isProviderId(row.provider)) return;
    const usage = getProviderWindowUsage(row.provider);
    const addedWindowKeys = new Set<string>();
    for (const target of providerWindowTargets.get(row.provider) ?? []) {
      if (row.timestampMs < target.startMs) continue;
      if (!targetAcceptsModel(target, row.model)) continue;
      const windowModelKey = `${target.windowKey}\0${row.model}`;
      if (addedWindowKeys.has(windowModelKey)) continue;
      addedWindowKeys.add(windowModelKey);
      usage.windows[target.windowKey] ??= emptyWindow();
      addAggregate(usage.windows[target.windowKey], aggregate);
      addAggregate(getProviderModelWindow(row.provider, target.windowKey, row.model), aggregate);
    }
  };

  const monthlyModelKeys = new Set<string>();
  for (const [key, aggregate] of Object.entries(snapshot.monthlyModel)) {
    const row = parseModelKey(key, aggregate, 'monthly');
    if (!row?.month) continue;
    if (!modelMatchesFilter(row.provider, row.model, providerFilter)) continue;
    monthlyModelKeys.add(`${row.month}|${row.provider}|${row.model}`);
    addAllTime(row.provider, aggregate);
    addModelTotal(modelMap, row.model, row.provider, aggregate.totalTokens, aggregate.costUSD);
  }

  for (const [key, aggregate] of Object.entries(snapshot.dailyModel)) {
    const row = parseModelKey(key, aggregate, 'daily');
    if (!row?.date) continue;
    if (!modelMatchesFilter(row.provider, row.model, providerFilter)) continue;
    if (!monthlyModelKeys.has(`${row.date.slice(0, 7)}|${row.provider}|${row.model}`)) {
      addAllTime(row.provider, aggregate);
      addModelTotal(modelMap, row.model, row.provider, aggregate.totalTokens, aggregate.costUSD);
    }
    addToTimeline(row.timestampMs, aggregate.totalTokens, aggregate.costUSD);
    if (row.date === today) {
      todayTokens += aggregate.totalTokens;
      todayCost += aggregate.costUSD;
      todayRequestCount += aggregate.requestCount;
      todayInputTokens += aggregate.inputTokens;
      todayOutputTokens += aggregate.outputTokens;
      todayCacheTokens += aggregate.cacheReadTokens + aggregate.cacheCreationTokens;
      todayCacheReadTokens += aggregate.cacheReadTokens;
      todayCacheSavingsUSD += aggregate.cacheSavingsUSD;
      todayCacheDenominator += cacheEfficiencyDenominator(row.provider, aggregate);
    }
  }

  for (const [key, aggregate] of Object.entries(snapshot.minuteRecent)) {
    const row = parseMinuteKey(key, aggregate);
    if (!row) continue;
    if (!modelMatchesFilter(row.provider, row.model, providerFilter)) continue;
    addProviderWindowAggregate(row, aggregate);
  }

  for (const [key, aggregate] of Object.entries(snapshot.hourlyActivity)) {
    const row = parseHourKey(key, aggregate);
    if (!row) continue;
    if (!providerHourlyVisible(row.provider, providerFilter)) continue;
    addToHeatmap(heatMap7, day7Start, row.timestampMs, aggregate.totalTokens);
    addToHeatmap(heatMap30, day30Start, row.timestampMs, aggregate.totalTokens);
    addToHeatmap(heatMap150, day150Start, row.timestampMs, aggregate.totalTokens);
    addToTod(row.timestampMs, aggregate);
  }

  for (const [provider, usage] of providerWindows) {
    for (const window of Object.values(usage.windows)) finalize(window, provider);
  }
  for (const [provider, usage] of providerModelWindows) {
    for (const models of Object.values(usage.windows)) {
      for (const window of Object.values(models)) finalize(window, provider);
    }
  }

  const allTimeAvgCacheEfficiency = allTimeCacheDenominator > 0
    ? (allTime.cacheReadTokens / allTimeCacheDenominator) * 100
    : 0;
  const todayCacheEfficiency = todayCacheDenominator > 0
    ? (todayCacheReadTokens / todayCacheDenominator) * 100
    : 0;

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
