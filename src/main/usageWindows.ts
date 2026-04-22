import { ParsedEntry } from './jsonlParser';

export interface WindowStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  requestCount: number;
  cacheEfficiency: number;
  cacheSavingsUSD: number; // 캐시 읽기로 절감한 비용 (vs 일반 input 요금)
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
  h5OutputPerMin: number;    // 최근 5분 output tokens/min
  h5EtaMs: number | null;    // h5 한도 도달 예상 ms (null = 활동 없음)
  weekEtaMs: number | null;  // 1w 한도 도달 예상 ms
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
  todayCacheTokens: number;       // cacheRead + cacheCreation
  allTimeRequestCount: number;
  allTimeCost: number;
  allTimeCacheTokens: number;     // 전체 cacheRead + cacheCreation
  allTimeInputTokens: number;
  allTimeOutputTokens: number;
  allTimeSavedUSD: number;
  allTimeAvgCacheEfficiency: number;
  sonnetWeekTokens: number;
  burnRate: BurnRate;
  todBuckets: TimeOfDayBucket[];
}

function emptyWindow(): WindowStats {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0 };
}

function addEntry(w: WindowStats, e: ParsedEntry) {
  w.inputTokens += e.inputTokens;
  w.outputTokens += e.outputTokens;
  w.cacheCreationTokens += e.cacheCreationTokens;
  w.cacheReadTokens += e.cacheReadTokens;
  w.totalTokens += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
  w.costUSD += e.costUSD;
  w.cacheSavingsUSD += e.cacheSavingsUSD;
  w.requestCount += 1;
}

