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
}

export interface ModelUsage {
  model: string;
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
  sonnetWeekTokens: number;
}

function emptyWindow(): WindowStats {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0, requestCount: 0, cacheEfficiency: 0 };
}

function addEntry(w: WindowStats, e: ParsedEntry) {
  w.inputTokens += e.inputTokens;
  w.outputTokens += e.outputTokens;
  w.cacheCreationTokens += e.cacheCreationTokens;
  w.cacheReadTokens += e.cacheReadTokens;
  w.totalTokens += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
  w.costUSD += e.costUSD;
  w.requestCount += 1;
}

function finalize(w: WindowStats) {
  const d = w.cacheReadTokens + w.cacheCreationTokens;
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
): UsageData {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const weekMs = 7 * dayMs;

  const h5Start = now - 5 * 3600 * 1000;
  const weekStart = getWeekStart().getTime();
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
  let todayTokens = 0, todayCost = 0, sonnetWeekTokens = 0;

  for (const e of allEntries) {
    const ts = e.timestamp.getTime();
    const tokens = e.inputTokens + e.outputTokens;

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

    // Today
    if (ts >= todayStart.getTime()) {
      todayTokens += tokens;
      todayCost += e.costUSD;
    }

    // Per-model
    const mu = modelMap.get(e.model) ?? { model: e.model, tokens: 0, costUSD: 0 };
    mu.tokens += tokens;
    mu.costUSD += e.costUSD;
    modelMap.set(e.model, mu);

    if (e.provider === 'claude') {
      if (ts >= h5Start) addEntry(h5, e);
      if (ts >= weekStart) {
        addEntry(week, e);
        if (e.model.toLowerCase().includes('sonnet')) {
          sonnetWeekTokens += e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
        }
      }
    } else if (e.provider === 'codex') {
      if (ts >= h5Start) addEntry(h5Codex, e);
      if (ts >= weekStart) addEntry(weekCodex, e);
    }
  }

  finalize(h5); finalize(week); finalize(h5Codex); finalize(weekCodex);

  const models = Array.from(modelMap.values())
    .filter(m => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return {
    h5, week, h5Codex, weekCodex, models,
    heatmap: Array.from(heatMap7.values()),
    heatmap30: Array.from(heatMap30.values()),
    heatmap90: Array.from(heatMap90.values()),
    weeklyTimeline: Array.from(timelineMap.values()).sort((a, b) => a.weekIndex - b.weekIndex),
    todayTokens, todayCost, sonnetWeekTokens,
  };
}

