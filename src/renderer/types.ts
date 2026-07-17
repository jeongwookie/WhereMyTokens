import type { MainSectionId } from './mainSections';
import type {
  BucketBreakdown,
  BreakdownGrain,
  ProviderBreakdown,
  OutputComposition,
  ToolCategory,
  ToolActivity,
  NetLinesByCategory,
  PathCategory,
} from '../shared/breakdownTypes';

export type {
  BucketBreakdown,
  BreakdownGrain,
  ProviderBreakdown,
  OutputComposition,
  ToolCategory,
  ToolActivity,
  NetLinesByCategory,
  PathCategory,
};

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
  daily7d: GitDailyStats[];
  dailyAll: GitDailyStats[];
}

export interface GitDailyStats {
  date: string;
  commits: number;
  added: number;
  removed: number;
}

export interface CodeOutputStats {
  today: { commits: number; added: number; removed: number };
  all: { commits: number; added: number; removed: number };
  daily7d: GitDailyStats[];
  dailyAll: GitDailyStats[];
  repoCount: number;
  scopeLabel: string;
}

export type SessionState = 'active' | 'waiting' | 'idle' | 'compacting';

export interface SessionInfo {
  provider: 'claude' | 'codex' | 'antigravity';
  pid: number | null;
  sessionId: string;
  cwd: string;
  projectName: string;
  startedAt: string;
  entrypoint: string;
  source: string;
  state: SessionState;
  jsonlPath: string | null;
  summaryKey?: string | null;
  lastModified: string | null;
  modelName: string;
  contextUsed: number;
  contextMax: number;
  toolCounts: Record<string, number>;
  isWorktree?: boolean;
  worktreeBranch?: string | null;
  gitBranch?: string | null;
  mainRepoName?: string | null;
  gitStats?: GitStats | null;
  activityBreakdown?: {
    read: number; editWrite: number; search: number; git: number;
    buildTest: number; terminal: number; thinking: number; response: number;
    subagents: number; web: number;
  } | null;
  activityBreakdownKind?: 'tokens' | 'events' | null;
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
  provider: 'claude' | 'codex' | 'antigravity' | 'other';
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
  byProvider: Partial<Record<'claude' | 'codex' | 'antigravity', ProviderWindowUsage>>;
  modelWindows: Partial<Record<'claude' | 'codex' | 'antigravity', ProviderModelWindowUsage>>;
  models: ModelUsage[];
  heatmap: HourlyBucket[];       // 7 days × 24 hours
  heatmap30: HourlyBucket[];     // 30 days × 24 hours
  heatmap90: HourlyBucket[];     // 150 daily totals using the legacy field name
  weeklyTimeline: WeeklyTotal[]; // weekly timeline (last 20 weeks)
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

export interface UsageTrendPoint {
  date?: string;
  weekStart?: string;
  month?: string;
  tokens: number;
  noCacheTokens: number;
  costUSD: number;
  requestCount: number;
}

export interface UsageTrendData {
  daily: UsageTrendPoint[];
  weekly: UsageTrendPoint[];
  monthly: UsageTrendPoint[];
}

export type StateFreshness = 'empty' | 'restored' | 'fresh';

export type ProviderId = 'claude' | 'codex' | 'antigravity';
export type ProviderQuotaSource = 'api' | 'statusLine' | 'localLog' | 'localRpc' | 'cache';
export type QuotaDisplayMode = 'rich' | 'simple' | 'none';
export type ProviderQuotaRowVisualKind = 'pace' | 'percentOnly';

export interface ProviderQuotaWindow {
  pct: number;
  resetMs: number | null;
  resetLabel?: string;
  limitState?: 'unlimited' | 'unreported';
  source?: ProviderQuotaSource;
}

export interface ProviderQuotaStatus {
  connected: boolean;
  code: string;
  label?: string;
  detail?: string;
  severity?: 'ok' | 'warning' | 'danger';
}

export interface ProviderCreditBalance {
  available: number;
  used?: number;
  total?: number;
  remainingPct?: number;
  resetMs?: number | null;
}

export interface ProviderModelQuota {
  model: string;
  label: string;
  usageModel?: string;
  statsWindowKey?: string;
  remainingPct: number;
  resetMs?: number | null;
  groupKey?: string;
  defaultMode?: QuotaDisplayMode;
  visualKind?: ProviderQuotaRowVisualKind;
  cacheMetricTitle?: string;
  durationMs?: number;
  hideCost?: boolean;
  accentColor?: string;
  badges?: ProviderQuotaDisplayBadge[];
}

export interface ProviderQuotaDisplayBadge {
  key: string;
  label: string;
  title?: string;
  tone?: 'good' | 'neutral' | 'warning';
}

export interface ProviderQuotaWindowDisplay {
  label: string;
  visualKind?: ProviderQuotaRowVisualKind;
  cacheMetricTitle?: string;
  durationMs?: number;
  modelIncludes?: string[];
  hideCost?: boolean;
  badges?: ProviderQuotaDisplayBadge[];
}

export interface ProviderQuotaGroupSpec {
  key: string;
  label: string;
  windowKeys: string[];
  defaultMode: QuotaDisplayMode;
  accentColor?: string;
  badges?: ProviderQuotaDisplayBadge[];
  sortOrder?: number;
}

export interface ProviderQuotaSnapshot {
  provider: ProviderId;
  source: ProviderQuotaSource;
  capturedAt: number;
  accountLabel?: string;
  accountTooltip?: string;
  planName?: string;
  windows?: Record<string, ProviderQuotaWindow>;
  models?: ProviderModelQuota[];
  groups?: ProviderQuotaGroupSpec[];
  windowDisplay?: Record<string, ProviderQuotaWindowDisplay>;
  credits?: Record<string, ProviderCreditBalance>;
  status?: ProviderQuotaStatus;
  resetCredits?: ProviderResetCreditsData | null;
}

export interface ProviderResetCredit {
  idSuffix: string | null;
  status: string;
  expiresAtUtc: string | null;
}

export interface ProviderResetCreditsData {
  credits: ProviderResetCredit[];
  availableCount: number;
  totalEarnedCount: number;
  checkedAt: number;
  countOnly: boolean;
  source: 'api' | 'cache' | 'usage';
  status: ProviderQuotaStatus;
}

export interface AppSettings {
  enabledProviders: Array<'claude' | 'codex' | 'antigravity'>;
  alertThresholds: number[];
  openAtLogin: boolean;
  alwaysOnTop: boolean;
  currency: 'USD' | 'KRW';
  usdToKrw: number;
  globalHotkey: string;
  enableAlerts: boolean;
  language: 'system' | 'en' | 'ja';
  trayDisplay: 'none' | 'h5pct' | 'tokens' | 'cost';
  mainSectionOrder: MainSectionId[];
  hiddenMainSections: MainSectionId[];
  hiddenProjects: string[];
  excludedProjects: string[];
  quotaTargetModes: Partial<Record<string, QuotaDisplayMode>>;
  quotaTargetOrder: string[];
  taskbarQuotaEnabled: boolean;
  taskbarQuotaMaxBlocks: number;
  quotaTargetAbbreviations: Partial<Record<string, string>>;
  antigravityQuotaDurationPaceEnabled: boolean;
  compactWidgetEnabled: boolean;
  compactWidgetWaitingAnimationEnabled: boolean;
  compactWidgetBounds: { x: number; y: number } | null;
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

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;  // cent 단위 (÷100 = USD)
  usedCredits: number;   // cent 단위
  utilization: number;   // 0-100
  currency?: string | null;
}

export interface CodexAccountState {
  serviceTier: string | null;
}

export interface UsageIndexCoverage {
  state: 'complete' | 'incomplete';
  requiredSourceCount: number;
  indexedSourceCount: number;
  pendingSourceCount: number;
  failedSourceCount: number;
}

export interface UsageIndexHealth {
  state: 'ready' | 'recovered' | 'unavailable';
  message?: string;
  preservedPath?: string;
}

export interface AppState {
  sessions: SessionInfo[];
  usage: UsageData;
  usageTrend: UsageTrendData;
  providerQuotas: Partial<Record<ProviderId, ProviderQuotaSnapshot>>;
  settings: AppSettings;
  codexAccount: CodexAccountState;
  stateFreshness: StateFreshness;
  initialRefreshComplete: boolean;
  historyWarmupPending: boolean;
  historyWarmupStartsAt: number | null;
  usageIndexCoverage: UsageIndexCoverage;
  usageIndexHealth: UsageIndexHealth;
  lastUpdated: number;
  apiConnected: boolean;
  apiStatusLabel?: string;
  apiError?: string;
  codexUsageConnected: boolean;
  codexStatusLabel?: string;
  codexError?: string;
  bridgeActive: boolean;
  repoGitStats: Record<string, GitStats>;  // gitCommonDir → GitStats (세션 유무 무관 전체 repo)
  codeOutputStats: CodeOutputStats;
  codeOutputLoading: boolean;
  allTimeSessions: number;
}

export interface DebugMemSnapshot {
  label: string;
  ts: string;
  runtime: {
    pid: number;
    uptimeSeconds: number;
    memoryUsage: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
    heapStatistics: Record<string, number>;
    activeHandles: number;
    activeRequests: number;
    listenerCounts: {
      total: number;
      byEmitter: Record<string, number>;
    };
  };
  collections: {
    summaries: number;
    sessions: number;
    repoGitStats: number;
    gitStatsCache: number;
    dirtySessionFiles: number;
    deferredFastFiles: number;
  };
  watcher: {
    profile: 'wide' | 'recent' | 'off';
    targets: number;
    watchedDirectories: number;
    watchedFiles: number;
  };
}

export type IntegrationOwner = 'wmt' | 'other' | 'none';

export interface IntegrationStatus {
  configured: boolean;
  owner: IntegrationOwner;
  command?: string;
}

export interface IntegrationMutationResult extends IntegrationStatus {
  ok: boolean;
  error?: string;
}

declare global {
  interface Window {
    wmt: {
      getState:           () => Promise<AppState>;
      forceRefresh:       () => Promise<AppState>;
      resetIndex:         () => Promise<AppState>;
      getBreakdown:       (grain: BreakdownGrain, bucketKey: string) => Promise<BucketBreakdown>;
      getSettings:        () => Promise<AppSettings>;
      setSettings:        (p: Partial<AppSettings>) => Promise<AppSettings>;
      getNotifications:   () => Promise<HistoryItem[]>;
      clearNotifications: () => Promise<HistoryItem[]>;
      setupIntegration:     () => Promise<IntegrationMutationResult>;
      disableIntegration:   () => Promise<IntegrationMutationResult>;
      getIntegrationStatus: () => Promise<IntegrationStatus>;
      quit:               () => Promise<void>;
      minimize:           () => Promise<void>;
      openDashboard:      () => Promise<void>;
      openSettings:       () => Promise<void>;
      hideCompactWidget:  () => Promise<void>;
      getCompactWidgetPosition: () => Promise<{ x: number; y: number } | null>;
      setCompactWidgetPosition: (p: { x: number; y: number }) => Promise<void>;
      isDebugInstrumentationEnabled: () => Promise<boolean>;
      getDebugMemSnapshot: () => Promise<DebugMemSnapshot | null>;
      reportDebugRendererEvent: (payload: Record<string, unknown>) => Promise<void>;
      onUpdated:          (cb: (state: AppState) => void) => () => void;
      onNavigate:         (cb: (view: 'main' | 'settings' | 'notifications' | 'help') => void) => () => void;
      getResolvedTheme:   () => Promise<'light' | 'dark'>;
      onThemeChanged:     (cb: (theme: 'light' | 'dark') => void) => () => void;
    };
  }
}