function finalize(w: WindowStats, provider: 'claude' | 'codex') {
  const d = provider === 'codex'
    ? w.inputTokens + w.cacheReadTokens
    : w.cacheReadTokens + w.cacheCreationTokens;
  w.cacheEfficiency = d > 0 ? (w.cacheReadTokens / d) * 100 : 0;
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

// Week start date label in "M/D" format
function weekLabel(weeksAgo: number): string {
  const d = new Date();
  const dayOfWeek = d.getDay();
  const daysToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  d.setDate(d.getDate() + daysToMon - weeksAgo * 7);
  d.setHours(0, 0, 0, 0);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function computeUsage(
  allEntries: ParsedEntry[],
  _userLimits: { h5: number; week: number; sonnetWeek: number },
  resets: {
    claude?: { weekResetMs?: number; h5ResetMs?: number };
    codex?: { weekResetMs?: number; h5ResetMs?: number };
  } = {},
): UsageData {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const weekMs = 7 * dayMs;
  const h5Ms = 5 * 3600 * 1000;

  const windowStart = (durationMs: number, resetMs: number | undefined, fallbackStart: number) => {
    if (resetMs && resetMs > 0 && resetMs <= durationMs) return now - (durationMs - resetMs);
    return fallbackStart;
  };

  // Claude와 Codex는 서로 다른 rate-limit reset을 가질 수 있으므로 창을 분리한다.
  const claudeH5Start = windowStart(h5Ms, resets.claude?.h5ResetMs, now - h5Ms);
  const claudeWeekStart = windowStart(weekMs, resets.claude?.weekResetMs, getWeekStart().getTime());
  const codexH5Start = windowStart(h5Ms, resets.codex?.h5ResetMs, now - h5Ms);
  const codexWeekStart = windowStart(weekMs, resets.codex?.weekResetMs, getWeekStart().getTime());
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  // 자정 기준 시작점 — 오늘 항목이 오늘 셀에 정확히 들어가도록
  const todayMidnight = todayStart.getTime();
  // 7-day heatmap range
  const day7Start = todayMidnight - 6 * dayMs;
  // 30-day heatmap range
  const day30Start = todayMidnight - 29 * dayMs;
  // 150-day heatmap range (~5 months)
  const day90Start = todayMidnight - 149 * dayMs;
  // Timeline range (20 weeks)
  const timelineStart = now - 19 * weekMs;

  const h5 = emptyWindow(), week = emptyWindow();
  const h5Codex = emptyWindow(), weekCodex = emptyWindow();
  const modelMap = new Map<string, ModelUsage>();
  const heatMap7 = new Map<string, HourlyBucket>();
  const heatMap30 = new Map<string, HourlyBucket>();
  const heatMap90 = new Map<string, HourlyBucket>();
  const timelineMap = new Map<number, WeeklyTotal>();
  let todayTokens = 0, todayCost = 0, todayRequestCount = 0, sonnetWeekTokens = 0;
  let todayInputTokens = 0, todayOutputTokens = 0, todayCacheTokens = 0;
  let allTimeCacheTokens = 0, allTimeInputTokens = 0, allTimeOutputTokens = 0;

  // TOD 집계용 (최근 30일)
  const todMap: Record<string, TimeOfDayBucket> = {
    night:     { period: 'night',     label: 'Night (0–6h)',      tokens: 0, costUSD: 0, requestCount: 0 },
    morning:   { period: 'morning',   label: 'Morning (6–12h)',   tokens: 0, costUSD: 0, requestCount: 0 },
    afternoon: { period: 'afternoon', label: 'Afternoon (12–18h)', tokens: 0, costUSD: 0, requestCount: 0 },
    evening:   { period: 'evening',   label: 'Evening (18–24h)',  tokens: 0, costUSD: 0, requestCount: 0 },
  };

  for (const e of allEntries) {
    const ts = e.timestamp.getTime();
    const tokens = e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;

    // 7-day heatmap
    if (ts >= day7Start) {
      const dayIndex = Math.floor((ts - day7Start) / dayMs);
      const hour = e.timestamp.getHours();
      const k = `${dayIndex}-${hour}`;
      const b = heatMap7.get(k);
      if (b) b.tokens += tokens;
      else heatMap7.set(k, { dayIndex, hour, tokens });
    }

    // 30-day heatmap
    if (ts >= day30Start) {
      const dayIndex = Math.floor((ts - day30Start) / dayMs);
      const hour = e.timestamp.getHours();
      const k = `${dayIndex}-${hour}`;
      const b = heatMap30.get(k);
      if (b) b.tokens += tokens;
      else heatMap30.set(k, { dayIndex, hour, tokens });
    }

    // TOD 분류 (최근 30일)
    if (ts >= day30Start) {
      const hour = e.timestamp.getHours();
      const period = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      todMap[period].tokens += tokens;
      todMap[period].costUSD += e.costUSD;
      todMap[period].requestCount += 1;
    }

    // 120-day heatmap
    if (ts >= day90Start) {
      const dayIndex = Math.floor((ts - day90Start) / dayMs);
      const hour = e.timestamp.getHours();
      const k = `${dayIndex}-${hour}`;
      const b = heatMap90.get(k);
      if (b) b.tokens += tokens;
      else heatMap90.set(k, { dayIndex, hour, tokens });
    }

    // Timeline (weekly totals for 20 weeks)
    if (ts >= timelineStart) {
      const weeksAgo = Math.floor((now - ts) / weekMs);
      const weekIndex = 19 - weeksAgo;
      const existing = timelineMap.get(weekIndex);
      if (existing) {
        existing.tokens += tokens;
        existing.costUSD += e.costUSD;
      } else {
        timelineMap.set(weekIndex, {
          weekIndex,
          weekLabel: weekLabel(weeksAgo),
          tokens,
          costUSD: e.costUSD,
        });
      }
    }

    // All-time 토큰 집계
    allTimeCacheTokens += e.cacheReadTokens + e.cacheCreationTokens;
    allTimeInputTokens += e.inputTokens;
    allTimeOutputTokens += e.outputTokens;

    // Today
    if (ts >= todayStart.getTime()) {
      todayTokens += tokens;
      todayCost += e.costUSD;
      todayRequestCount += 1;
      todayInputTokens += e.inputTokens;
      todayOutputTokens += e.outputTokens;
      todayCacheTokens += e.cacheReadTokens + e.cacheCreationTokens;
    }

    // Per-model
    const modelKey = `${e.provider}:${e.model}`;
    const mu = modelMap.get(modelKey) ?? { model: e.model, provider: e.provider, tokens: 0, costUSD: 0 };
    mu.tokens += tokens;
    mu.costUSD += e.costUSD;
    modelMap.set(modelKey, mu);

    if (e.provider === 'claude') {
      if (ts >= claudeH5Start) addEntry(h5, e);
      if (ts >= claudeWeekStart) {
        addEntry(week, e);
        if (e.model.toLowerCase().includes('sonnet')) {
          sonnetWeekTokens += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
        }
      }
    } else if (e.provider === 'codex') {
      if (ts >= codexH5Start) addEntry(h5Codex, e);
      if (ts >= codexWeekStart) addEntry(weekCodex, e);
    }
  }

  finalize(h5, 'claude'); finalize(week, 'claude'); finalize(h5Codex, 'codex'); finalize(weekCodex, 'codex');

  const models = Array.from(modelMap.values())
    .filter(m => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  // 최근 5분 슬라이딩 윈도우 번 레이트 계산
  const win5min = now - 5 * 60 * 1000;
  const recent5minOutput = allEntries
    .filter(e => e.provider === 'claude' && e.timestamp.getTime() >= win5min)
    .reduce((sum, e) => sum + e.outputTokens, 0);
  const h5OutputPerMin = recent5minOutput / 5;
  const h5Remaining = _userLimits.h5 - h5.totalTokens;
  const weekRemaining = _userLimits.week - week.totalTokens;
  const h5EtaMs = h5OutputPerMin > 0 && h5Remaining > 0
    ? (h5Remaining / h5OutputPerMin) * 60_000 : null;
  const weekEtaMs = h5OutputPerMin > 0 && weekRemaining > 0
    ? (weekRemaining / h5OutputPerMin) * 60_000 : null;
  const burnRate: BurnRate = { h5OutputPerMin, h5EtaMs, weekEtaMs };

  const todBuckets: TimeOfDayBucket[] = [todMap.night, todMap.morning, todMap.afternoon, todMap.evening];

  // All-time 집계
  const allTimeRequestCount = allEntries.length;
  const allTimeCost = models.reduce((s, m) => s + m.costUSD, 0);
  const allTimeCacheRead = allEntries.reduce((s, e) => s + e.cacheReadTokens, 0);
  const allTimeCacheCreation = allEntries.reduce((s, e) => s + e.cacheCreationTokens, 0);
  const allTimeSavedUSD = allEntries.reduce((s, e) => s + e.cacheSavingsUSD, 0);
  const allTimeCacheDenominator = allEntries.reduce((s, e) => {
    if (e.provider === 'codex') return s + e.inputTokens + e.cacheReadTokens;
    return s + e.cacheReadTokens + e.cacheCreationTokens;
  }, 0);
  const allTimeAvgCacheEfficiency = allTimeCacheDenominator > 0
    ? (allTimeCacheRead / allTimeCacheDenominator) * 100 : 0;

  return {
    h5, week, h5Codex, weekCodex, models,
    heatmap: Array.from(heatMap7.values()),
    heatmap30: Array.from(heatMap30.values()),
    heatmap90: Array.from(heatMap90.values()),
    weeklyTimeline: Array.from(timelineMap.values()).sort((a, b) => a.weekIndex - b.weekIndex),
    todayTokens, todayCost, todayRequestCount,
    todayInputTokens, todayOutputTokens, todayCacheTokens,
    allTimeRequestCount, allTimeCost, allTimeCacheTokens,
    allTimeInputTokens, allTimeOutputTokens,
    allTimeSavedUSD, allTimeAvgCacheEfficiency,
    sonnetWeekTokens, burnRate, todBuckets,
  };
}

