export interface GitStats {
  branch: string | null;
  toplevel: string | null;
  gitCommonDir: string | null;  // 워크트리 중복 제거용 (git rev-parse --git-common-dir, 절대 경로)
  commitsToday: number;
  linesAdded: number;
  linesRemoved: number;
  commits7d: number;
  linesAdded7d: number;
  linesRemoved7d: number;
  commits30d: number;
  linesAdded30d: number;
  linesRemoved30d: number;
  totalCommits: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  projectName: string;
  startedAt: string;
  entrypoint: string;
  source: string;
  state: SessionState;
  jsonlPath: string | null;
  lastModified: string | null;
  modelName: string;
  contextUsed: number;
  contextMax: number;
  toolCounts: Record<string, number>;
  isWorktree?: boolean;
  worktreeBranch?: string | null;
  mainRepoName?: string | null;
  gitStats?: GitStats | null;
  activityBreakdown?: {
    read: number; editWrite: number; search: number; git: number;
    buildTest: number; terminal: number; thinking: number; response: number;
    subagents: number; web: number;
  } | null;
}

export interface WindowStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  requestCount: number;
  cacheEfficiency: number;
  cacheSavingsUSD: number; // 캐시 읽기로 절감한 비용
}

export interface ModelUsage {
  model: string;
  tokens: number;
  costUSD: number;
}

export interface HourlyBucket {
  dayIndex: number;  // 0 = oldest day, 6 (7-day) / 29 (30-day) = today
  hour: number;
  tokens: number;
}


export interface WeeklyTotal {
  weekIndex: number;    // 0 = oldest week
  weekLabel: string;    // "3/30" format
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
  heatmap: HourlyBucket[];       // 7 days × 24 hours
  heatmap30: HourlyBucket[];     // 30 days × 24 hours
  heatmap90: HourlyBucket[];     // 90 days × 24 hours
  weeklyTimeline: WeeklyTotal[]; // weekly timeline (last 20 weeks)
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

export interface UsageLimits {
  h5: { pct: number; resetMs: number };
  week: { pct: number; resetMs: number };
  so: { pct: number; resetMs: number };
}

export interface AppSettings {
  usageLimits: { h5: number; week: number; sonnetWeek: number };
  provider: 'claude' | 'codex' | 'both';
  alertThresholds: number[];
  openAtLogin: boolean;
  currency: 'USD' | 'KRW';
  usdToKrw: number;
  globalHotkey: string;
  enableAlerts: boolean;
  trayDisplay: 'none' | 'h5pct' | 'tokens' | 'cost';
  hiddenProjects: string[];
  excludedProjects: string[];
  theme: 'auto' | 'light' | 'dark';
}

export type NotifType = 'alert';
export interface HistoryItem {
  id: string;
  type: NotifType;
  title: string;
  body: string;
  timestamp: number;
  icon: string;
}

export interface AutoLimits {
  h5: number;
  week: number;
  sonnetWeek: number;
  h5Used: number;
  weekUsed: number;
  plan: string;
  source: 'api';
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;  // cent 단위 (÷100 = USD)
  usedCredits: number;   // cent 단위
  utilization: number;   // 0-100
}

export interface AppState {
  sessions: SessionInfo[];
  usage: UsageData;
  limits: UsageLimits;
  settings: AppSettings;
  autoLimits: AutoLimits | null;
  lastUpdated: number;
  apiConnected: boolean;
  apiError?: string;
  bridgeActive: boolean;
  extraUsage: ExtraUsage | null;
  repoGitStats: Record<string, GitStats>;  // gitCommonDir → GitStats (세션 유무 무관 전체 repo)
  allTimeSessions: number;
}

declare global {
  interface Window {
    wmt: {
      getState:           () => Promise<AppState>;
      forceRefresh:       () => Promise<AppState>;
      getSettings:        () => Promise<AppSettings>;
      setSettings:        (p: Partial<AppSettings>) => Promise<AppSettings>;
      getNotifications:   () => Promise<HistoryItem[]>;
      clearNotifications: () => Promise<HistoryItem[]>;
      setupIntegration:     () => Promise<{ ok: boolean; command?: string; error?: string }>;
      getIntegrationStatus: () => Promise<{ configured: boolean; command?: string }>;
      quit:               () => Promise<void>;
      minimize:           () => Promise<void>;
      onUpdated:          (cb: () => void) => () => void;
      getResolvedTheme:   () => Promise<'light' | 'dark'>;
      onThemeChanged:     (cb: (theme: 'light' | 'dark') => void) => () => void;
    };
  }
}
