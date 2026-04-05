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
  sonnetWeekTokens: number;
}

export interface UsageLimits {
  h5: { pct: number; resetMs: number };
  week: { pct: number; resetMs: number };
  so: { pct: number; resetMs: number };
}

export interface AppSettings {
  language: 'ko' | 'en';
  refreshInterval: number;
  usageLimits: { h5: number; week: number; sonnetWeek: number };
  alertThresholds: number[];
  openAtLogin: boolean;
  defaultChartView: 'line' | 'heatmap';
  currency: 'USD' | 'KRW';
  usdToKrw: number;
  globalHotkey: string;
  enableAlerts: boolean;
  provider: 'claude' | 'codex' | 'both';
  trayDisplay: 'none' | 'h5pct' | 'tokens' | 'cost';
  hiddenProjects: string[];
  excludedProjects: string[];
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
    };
  }
}
