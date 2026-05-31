import { UsageData, WindowStats, ModelUsage, HourlyBucket, WeeklyTotal, TimeOfDayBucket } from './usageWindows';
import { UsageAggregate, UsageLedgerProvider, UsageLedgerSnapshot, isUsageLedgerProvider } from './usageLedgerTypes';
import type { ProviderId } from './providers/types';

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
const H5_MS = 5 * 60 * 60 * 1000;

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
  const denominator = cacheEfficiencyDenominator(provider, window);
  window.cacheEfficiency = denominator > 0 ? (window.cacheReadTokens / denominator) * 100 : 0;
}

function cacheEfficiencyDenominator(provider: UsageLedgerProvider, aggregate: Pick<UsageAggregate, 'inputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): number {
  return provider === 'codex'
    ? aggregate.inputTokens + aggregate.cacheReadTokens
    : aggregate.cacheReadTokens + aggregate.cacheCreationTokens;
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

function providerMatchesFilter(provider: UsageLedgerProvider, filter?: UsageProviderFilter): boolean {
  return !filter || filter.has(provider);
}

function isProviderId(provider: UsageLedgerProvider): provider is ProviderId {
  return provider === 'claude' || provider === 'codex' || provider === 'antigravity';
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

function windowStart(durationMs: number, resetMs: number | null | undefined, fallbackStart: number, nowMs: number): number {
  if (resetMs && resetMs > 0 && resetMs <= durationMs) return nowMs - (durationMs - resetMs);
  return fallbackStart;
}

export function emptyUsageTrendData(): UsageTrendData {
  return { daily: [], weekly: [], monthly: [] };
}

export function buildTrendDataFromLedger(snapshot: UsageLedgerSnapshot, nowMs = Date.now(), providerFilter?: UsageProviderFilter): UsageTrendData {
  const daily = new Map<string, UsageTrendPoint>();
  const weekly = new Map<string, UsageTrendPoint>();
  const monthly = new Map<string, UsageTrendPoint>();

  for (const [key, aggregate] of Object.entries(snapshot.dailyModel)) {
    const row = parseModelKey(key, aggregate, 'daily');
    if (!row?.date) continue;
    if (!providerMatchesFilter(row.provider, providerFilter)) continue;
    addTrendPoint(daily, row.date, aggregate, 'date');
    addTrendPoint(weekly, weekStartForDateMs(row.timestampMs), aggregate, 'weekStart');
  }

  for (const [key, aggregate] of Object.entries(snapshot.monthlyModel)) {
    const row = parseModelKey(key, aggregate, 'monthly');
    if (!row?.month) continue;
    if (!providerMatchesFilter(row.provider, providerFilter)) continue;
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
  userLimits: { h5: number; week: number; sonnetWeek: number },
  resets: {
    claude?: { weekResetMs?: number | null; h5ResetMs?: number | null };
    codex?: { weekResetMs?: number | null; h5ResetMs?: number | null };
  } = {},
  nowMs = Date.now(),
  providerFilter?: UsageProviderFilter,
): UsageData {
  const weekStart = getWeekStartMs(nowMs);
  const claudeH5Start = windowStart(H5_MS, resets.claude?.h5ResetMs, nowMs - H5_MS, nowMs);
  const claudeWeekStart = windowStart(WEEK_MS, resets.claude?.weekResetMs, weekStart, nowMs);
  const codexH5Start = windowStart(H5_MS, resets.codex?.h5ResetMs, nowMs - H5_MS, nowMs);
  const codexWeekStart = windowStart(WEEK_MS, resets.codex?.weekResetMs, weekStart, nowMs);
  const today = localDateKey(nowMs);
  const todayStart = parseDateMs(today);
  const day7Start = todayStart - 6 * DAY_MS;
  const day30Start = todayStart - 29 * DAY_MS;
  const day150Start = todayStart - 149 * DAY_MS;
  const currentWeekStart = getWeekStartMs(nowMs);
  const timelineStart = currentWeekStart - 19 * WEEK_MS;

  const providerWindows = new Map<ProviderId, NonNullable<UsageData['byProvider'][ProviderId]>>([
    ['claude', { windows: { h5: emptyWindow(), week: emptyWindow(), sonnetWeek: emptyWindow() } }],
    ['codex', { windows: { h5: emptyWindow(), week: emptyWindow() } }],
  ]);
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

  const providerWindowStarts = (provider: ProviderId): { h5: number; week: number } => {
    if (provider === 'claude') return { h5: claudeH5Start, week: claudeWeekStart };
    if (provider === 'codex') return { h5: codexH5Start, week: codexWeekStart };
    return { h5: nowMs - H5_MS, week: weekStart };
  };

  const getProviderWindowUsage = (provider: ProviderId): NonNullable<UsageData['byProvider'][ProviderId]> => {
    const existing = providerWindows.get(provider);
    if (existing) return existing;
    const next = { windows: { h5: emptyWindow(), week: emptyWindow() } };
    providerWindows.set(provider, next);
    return next;
  };

  const addProviderWindowAggregate = (row: KeyedAggregate, aggregate: UsageAggregate): void => {
    if (!isProviderId(row.provider)) return;
    const usage = getProviderWindowUsage(row.provider);
    const starts = providerWindowStarts(row.provider);
    if (row.timestampMs >= starts.h5) addAggregate(usage.windows.h5, aggregate);
    if (row.timestampMs < starts.week) return;
    addAggregate(usage.windows.week, aggregate);
    if (row.provider === 'claude' && row.model.toLowerCase().includes('sonnet')) {
      addAggregate(usage.windows.sonnetWeek, aggregate);
    }
  };

  const monthlyModelKeys = new Set<string>();
  for (const [key, aggregate] of Object.entries(snapshot.monthlyModel)) {
    const row = parseModelKey(key, aggregate, 'monthly');
    if (!row?.month) continue;
    if (!providerMatchesFilter(row.provider, providerFilter)) continue;
    monthlyModelKeys.add(`${row.month}|${row.provider}|${row.model}`);
    addAllTime(row.provider, aggregate);
    addModelTotal(modelMap, row.model, row.provider, aggregate.totalTokens, aggregate.costUSD);
  }

  for (const [key, aggregate] of Object.entries(snapshot.dailyModel)) {
    const row = parseModelKey(key, aggregate, 'daily');
    if (!row?.date) continue;
    if (!providerMatchesFilter(row.provider, providerFilter)) continue;
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
    if (!providerMatchesFilter(row.provider, providerFilter)) continue;
    addProviderWindowAggregate(row, aggregate);
  }

  for (const [key, aggregate] of Object.entries(snapshot.hourlyActivity)) {
    const row = parseHourKey(key, aggregate);
    if (!row) continue;
    if (!providerMatchesFilter(row.provider, providerFilter)) continue;
    addToHeatmap(heatMap7, day7Start, row.timestampMs, aggregate.totalTokens);
    addToHeatmap(heatMap30, day30Start, row.timestampMs, aggregate.totalTokens);
    addToHeatmap(heatMap150, day150Start, row.timestampMs, aggregate.totalTokens);
    addToTod(row.timestampMs, aggregate);
  }

  for (const [provider, usage] of providerWindows) {
    for (const window of Object.values(usage.windows)) finalize(window, provider);
  }

  const recentClaudeOutput = Object.entries(snapshot.minuteRecent).reduce((sum, [key, aggregate]) => {
    const row = parseMinuteKey(key, aggregate);
    return row?.provider === 'claude'
      && providerMatchesFilter(row.provider, providerFilter)
      && row.timestampMs >= nowMs - 5 * 60 * 1000
      ? sum + aggregate.outputTokens
      : sum;
  }, 0);
  const h5OutputPerMin = recentClaudeOutput / 5;
  const claudeWindows = getProviderWindowUsage('claude').windows;
  const claudeH5 = claudeWindows.h5;
  const claudeWeek = claudeWindows.week;
  const h5Remaining = userLimits.h5 - claudeH5.totalTokens;
  const weekRemaining = userLimits.week - claudeWeek.totalTokens;
  const h5EtaMs = h5OutputPerMin > 0 && h5Remaining > 0 ? (h5Remaining / h5OutputPerMin) * 60_000 : null;
  const weekEtaMs = h5OutputPerMin > 0 && weekRemaining > 0 ? (weekRemaining / h5OutputPerMin) * 60_000 : null;
  getProviderWindowUsage('claude').burnRate = { h5OutputPerMin, h5EtaMs, weekEtaMs };

  const allTimeAvgCacheEfficiency = allTimeCacheDenominator > 0
    ? (allTime.cacheReadTokens / allTimeCacheDenominator) * 100
    : 0;
  const todayCacheEfficiency = todayCacheDenominator > 0
    ? (todayCacheReadTokens / todayCacheDenominator) * 100
    : 0;

  return {
    byProvider: Object.fromEntries(providerWindows),
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
