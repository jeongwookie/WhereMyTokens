import { CompactRecentEntry, FileUsageSummary } from './jsonlTypes';

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
  provider: 'claude' | 'codex' | 'other';
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

export interface BurnRate {
  h5OutputPerMin: number;
  h5EtaMs: number | null;
  weekEtaMs: number | null;
}

export interface TimeOfDayBucket {
  period: 'morning' | 'afternoon' | 'evening' | 'night';
  label: string;
  tokens: number;
  costUSD: number;
  requestCount: number;
}

export interface UsageData {
  h5: WindowStats;
  week: WindowStats;
  h5Codex: WindowStats;
  weekCodex: WindowStats;
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
  allTimeRequestCount: number;
  allTimeCost: number;
  allTimeCacheTokens: number;
  allTimeInputTokens: number;
  allTimeOutputTokens: number;
  allTimeSavedUSD: number;
  allTimeAvgCacheEfficiency: number;
  sonnetWeekTokens: number;
  burnRate: BurnRate;
  todBuckets: TimeOfDayBucket[];
}

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

function finalize(window: WindowStats, provider: 'claude' | 'codex'): void {
  const denominator = provider === 'codex'
    ? window.inputTokens + window.cacheReadTokens
    : window.cacheReadTokens + window.cacheCreationTokens;
  window.cacheEfficiency = denominator > 0 ? (window.cacheReadTokens / denominator) * 100 : 0;
}

function getWeekStart(): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setDate(now.getDate() - diff);
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

export function computeUsage(
  summaries: FileUsageSummary[],
  userLimits: { h5: number; week: number; sonnetWeek: number },
  resets: {
    claude?: { weekResetMs?: number | null; h5ResetMs?: number | null };
    codex?: { weekResetMs?: number | null; h5ResetMs?: number | null };
  } = {},
): UsageData {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const weekMs = 7 * dayMs;
  const h5Ms = 5 * 3600 * 1000;

  const windowStart = (durationMs: number, resetMs: number | null | undefined, fallbackStart: number) => {
    if (resetMs && resetMs > 0 && resetMs <= durationMs) return now - (durationMs - resetMs);
    return fallbackStart;
  };

  const claudeH5Start = windowStart(h5Ms, resets.claude?.h5ResetMs, now - h5Ms);
  const claudeWeekStart = windowStart(weekMs, resets.claude?.weekResetMs, getWeekStart().getTime());
  const codexH5Start = windowStart(h5Ms, resets.codex?.h5ResetMs, now - h5Ms);
  const codexWeekStart = windowStart(weekMs, resets.codex?.weekResetMs, getWeekStart().getTime());
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMidnight = todayStart.getTime();
  const day7Start = todayMidnight - 6 * dayMs;
  const day30Start = todayMidnight - 29 * dayMs;
  const day90Start = todayMidnight - 149 * dayMs;
  const timelineStart = now - 19 * weekMs;

  const h5 = emptyWindow();
  const week = emptyWindow();
  const h5Codex = emptyWindow();
  const weekCodex = emptyWindow();
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
  let sonnetWeekTokens = 0;

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
    if (timestampMs < timelineStart) return;
    const weeksAgo = Math.floor((now - timestampMs) / weekMs);
    const weekIndex = 19 - weeksAgo;
    const weekStartMs = getWeekStart().getTime() - weeksAgo * weekMs;
    const current = timelineMap.get(weekIndex);
    if (current) {
      current.tokens += tokens;
      current.costUSD += costUSD;
    } else {
      timelineMap.set(weekIndex, {
        weekIndex,
        weekLabel: weekLabelFromStart(weekStartMs),
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

  for (const summary of summaries) {
    addAggregate(allTime, summary.historicalRollup.aggregate);

    for (const modelTotal of Object.values(summary.historicalRollup.modelTotals)) {
      addModelTotal(modelTotal.model, modelTotal.provider, modelTotal.tokens, modelTotal.costUSD);
    }

    for (const bucket of Object.values(summary.historicalRollup.hourlyBuckets)) {
      addToHeatmap(heatMap30, day30Start, bucket.timestampMs, bucket.totalTokens);
      addToHeatmap(heatMap90, day90Start, bucket.timestampMs, bucket.totalTokens);
      addToTimeline(bucket.timestampMs, bucket.totalTokens, bucket.costUSD);
      addToTod(bucket.timestampMs, bucket.totalTokens, bucket.costUSD, bucket.requestCount);
    }

    for (const entry of summary.recentEntries) {
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
      }

      if (entry.provider === 'claude') {
        if (ts >= claudeH5Start) addEntry(h5, entry);
        if (ts >= claudeWeekStart) {
          addEntry(week, entry);
          if (entry.model.toLowerCase().includes('sonnet')) sonnetWeekTokens += tokens;
        }
      } else if (entry.provider === 'codex') {
        if (ts >= codexH5Start) addEntry(h5Codex, entry);
        if (ts >= codexWeekStart) addEntry(weekCodex, entry);
      }
    }
  }

  finalize(h5, 'claude');
  finalize(week, 'claude');
  finalize(h5Codex, 'codex');
  finalize(weekCodex, 'codex');

  const models = Array.from(modelMap.values())
    .filter(model => model.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const recentClaudeEntries = summaries.flatMap(summary => summary.recentEntries)
    .filter(entry => entry.provider === 'claude' && entry.timestampMs >= now - 5 * 60 * 1000);
  const recent5minOutput = recentClaudeEntries.reduce((sum, entry) => sum + entry.outputTokens, 0);
  const h5OutputPerMin = recent5minOutput / 5;
  const h5Remaining = userLimits.h5 - h5.totalTokens;
  const weekRemaining = userLimits.week - week.totalTokens;
  const h5EtaMs = h5OutputPerMin > 0 && h5Remaining > 0 ? (h5Remaining / h5OutputPerMin) * 60_000 : null;
  const weekEtaMs = h5OutputPerMin > 0 && weekRemaining > 0 ? (weekRemaining / h5OutputPerMin) * 60_000 : null;

  const allTimeCacheDenominator = summaries.reduce((sum, summary) => {
    const historical = Object.values(summary.historicalRollup.modelTotals).length > 0 ? summary.historicalRollup.aggregate : null;
    let total = sum;
    if (historical) {
      total += summary.provider === 'codex'
        ? historical.inputTokens + historical.cacheReadTokens
        : historical.cacheReadTokens + historical.cacheCreationTokens;
    }
    for (const entry of summary.recentEntries) {
      total += entry.provider === 'codex'
        ? entry.inputTokens + entry.cacheReadTokens
        : entry.cacheReadTokens + entry.cacheCreationTokens;
    }
    return total;
  }, 0);

  const allTimeAvgCacheEfficiency = allTimeCacheDenominator > 0
    ? (allTime.cacheReadTokens / allTimeCacheDenominator) * 100
    : 0;

  return {
    h5,
    week,
    h5Codex,
    weekCodex,
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
    allTimeRequestCount: allTime.requestCount,
    allTimeCost: allTime.costUSD,
    allTimeCacheTokens: allTime.cacheReadTokens + allTime.cacheCreationTokens,
    allTimeInputTokens: allTime.inputTokens,
    allTimeOutputTokens: allTime.outputTokens,
    allTimeSavedUSD: allTime.cacheSavingsUSD,
    allTimeAvgCacheEfficiency,
    sonnetWeekTokens,
    burnRate: { h5OutputPerMin, h5EtaMs, weekEtaMs },
    todBuckets: [todMap.night, todMap.morning, todMap.afternoon, todMap.evening],
  };
}
