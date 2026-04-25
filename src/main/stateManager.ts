import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { discoverSessions, DiscoverSessionsOptions, DiscoveredSession, SessionDiscoveryScope, SessionState, CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR, describeCodexSource, describeRepoContext, projectKeysForCwd } from './sessionDiscovery';
import { scanJsonlSummaryCached } from './jsonlParser';
import { JsonlCache } from './jsonlCache';
import { computeUsage, UsageData } from './usageWindows';
import { AppSettings, DEFAULT_SETTINGS } from './ipc';
import { fetchAutoLimits, fetchApiUsagePct, AutoLimits, ApiUsagePct, ClaudeApiStatus, hasClaudeCredentials, normalizeStoredApiUsagePct } from './rateLimitFetcher';
import { checkAlerts } from './usageAlertManager';
import Store from 'electron-store';
import { BridgeWatcher, LiveSessionData } from './bridgeWatcher';
import { aggregateDailyAllStats, aggregateDailyStats, buildDaily7dWindow, getGitStatsAsync, GitDailyStats, GitStats } from './gitStatsCollector';
import { isSafeLocalCwd } from './pathSafety';
import { clearSessionMetadataCache, invalidateSessionMetadataCache, readCodexSessionHeader, readJsonlCwd } from './sessionMetadata';
import { normalizeGitCwdKey, normalizeGitPathKey, preferGitStats, repoKeyFromGitStats } from './gitStatsKeys';
import { ActivityBreakdown, ActivityBreakdownKind, FileUsageSummary, SessionSnapshot } from './jsonlTypes';
import { CodexAccountState, readCodexAccountState } from './codexAccount';
import { appendDebugMemoryLog, collectRuntimeMemorySnapshot, isDebugInstrumentationEnabled } from './debugInstrumentation';

export interface SessionInfo extends DiscoveredSession {
  modelName: string;
  contextUsed: number;
  contextMax: number;
  toolCounts: Record<string, number>;
  gitStats: GitStats | null;
  activityBreakdown: ActivityBreakdown | null;
  activityBreakdownKind: ActivityBreakdownKind | null;
}

export interface CodeOutputStats {
  today: { commits: number; added: number; removed: number };
  all: { commits: number; added: number; removed: number };
  daily7d: GitDailyStats[];
  dailyAll: GitDailyStats[];
  repoCount: number;
  scopeLabel: string;
}

export interface DebugMemSnapshot {
  label: string;
  ts: string;
  runtime: ReturnType<typeof collectRuntimeMemorySnapshot>;
  collections: {
    summaries: number;
    sessions: number;
    repoGitStats: number;
    gitStatsCache: number;
    dirtySessionFiles: number;
    deferredFastFiles: number;
  };
  watcher: {
    profile: WatcherProfile;
    targets: number;
    watchedDirectories: number;
    watchedFiles: number;
  };
  jsonlCache: ReturnType<JsonlCache['getDebugStats']>;
}

export type UsageLimitSource = 'api' | 'statusLine' | 'cache' | 'localLog';

export interface UsageLimitWindow {
  pct: number;
  resetMs: number | null;
  resetLabel?: string;
  source?: UsageLimitSource;
}

export interface UsageLimits {
  h5: UsageLimitWindow;
  week: UsageLimitWindow;
  so: UsageLimitWindow;
  codexH5: UsageLimitWindow;
  codexWeek: UsageLimitWindow;
}

export interface AppState {
  sessions: SessionInfo[];
  usage: UsageData;
  limits: UsageLimits;
  settings: AppSettings;
  autoLimits: AutoLimits | null;
  codexAccount: CodexAccountState;
  initialRefreshComplete: boolean;
  historyWarmupPending: boolean;
  historyWarmupStartsAt: number | null;
  lastUpdated: number;
  apiConnected: boolean;
  apiStatusLabel?: string;
  apiError?: string;
  bridgeActive: boolean;
  extraUsage: ApiUsagePct['extraUsage'];
  repoGitStats: Record<string, GitStats>;
  codeOutputStats: CodeOutputStats;
  codeOutputLoading: boolean;
  allTimeSessions: number;
}

type WatcherProfile = 'wide' | 'recent' | 'off';

interface PerfSampleStart {
  wallNs: bigint;
  cpu: NodeJS.CpuUsage;
}

interface PerfMetrics {
  elapsedMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  cpuTotalMs: number;
}

interface SessionBuildResult {
  sessions: SessionInfo[];
  discoveryScope: SessionDiscoveryScope;
  discoveredCount: number;
  dedupedCount: number;
  reusedCount: number;
  sessionCountDelta: number;
  anomaly?: string;
}

const SESSIONS_DIR = CLAUDE_SESSIONS_DIR;
const PROJECTS_DIR = CLAUDE_PROJECTS_DIR;
const NULL_RESET_CACHE_TTL_MS = 30 * 60 * 1000;

function getJsonlMtime(filePath: string): Date | null {
  try { return fs.statSync(filePath).mtime; }
  catch { return null; }
}

function ageResetMs(resetMs: number | null, elapsedMs: number): number | null {
  if (resetMs == null) return null;
  return Math.max(0, resetMs - elapsedMs);
}

function ageCachedPct(pct: number, resetMs: number | null, elapsedMs: number): number {
  if (resetMs == null) return elapsedMs > NULL_RESET_CACHE_TTL_MS ? 0 : pct;
  return elapsedMs > resetMs ? 0 : pct;
}

function ageApiUsageSample(sample: ApiUsagePct, elapsedMs: number): ApiUsagePct {
  return {
    ...sample,
    h5Pct: ageCachedPct(sample.h5Pct, sample.h5ResetMs, elapsedMs),
    weekPct: ageCachedPct(sample.weekPct, sample.weekResetMs, elapsedMs),
    soPct: ageCachedPct(sample.soPct, sample.soResetMs, elapsedMs),
    h5ResetMs: ageResetMs(sample.h5ResetMs, elapsedMs),
    weekResetMs: ageResetMs(sample.weekResetMs, elapsedMs),
    soResetMs: ageResetMs(sample.soResetMs, elapsedMs),
    extraUsage: sample.extraUsage ?? null,
  };
}

function hasMeaningfulLimitWindow(window: UsageLimitWindow | null | undefined): boolean {
  if (!window) return false;
  return window.pct > 0
    || window.resetMs != null
    || !!window.resetLabel
    || window.source === 'statusLine'
    || window.source === 'localLog';
}

function emptyUsageLimitWindow(): UsageLimitWindow {
  return { pct: 0, resetMs: null };
}

function canReuseClaudeCachedWindow(window: UsageLimitWindow | null | undefined): boolean {
  return hasMeaningfulLimitWindow(window) && window?.source !== 'statusLine';
}

function approximateSessionState(lastModified: Date | null): SessionState {
  if (!lastModified) return 'idle';
  const diffMin = (Date.now() - lastModified.getTime()) / 60000;
  if (diffMin < 2) return 'active';
  if (diffMin < 15) return 'waiting';
  return 'idle';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentSessionState(provider: SessionInfo['provider'], pid: number | null, lastModified: Date | null): SessionState {
  if (provider === 'claude' && pid != null && !isProcessAlive(pid)) return 'idle';
  return approximateSessionState(lastModified);
}

function gitStatsCacheKey(cwd: string): string {
  return normalizeGitCwdKey(cwd);
}

function normalizeFileKey(filePath: string): string {
  return path.normalize(filePath);
}

function makeExcludedMatcher(excludedProjects: readonly string[] = []) {
  const exact = new Set(excludedProjects.filter(Boolean));
  const folded = new Set([...exact].map(name => name.toLowerCase()));
  return (keys: Array<string | null | undefined>) => keys.some(key => {
    if (!key) return false;
    return exact.has(key) || folded.has(key.toLowerCase());
  });
}

function isSameOrChildPath(parentPath: string | null, childPath: string | null): boolean {
  if (!parentPath || !childPath) return false;
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveSessionRepoKeys(
  sessions: Array<{ cwd: string; gitStats?: Pick<GitStats, 'gitCommonDir' | 'toplevel'> | null }>,
  repoGitStats: Record<string, Pick<GitStats, 'gitCommonDir' | 'toplevel'>>
): Set<string> {
  const scopedRepoKeys = new Set<string>();
  const repoEntries = Object.entries(repoGitStats)
    .map(([key, stats]) => ({
      repoKey: normalizeGitPathKey(key) ?? repoKeyFromGitStats(stats),
      topLevelKey: normalizeGitPathKey(stats.toplevel),
    }))
    .filter((entry): entry is { repoKey: string; topLevelKey: string | null } => !!entry.repoKey);

  for (const session of sessions) {
    const directKey = repoKeyFromGitStats(session.gitStats);
    if (directKey) scopedRepoKeys.add(directKey);

    const cwdKey = normalizeGitPathKey(session.cwd);
    if (!cwdKey) continue;
    for (const entry of repoEntries) {
      if (isSameOrChildPath(entry.topLevelKey, cwdKey)) scopedRepoKeys.add(entry.repoKey);
    }
  }

  return scopedRepoKeys;
}

export class StateManager {
  private store: Store<AppSettings>;
  private summaries = new Map<string, FileUsageSummary>();
  private state: AppState;
  private fastTimer: NodeJS.Timeout | null = null;
  private heavyTimer: NodeJS.Timeout | null = null;
  private autoLimitTimer: NodeJS.Timeout | null = null;
  private watcher: chokidar.FSWatcher | null = null;
  private fastDebounce: NodeJS.Timeout | null = null;
  private onUpdate: (s: AppState) => void;
  private autoLimits: AutoLimits | null = null;
  private apiUsagePct: ApiUsagePct | null = null;
  private apiUsagePctStoredAt = 0;
  private apiConnected = false;
  private apiStatusLabel = '';
  private apiError = '';
  private lastApiCallMs = 0;
  private apiBackoffMs = 0;
  private bridgeWatcher: BridgeWatcher;
  private liveSession: LiveSessionData | null = null;
  private jsonlCache = new JsonlCache();
  private codexRateLimits: SessionSnapshot['codexRateLimits'] | null = null;
  private gitStatsCache = new Map<string, { stats: GitStats | null; ts: number }>();
  private dirtySessionFiles = new Set<string>();
  private deferredFastFiles = new Set<string>();
  private heavyInFlight = false;
  private heavyPending = false;
  private historyWarmupTimer: NodeJS.Timeout | null = null;
  private gitWarmupTimer: NodeJS.Timeout | null = null;
  private debugMemTimer: NodeJS.Timeout | null = null;
  private uiBusy = false;
  private uiVisible = false;
  private watcherProfile: WatcherProfile = 'off';
  private watcherTargetCount = 0;
  private repoGitStatsLastRefresh = 0;
  private static readonly API_MIN_INTERVAL_MS = 180_000;
  private static readonly GIT_STATS_TTL_MS = 600_000;
  private static readonly FAST_REFRESH_VISIBLE_MS = 60_000;
  private static readonly HEAVY_REFRESH_VISIBLE_MS = 300_000;
  private static readonly FAST_REFRESH_HIDDEN_MS = 300_000;
  private static readonly HEAVY_REFRESH_HIDDEN_MS = 900_000;
  private static readonly STARTUP_SCAN_BUDGET_MS = 2_500;
  private static readonly STARTUP_WARMUP_DELAY_MS = 90_000;
  private static readonly STARTUP_GIT_DELAY_MS = 60_000;
  private static readonly STARTUP_CLAUDE_FILE_LIMIT = 48;
  private static readonly STARTUP_CODEX_FILE_LIMIT = 96;
  private static readonly HIDDEN_CLAUDE_WATCH_LIMIT = 24;
  private static readonly HIDDEN_CODEX_WATCH_LIMIT = 48;
  private static readonly SESSION_SCOPE: SessionDiscoveryScope = 'recent-active';
  private static readonly SESSION_SPIKE_MARGIN = 24;

  constructor(store: Store<AppSettings>, onUpdate: (s: AppState) => void) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.state = this.emptyState();
    const cached = normalizeStoredApiUsagePct(
      (this.store as unknown as Store<Record<string, unknown>>).get('_cachedApiPct', null)
    );
    if (cached && hasClaudeCredentials()) {
      this.apiUsagePctStoredAt = cached.storedAt ?? 0;
      const elapsed = this.apiUsagePctStoredAt ? Date.now() - this.apiUsagePctStoredAt : Infinity;
      this.apiUsagePct = ageApiUsageSample(cached, elapsed);
    }

    this.bridgeWatcher = new BridgeWatcher((data) => {
      this.liveSession = data;
      const limits = this.buildLimits();
      this.state = {
        ...this.state,
        limits,
        bridgeActive: true,
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
      };
      this.onUpdate(this.state);
    });
  }

  private getSettings(): AppSettings {
    return { ...DEFAULT_SETTINGS, ...this.store.store };
  }

  private emptyState(): AppState {
    return {
      sessions: [],
      usage: {
        h5: this.emptyWindow(),
        week: this.emptyWindow(),
        h5Codex: this.emptyWindow(),
        weekCodex: this.emptyWindow(),
        models: [],
        heatmap: [],
        heatmap30: [],
        heatmap90: [],
        weeklyTimeline: [],
        todayTokens: 0,
        todayCost: 0,
        todayRequestCount: 0,
        todayInputTokens: 0,
        todayOutputTokens: 0,
        todayCacheTokens: 0,
        allTimeRequestCount: 0,
        allTimeCost: 0,
        allTimeCacheTokens: 0,
        allTimeInputTokens: 0,
        allTimeOutputTokens: 0,
        allTimeSavedUSD: 0,
        allTimeAvgCacheEfficiency: 0,
        sonnetWeekTokens: 0,
        burnRate: { h5OutputPerMin: 0, h5EtaMs: null, weekEtaMs: null },
        todBuckets: [],
      },
      limits: {
        h5: { pct: 0, resetMs: null, source: 'cache' },
        week: { pct: 0, resetMs: null, source: 'cache' },
        so: { pct: 0, resetMs: null, source: 'cache' },
        codexH5: { pct: 0, resetMs: null, source: 'cache' },
        codexWeek: { pct: 0, resetMs: null, source: 'cache' },
      },
      settings: this.getSettings(),
      autoLimits: null,
      codexAccount: readCodexAccountState(),
      initialRefreshComplete: false,
      historyWarmupPending: false,
      historyWarmupStartsAt: null,
      lastUpdated: 0,
      apiConnected: false,
      apiStatusLabel: undefined,
      bridgeActive: false,
      extraUsage: null,
      repoGitStats: {},
      codeOutputStats: this.emptyCodeOutputStats(),
      codeOutputLoading: false,
      allTimeSessions: 0,
    };
  }

  private emptyWindow() {
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

  private emptyCodeOutputStats(): CodeOutputStats {
    return {
      today: { commits: 0, added: 0, removed: 0 },
      all: { commits: 0, added: 0, removed: 0 },
      daily7d: buildDaily7dWindow(),
      dailyAll: [],
      repoCount: 0,
      scopeLabel: 'Current session repos',
    };
  }

  private sessionProjectKeys(session: Pick<DiscoveredSession, 'cwd' | 'mainRepoName' | 'projectName'>): string[] {
    return [
      session.mainRepoName,
      session.projectName,
      ...projectKeysForCwd(session.cwd),
    ].filter((key): key is string => !!key);
  }

  start() {
    this.bridgeWatcher.start();
    void this.heavyRefresh(false, true);
    this.startTimers();
    this.startWatcher();
    this.startDebugMemTimer();
    void Promise.all([this.refreshAutoLimits(), this.refreshApiUsagePct()])
      .then(() => {
        const limits = this.buildLimits();
        this.state = {
          ...this.state,
          limits,
          autoLimits: this.autoLimits,
          apiConnected: this.apiConnected,
          apiStatusLabel: this.apiStatusLabel || undefined,
          apiError: this.apiError || undefined,
        };
        this.onUpdate(this.state);
      });

    this.autoLimitTimer = setInterval(() => {
      void this.refreshAutoLimits();
    }, 5 * 60 * 1000);
  }

  stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    if (this.autoLimitTimer) clearInterval(this.autoLimitTimer);
    if (this.debugMemTimer) clearInterval(this.debugMemTimer);
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    if (this.historyWarmupTimer) clearTimeout(this.historyWarmupTimer);
    if (this.gitWarmupTimer) clearTimeout(this.gitWarmupTimer);
    this.watcher?.close();
    this.bridgeWatcher.stop();
    this.jsonlCache.flushPersisted();
  }

  setUiBusy(busy: boolean): void {
    this.uiBusy = busy;
    if (busy) return;
    if (this.deferredFastFiles.size > 0) {
      const files = new Set(this.deferredFastFiles);
      this.deferredFastFiles.clear();
      void this.fastRefresh(files);
    }
    if (this.heavyPending) {
      this.heavyPending = false;
      void this.heavyRefresh();
    }
  }

  setUiVisible(visible: boolean): void {
    if (this.uiVisible === visible) return;
    this.uiVisible = visible;
    this.startTimers();
    this.startWatcher(visible ? 'popup:show' : 'popup:hide');
    if (visible && this.state.initialRefreshComplete && !this.uiBusy) {
      void this.heavyRefresh();
    }
  }

  private isPerfDebugEnabled(): boolean {
    const proc = process as NodeJS.Process & { defaultApp?: boolean };
    return proc.defaultApp === true || process.env.WMT_DEBUG_PERF === '1';
  }

  private isMemoryDebugEnabled(): boolean {
    const proc = process as NodeJS.Process & { defaultApp?: boolean };
    return proc.defaultApp === true || process.env.WMT_DEBUG_MEMORY === '1' || process.env.WMT_DEBUG_PERF === '1';
  }

  private beginPerfSample(): PerfSampleStart {
    return {
      wallNs: process.hrtime.bigint(),
      cpu: process.cpuUsage(),
    };
  }

  private finishPerfSample(sample: PerfSampleStart): PerfMetrics {
    const elapsedMs = Number(process.hrtime.bigint() - sample.wallNs) / 1_000_000;
    const cpu = process.cpuUsage(sample.cpu);
    const cpuUserMs = cpu.user / 1000;
    const cpuSystemMs = cpu.system / 1000;
    return {
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      cpuUserMs: Math.round(cpuUserMs * 10) / 10,
      cpuSystemMs: Math.round(cpuSystemMs * 10) / 10,
      cpuTotalMs: Math.round((cpuUserMs + cpuSystemMs) * 10) / 10,
    };
  }

  private perfFields(prefix: string, metrics: PerfMetrics): Record<string, number> {
    return {
      [`${prefix}ElapsedMs`]: metrics.elapsedMs,
      [`${prefix}CpuUserMs`]: metrics.cpuUserMs,
      [`${prefix}CpuSystemMs`]: metrics.cpuSystemMs,
      [`${prefix}CpuTotalMs`]: metrics.cpuTotalMs,
    };
  }

  private getDebugCounts(): Record<string, number | string | boolean> {
    const cacheStats = this.jsonlCache.getDebugStats();
    return {
      uiVisible: this.uiVisible,
      uiBusy: this.uiBusy,
      watcherProfile: this.watcherProfile,
      watcherTargets: this.watcherTargetCount,
      summaryCount: this.summaries.size,
      sessionCount: this.state.sessions.length,
      allTimeSessions: this.state.allTimeSessions,
      cacheMemoryEntries: cacheStats.memoryEntries,
      cachePersistedEntries: cacheStats.persistedEntries,
      cachePendingPersistedEntries: cacheStats.pendingPersistedEntries,
      cacheMemoryLimit: cacheStats.memoryLimit,
      cachePersistedLimit: cacheStats.persistedLimit,
      gitCacheEntries: this.gitStatsCache.size,
      dirtyFiles: this.dirtySessionFiles.size,
      deferredFastFiles: this.deferredFastFiles.size,
    };
  }

  private logPerfTrace(label: string, sample: PerfSampleStart, extras: Record<string, unknown> = {}): void {
    if (!this.isPerfDebugEnabled()) return;
    const metrics = this.finishPerfSample(sample);
    console.info('[WhereMyTokens][perf]', {
      label,
      ...metrics,
      ...this.getDebugCounts(),
      ...extras,
    });
  }

  private logWatcherProfile(reason: string): void {
    if (!this.isPerfDebugEnabled()) return;
    console.info('[WhereMyTokens][watcher]', {
      reason,
      profile: this.watcherProfile,
      targets: this.watcherTargetCount,
      ...this.getDebugCounts(),
    });
  }

  private startDebugMemTimer(): void {
    if (!isDebugInstrumentationEnabled()) return;
    if (this.debugMemTimer) clearInterval(this.debugMemTimer);
    void this.writeDebugMemSnapshot('startup');
    this.debugMemTimer = setInterval(() => {
      void this.writeDebugMemSnapshot('interval');
    }, 30_000);
  }

  private countWatchedPaths(): { watchedDirectories: number; watchedFiles: number } {
    const watched = this.watcher?.getWatched();
    if (!watched) return { watchedDirectories: 0, watchedFiles: 0 };
    let watchedDirectories = 0;
    let watchedFiles = 0;
    for (const files of Object.values(watched)) {
      watchedDirectories += 1;
      watchedFiles += files.length;
    }
    return { watchedDirectories, watchedFiles };
  }

  async getDebugMemSnapshot(label = 'ipc'): Promise<DebugMemSnapshot> {
    const cacheStats = this.jsonlCache.getDebugStats();
    const watched = this.countWatchedPaths();
    return {
      label,
      ts: new Date().toISOString(),
      runtime: collectRuntimeMemorySnapshot(),
      collections: {
        summaries: this.summaries.size,
        sessions: this.state.sessions.length,
        repoGitStats: Object.keys(this.state.repoGitStats).length,
        gitStatsCache: this.gitStatsCache.size,
        dirtySessionFiles: this.dirtySessionFiles.size,
        deferredFastFiles: this.deferredFastFiles.size,
      },
      watcher: {
        profile: this.watcherProfile,
        targets: this.watcherTargetCount,
        watchedDirectories: watched.watchedDirectories,
        watchedFiles: watched.watchedFiles,
      },
      jsonlCache: cacheStats,
    };
  }

  private async writeDebugMemSnapshot(label: string): Promise<void> {
    if (!isDebugInstrumentationEnabled()) return;
    const snapshot = await this.getDebugMemSnapshot(label);
    appendDebugMemoryLog('state-manager-snapshot', snapshot as unknown as Record<string, unknown>);
  }

  private async refreshAutoLimits(): Promise<void> {
    try {
      const result = await fetchAutoLimits();
      if (result) this.autoLimits = result;
    } catch { /* ignore */ }
  }

  private applyApiStatus(status: ClaudeApiStatus): void {
    this.apiConnected = status.connected;
    this.apiStatusLabel = status.label;
    this.apiError = status.detail;
  }

  private getAgedApiUsagePct(now = Date.now()): ApiUsagePct | null {
    if (!this.apiUsagePct) return null;
    if (!this.apiUsagePctStoredAt) return this.apiUsagePct;
    return ageApiUsageSample(this.apiUsagePct, now - this.apiUsagePctStoredAt);
  }

  private mergeApiUsageSample(next: ApiUsagePct, status: ClaudeApiStatus, now = Date.now()): ApiUsagePct {
    if (status.code !== 'reset-unavailable') return next;
    if (next.soPct !== 0 || next.soResetMs != null) return next;
    const previous = this.getAgedApiUsagePct(now);
    if (!previous) return next;
    if (previous.soPct <= 0 || previous.soResetMs == null) return next;
    return {
      ...next,
      soPct: previous.soPct,
      soResetMs: previous.soResetMs,
    };
  }

  private async refreshApiUsagePct(force = false): Promise<void> {
    const now = Date.now();
    const interval = Math.max(StateManager.API_MIN_INTERVAL_MS, this.apiBackoffMs);
    if (!force && now - this.lastApiCallMs < interval) return;
    this.lastApiCallMs = now;
    const result = await fetchApiUsagePct();
    this.applyApiStatus(result.status);

    if (result.usage) {
      const mergedUsage = this.mergeApiUsageSample(result.usage, result.status, now);
      this.apiUsagePct = mergedUsage;
      this.apiUsagePctStoredAt = Date.now();
      this.apiBackoffMs = 0;
      (this.store as unknown as Store<Record<string, unknown>>).set('_cachedApiPct', { ...mergedUsage, storedAt: this.apiUsagePctStoredAt });
      return;
    }

    if (result.status.code === 'no-credentials') {
      this.apiUsagePct = null;
      this.apiUsagePctStoredAt = 0;
      (this.store as unknown as Store<Record<string, unknown>>).delete('_cachedApiPct');
    } else {
      this.apiUsagePct = this.getAgedApiUsagePct(now);
    }

    if (result.status.code === 'rate-limited') {
      this.apiBackoffMs = Math.min(this.apiBackoffMs === 0 ? 120_000 : this.apiBackoffMs * 2, 600_000);
      this.apiError = `Claude API returned HTTP 429. Retry in ${Math.round(this.apiBackoffMs / 60000)}m.`;
      this.apiStatusLabel = 'rate limited';
    }
  }

  async forceRefresh(): Promise<void> {
    this.clearHistoryWarmup();
    this.clearGitWarmup();
    await this.heavyRefresh(true);
  }

  private startTimers() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    const fastIntervalMs = this.uiVisible
      ? StateManager.FAST_REFRESH_VISIBLE_MS
      : StateManager.FAST_REFRESH_HIDDEN_MS;
    const heavyIntervalMs = this.uiVisible
      ? StateManager.HEAVY_REFRESH_VISIBLE_MS
      : StateManager.HEAVY_REFRESH_HIDDEN_MS;
    this.fastTimer = setInterval(() => { void this.fastRefresh(); }, fastIntervalMs);
    this.heavyTimer = setInterval(() => {
      void this.heavyRefresh(!this.uiVisible);
    }, heavyIntervalMs);
    if (!this.isPerfDebugEnabled()) return;
    console.info('[WhereMyTokens][runtime]', {
      label: 'timers:start',
      fastIntervalMs,
      heavyIntervalMs,
      hiddenUsesForcedScan: !this.uiVisible,
      ...this.getDebugCounts(),
    });
  }

  private scheduleHistoryWarmup(delayMs = StateManager.STARTUP_WARMUP_DELAY_MS): number {
    if (this.historyWarmupTimer) clearTimeout(this.historyWarmupTimer);
    const startsAt = Date.now() + delayMs;
    this.historyWarmupTimer = setTimeout(() => {
      this.historyWarmupTimer = null;
      void this.heavyRefresh();
    }, delayMs);
    return startsAt;
  }

  private clearHistoryWarmup(): void {
    if (!this.historyWarmupTimer) return;
    clearTimeout(this.historyWarmupTimer);
    this.historyWarmupTimer = null;
  }

  private scheduleGitWarmup(delayMs = StateManager.STARTUP_GIT_DELAY_MS): void {
    if (this.gitWarmupTimer) clearTimeout(this.gitWarmupTimer);
    this.gitWarmupTimer = setTimeout(() => {
      this.gitWarmupTimer = null;
      void this.refreshGitStatsAfterStartup();
    }, delayMs);
  }

  private clearGitWarmup(): void {
    if (!this.gitWarmupTimer) return;
    clearTimeout(this.gitWarmupTimer);
    this.gitWarmupTimer = null;
  }

  private computeDerivedUsage(settings: AppSettings): Pick<AppState, 'usage' | 'limits' | 'bridgeActive' | 'extraUsage'> {
    const effectiveLimits = this.autoLimits
      ? { h5: this.autoLimits.h5, week: this.autoLimits.week, sonnetWeek: this.autoLimits.sonnetWeek }
      : settings.usageLimits;
    const now = Date.now();
    const apiUsagePct = this.getAgedApiUsagePct(now);
    const rl = this.liveSession?.rate_limits;
    const bridgeActive = !!(this.liveSession?._ts && now - this.liveSession._ts < 300_000);
    const bridgeH5ResetMs = bridgeActive && rl?.five_hour?.resets_at ? rl.five_hour.resets_at - now : null;
    const bridgeWeekResetMs = bridgeActive && rl?.seven_day?.resets_at ? rl.seven_day.resets_at - now : null;
    const h5ResetMs = !this.apiConnected && bridgeH5ResetMs != null
      ? bridgeH5ResetMs
      : (apiUsagePct?.h5ResetMs ?? bridgeH5ResetMs);
    const weekResetMs = !this.apiConnected && bridgeWeekResetMs != null
      ? bridgeWeekResetMs
      : (apiUsagePct?.weekResetMs ?? bridgeWeekResetMs);
    const codexResetMs = this.getCodexResetMs(now);
    const usage = computeUsage(this.getVisibleSummaries(settings), effectiveLimits, {
      claude: { weekResetMs, h5ResetMs },
      codex: { weekResetMs: codexResetMs.week.resetMs, h5ResetMs: codexResetMs.h5.resetMs },
    });
    return {
      usage,
      limits: this.buildLimits(),
      bridgeActive,
      extraUsage: apiUsagePct?.extraUsage ?? null,
    };
  }

  private isExcludedSummary(
    filePath: string,
    provider: 'claude' | 'codex',
    isExcluded: ReturnType<typeof makeExcludedMatcher>,
  ): boolean {
    const keys: string[] = [];
    if (provider === 'claude') keys.push(path.basename(path.dirname(filePath)));
    const cwd = readJsonlCwd(filePath, provider);
    if (cwd) keys.push(...projectKeysForCwd(cwd));
    return isExcluded(keys);
  }

  private getVisibleSummaries(settings: AppSettings): FileUsageSummary[] {
    const excludedProjects = settings.excludedProjects ?? [];
    if (excludedProjects.length === 0) return [...this.summaries.values()];
    const isExcluded = makeExcludedMatcher(excludedProjects);
    const visible: FileUsageSummary[] = [];
    for (const [filePath, summary] of this.summaries.entries()) {
      if (this.isExcludedSummary(filePath, summary.provider, isExcluded)) continue;
      visible.push(summary);
    }
    return visible;
  }

  private sessionIdentityKey(session: Pick<DiscoveredSession, 'provider' | 'jsonlPath' | 'cwd' | 'sessionId'>): string {
    return session.jsonlPath
      ? `${session.provider}:${normalizeFileKey(session.jsonlPath)}`
      : `${session.provider}:${session.cwd}:${session.sessionId}`;
  }

  private sessionSortValue(session: Pick<DiscoveredSession, 'lastModified' | 'startedAt'>): number {
    return session.lastModified?.getTime() ?? session.startedAt.getTime();
  }

  private isSameSessionInfo(a: SessionInfo, b: SessionInfo): boolean {
    return a.provider === b.provider
      && a.sessionId === b.sessionId
      && a.cwd === b.cwd
      && a.projectName === b.projectName
      && a.state === b.state
      && a.modelName === b.modelName
      && a.contextUsed === b.contextUsed
      && a.contextMax === b.contextMax
      && a.entrypoint === b.entrypoint
      && a.source === b.source
      && a.lastModified?.getTime() === b.lastModified?.getTime()
      && a.gitStats === b.gitStats
      && JSON.stringify(a.toolCounts) === JSON.stringify(b.toolCounts);
  }

  private sessionDebugExtras(nextSessions: SessionInfo[], extras: Partial<Omit<SessionBuildResult, 'sessions'>> = {}): Record<string, unknown> {
    const previousCount = this.state.sessions.length;
    const sessionCountDelta = extras.sessionCountDelta ?? (nextSessions.length - previousCount);
    const comparisonBaseline = Math.max(this.state.allTimeSessions, previousCount);
    const anomaly = extras.anomaly
      ?? ((sessionCountDelta > StateManager.SESSION_SPIKE_MARGIN || nextSessions.length > comparisonBaseline + StateManager.SESSION_SPIKE_MARGIN)
        ? 'session-count-spike'
        : undefined);
    return {
      discoveryScope: extras.discoveryScope ?? StateManager.SESSION_SCOPE,
      discoveredCount: extras.discoveredCount ?? nextSessions.length,
      dedupedCount: extras.dedupedCount ?? 0,
      reusedCount: extras.reusedCount ?? 0,
      sessionCountDelta,
      anomaly,
    };
  }

  private createSessionDiscoveryOptions(extraJsonlPaths?: Iterable<string>): DiscoverSessionsOptions {
    const trackedJsonlPaths = new Set<string>();
    for (const filePath of this.collectTrackedSessionFiles('claude', StateManager.STARTUP_CLAUDE_FILE_LIMIT)) trackedJsonlPaths.add(normalizeFileKey(filePath));
    for (const filePath of this.collectTrackedSessionFiles('codex', StateManager.STARTUP_CODEX_FILE_LIMIT)) trackedJsonlPaths.add(normalizeFileKey(filePath));
    if (extraJsonlPaths) {
      for (const filePath of extraJsonlPaths) trackedJsonlPaths.add(normalizeFileKey(filePath));
    }
    return {
      scope: StateManager.SESSION_SCOPE,
      trackedJsonlPaths: [...trackedJsonlPaths],
      maxClaudeSessions: StateManager.STARTUP_CLAUDE_FILE_LIMIT,
      maxCodexFiles: StateManager.STARTUP_CODEX_FILE_LIMIT,
    };
  }

  private buildScopedSessionInfosDetailed(
    summaries: Map<string, FileUsageSummary> = this.summaries,
    extraJsonlPaths?: Iterable<string>,
  ): SessionBuildResult {
    const settings = this.getSettings();
    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const previousByKey = new Map(this.state.sessions.map(session => [this.sessionIdentityKey(session), session]));
    const sessionsByKey = new Map<string, SessionInfo>();
    const summaryPaths = new Set<string>();
    let discoveredCount = 0;
    let reusedCount = 0;

    const pushSummaryPath = (filePath: string): void => {
      const normalized = normalizeFileKey(filePath);
      if (summaries.has(normalized)) summaryPaths.add(normalized);
    };

    for (const filePath of this.collectTrackedSessionFiles('claude', StateManager.STARTUP_CLAUDE_FILE_LIMIT)) pushSummaryPath(filePath);
    for (const filePath of this.collectTrackedSessionFiles('codex', StateManager.STARTUP_CODEX_FILE_LIMIT)) pushSummaryPath(filePath);
    for (const filePath of this.listRecentClaudeJsonlFiles(StateManager.STARTUP_CLAUDE_FILE_LIMIT).files) pushSummaryPath(filePath);
    for (const filePath of this.listRecentCodexJsonlFiles(StateManager.STARTUP_CODEX_FILE_LIMIT).files) pushSummaryPath(filePath);
    if (extraJsonlPaths) {
      for (const filePath of extraJsonlPaths) pushSummaryPath(filePath);
    }

    const addSession = (session: DiscoveredSession, summaryOverride?: FileUsageSummary | null) => {
      if (isExcluded(this.sessionProjectKeys(session))) return;
      discoveredCount += 1;
      const key = this.sessionIdentityKey(session);
      if (sessionsByKey.has(key)) return;
      const previous = previousByKey.get(key);
      const next = this.buildSessionInfo(session, previous?.gitStats, summaryOverride);
      if (previous && this.isSameSessionInfo(previous, next)) {
        reusedCount += 1;
        sessionsByKey.set(key, previous);
        return;
      }
      sessionsByKey.set(key, next);
    };

    const discovered = discoverSessions(settings.provider, this.createSessionDiscoveryOptions(summaryPaths));
    for (const session of discovered) {
      const summary = session.jsonlPath ? (summaries.get(normalizeFileKey(session.jsonlPath)) ?? null) : null;
      if (session.provider === 'codex' && !summary) continue;
      addSession(session, summary);
    }

    for (const filePath of summaryPaths) {
      const summary = summaries.get(filePath);
      if (!summary) continue;
      const bootstrap = summary.provider === 'claude'
        ? this.buildStartupClaudeSession(filePath)
        : this.buildStartupCodexSession(filePath);
      if (!bootstrap) continue;
      addSession(bootstrap, summary);
    }

    const sessions = [...sessionsByKey.values()].sort((a, b) => this.sessionSortValue(b) - this.sessionSortValue(a));
    return {
      sessions,
      discoveryScope: StateManager.SESSION_SCOPE,
      discoveredCount,
      dedupedCount: Math.max(0, discoveredCount - sessions.length),
      reusedCount,
      sessionCountDelta: sessions.length - this.state.sessions.length,
      anomaly: sessions.length > Math.max(this.state.allTimeSessions, this.state.sessions.length) + StateManager.SESSION_SPIKE_MARGIN
        ? 'session-count-spike'
        : undefined,
    };
  }

  private debouncedFastRefresh(filePath?: string) {
    if (filePath) this.dirtySessionFiles.add(normalizeFileKey(filePath));
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    this.fastDebounce = setTimeout(() => {
      this.fastDebounce = null;
      const files = this.dirtySessionFiles.size > 0 ? new Set(this.dirtySessionFiles) : undefined;
      this.dirtySessionFiles.clear();
      void this.fastRefresh(files);
    }, 1200);
  }

  private collectTrackedSessionFiles(
    provider: 'claude' | 'codex',
    maxFiles: number,
    sessions: SessionInfo[] = this.state.sessions,
  ): string[] {
    const ranked = sessions
      .filter((session): session is SessionInfo & { jsonlPath: string } => session.provider === provider && !!session.jsonlPath)
      .sort((a, b) => {
        const aHot = a.state === 'active' ? 2 : (a.state === 'waiting' ? 1 : 0);
        const bHot = b.state === 'active' ? 2 : (b.state === 'waiting' ? 1 : 0);
        if (aHot !== bHot) return bHot - aHot;
        const aTs = a.lastModified?.getTime() ?? a.startedAt.getTime();
        const bTs = b.lastModified?.getTime() ?? b.startedAt.getTime();
        return bTs - aTs;
      })
      .slice(0, maxFiles);
    return ranked.map(session => normalizeFileKey(session.jsonlPath));
  }

  private buildRecentWatchTargets(provider: AppSettings['provider']): string[] {
    const targets: string[] = [];
    const seen = new Set<string>();
    const pushFile = (filePath: string) => {
      const normalized = normalizeFileKey(filePath);
      if (seen.has(normalized) || !fs.existsSync(normalized)) return;
      seen.add(normalized);
      targets.push(normalized);
    };

    if ((provider === 'claude' || provider === 'both') && fs.existsSync(PROJECTS_DIR)) {
      for (const filePath of this.collectTrackedSessionFiles('claude', StateManager.HIDDEN_CLAUDE_WATCH_LIMIT)) pushFile(filePath);
      for (const filePath of this.listRecentClaudeJsonlFiles(StateManager.HIDDEN_CLAUDE_WATCH_LIMIT).files.slice(0, StateManager.HIDDEN_CLAUDE_WATCH_LIMIT)) pushFile(filePath);
    }
    if ((provider === 'codex' || provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
      for (const filePath of this.collectTrackedSessionFiles('codex', StateManager.HIDDEN_CODEX_WATCH_LIMIT)) pushFile(filePath);
      for (const filePath of this.listRecentCodexJsonlFiles(StateManager.HIDDEN_CODEX_WATCH_LIMIT).files.slice(0, StateManager.HIDDEN_CODEX_WATCH_LIMIT)) pushFile(filePath);
    }

    return targets;
  }

  private startWatcher(reason = 'refresh') {
    this.watcher?.close();
    this.watcher = null;

    const provider = this.getSettings().provider ?? 'both';
    const watchTargets: string[] = [];

    if (this.uiVisible) {
      if ((provider === 'claude' || provider === 'both') && fs.existsSync(SESSIONS_DIR)) {
        watchTargets.push(SESSIONS_DIR);
      }
      if ((provider === 'claude' || provider === 'both') && fs.existsSync(PROJECTS_DIR)) {
        watchTargets.push(PROJECTS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
      }
      if ((provider === 'codex' || provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
        watchTargets.push(CODEX_SESSIONS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
      }
      this.watcherProfile = 'wide';
    } else {
      watchTargets.push(...this.buildRecentWatchTargets(provider));
      this.watcherProfile = watchTargets.length > 0 ? 'recent' : 'off';
    }
    this.watcherTargetCount = watchTargets.length;
    if (watchTargets.length === 0) {
      this.logWatcherProfile(reason);
      return;
    }

    this.watcher = chokidar.watch(watchTargets, { ignoreInitial: true });
    this.watcher.on('add', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.debouncedFastRefresh(filePath);
      } else {
        void this.fastRefresh();
      }
    });
    this.watcher.on('unlink', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) {
        this.jsonlCache.invalidate(filePath);
        this.summaries.delete(normalizeFileKey(filePath));
        invalidateSessionMetadataCache(filePath);
        this.codexRateLimits = this.collectCodexRateLimits();
      }
      this.debouncedFastRefresh();
    });
    this.watcher.on('change', (filePath: string) => {
      this.debouncedFastRefresh(filePath);
    });
    this.logWatcherProfile(reason);
  }

  private async fastRefresh(changedFiles?: Set<string>) {
    const totalPerf = this.beginPerfSample();
    let changedPerf: PerfMetrics | null = null;
    let sessionPerf: PerfMetrics | null = null;
    let sessionResult: SessionBuildResult | null = null;
    if (this.uiBusy) {
      if (changedFiles) for (const file of changedFiles) this.deferredFastFiles.add(normalizeFileKey(file));
      return;
    }

    if (changedFiles && changedFiles.size > 0) {
      const changedSample = this.beginPerfSample();
      await this.refreshChangedSummaries(changedFiles);
      changedPerf = this.finishPerfSample(changedSample);
    }

    const sessionSample = this.beginPerfSample();
    const sessions = changedFiles && changedFiles.size > 0
      ? ((sessionResult = this.updateChangedSessionInfos(changedFiles)).sessions)
      : ((sessionResult = this.refreshCachedSessionInfos()).sessions);
    sessionPerf = this.finishPerfSample(sessionSample);
    const settings = this.getSettings();
    const derived = this.computeDerivedUsage(settings);
    const codexAccount = readCodexAccountState();
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    this.state = {
      ...this.state,
      sessions,
      settings,
      usage: derived.usage,
      limits: derived.limits,
      codexAccount,
      bridgeActive: derived.bridgeActive,
      apiStatusLabel: this.apiStatusLabel || undefined,
      apiError: this.apiError || undefined,
      extraUsage: derived.extraUsage,
      codeOutputStats,
      codeOutputLoading: false,
      allTimeSessions: sessions.length,
      lastUpdated: Date.now(),
    };
    this.onUpdate(this.state);
    this.logPerfTrace('fastRefresh', totalPerf, {
      changedFiles: changedFiles?.size ?? 0,
      uiVisible: this.uiVisible,
      ...(changedPerf ? this.perfFields('changed', changedPerf) : {}),
      ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
      ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
    });

    const apiFollowupSample = this.beginPerfSample();
    void this.refreshApiUsagePct().then(() => {
      const refreshed = this.computeDerivedUsage(settings);
      this.state = {
        ...this.state,
        usage: refreshed.usage,
        limits: refreshed.limits,
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
        bridgeActive: refreshed.bridgeActive,
        extraUsage: refreshed.extraUsage,
      };
      this.onUpdate(this.state);
      this.logPerfTrace('fastRefresh:apiFollowup', apiFollowupSample, {
        changedFiles: changedFiles?.size ?? 0,
        ...(sessionResult ? this.sessionDebugExtras(this.state.sessions, sessionResult) : {}),
      });
    });
  }

  private async refreshGitStatsAfterStartup(): Promise<void> {
    if (this.uiBusy || this.heavyInFlight) {
      this.scheduleGitWarmup(5_000);
      return;
    }

    const settings = this.getSettings();
    const repoGitStats = await this.getRepoGitStats(settings, false, this.state.sessions);
    const sessions = this.attachCachedGitStats(this.state.sessions);
    const codeOutputStats = this.buildCodeOutputStats(sessions, repoGitStats);
    this.state = {
      ...this.state,
      sessions,
      repoGitStats,
      codeOutputStats,
      codeOutputLoading: false,
      lastUpdated: Date.now(),
    };
    this.onUpdate(this.state);
  }

  private async heavyRefresh(force = false, allowStartupBudget = false) {
    const totalPerf = this.beginPerfSample();
    let apiPerf: PerfMetrics | null = null;
    let loadPerf: PerfMetrics | null = null;
    let sessionPerf: PerfMetrics | null = null;
    let gitPerf: PerfMetrics | null = null;
    let sessionResult: SessionBuildResult | null = null;
    if (this.uiBusy && !force) {
      this.heavyPending = true;
      return;
    }
    if (this.heavyInFlight) {
      this.heavyPending = true;
      return;
    }
    this.heavyInFlight = true;
    try {
      await this.logMemorySnapshot('heavyRefresh:start');
      const apiSample = this.beginPerfSample();
      await this.refreshApiUsagePct(force);
      apiPerf = this.finishPerfSample(apiSample);
      const initialRefreshDone = this.state.initialRefreshComplete;
      if (!force && initialRefreshDone && !this.uiVisible) {
        const sessionSample = this.beginPerfSample();
        const settings = this.getSettings();
        const derived = this.computeDerivedUsage(settings);
        const codexAccount = readCodexAccountState();
        const sessionState = this.refreshCachedSessionInfos();
        const sessions = sessionState.sessions;
        sessionResult = sessionState;
        const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
        sessionPerf = this.finishPerfSample(sessionSample);
        this.state = {
          ...this.state,
          sessions,
          usage: derived.usage,
          limits: derived.limits,
          settings,
          autoLimits: this.autoLimits,
          codexAccount,
          lastUpdated: Date.now(),
          apiConnected: this.apiConnected,
          apiStatusLabel: this.apiStatusLabel || undefined,
          apiError: this.apiError || undefined,
          bridgeActive: derived.bridgeActive,
          extraUsage: derived.extraUsage,
          codeOutputStats,
          codeOutputLoading: false,
          allTimeSessions: sessions.length,
        };
        this.onUpdate(this.state);
        checkAlerts(derived.limits, settings.alertThresholds, settings.enableAlerts, settings.provider);
        this.logPerfTrace('heavyRefresh:deferred', totalPerf, {
          uiVisible: false,
          ...(apiPerf ? this.perfFields('api', apiPerf) : {}),
          ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
          ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
        });
        return;
      }
      const loadSample = this.beginPerfSample();
      const loaded = await this.loadProviderSummaries(
        force,
        allowStartupBudget && !initialRefreshDone ? StateManager.STARTUP_SCAN_BUDGET_MS : null,
      );
      loadPerf = this.finishPerfSample(loadSample);
      this.jsonlCache.flushPersisted();
      this.summaries = loaded.summaries;
      this.codexRateLimits = loaded.codexRateLimits;

      const settings = this.getSettings();
      const derived = this.computeDerivedUsage(settings);
      const codexAccount = readCodexAccountState();
      const startupPartial = allowStartupBudget && !initialRefreshDone && loaded.partial;
      const historyWarmupStartsAt = startupPartial
        ? this.scheduleHistoryWarmup()
        : null;
      if (!startupPartial) this.clearHistoryWarmup();
      const sessionBuildSample = this.beginPerfSample();
      sessionResult = startupPartial
        ? this.buildScopedSessionInfosDetailed(loaded.summaries)
        : this.buildScopedSessionInfosDetailed(loaded.summaries);
      let sessions = sessionResult.sessions;
      sessionPerf = this.finishPerfSample(sessionBuildSample);
      const partialCodeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
      this.state = {
        sessions,
        usage: derived.usage,
        limits: derived.limits,
        settings,
        autoLimits: this.autoLimits,
        codexAccount,
        initialRefreshComplete: true,
        historyWarmupPending: startupPartial,
        historyWarmupStartsAt,
        lastUpdated: Date.now(),
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
        bridgeActive: derived.bridgeActive,
        extraUsage: derived.extraUsage,
        repoGitStats: this.state.repoGitStats,
        codeOutputStats: partialCodeOutputStats,
        codeOutputLoading: true,
        allTimeSessions: sessions.length,
      };
      this.onUpdate(this.state);
      if (!initialRefreshDone && !force) {
        this.scheduleGitWarmup();
        checkAlerts(derived.limits, settings.alertThresholds, settings.enableAlerts, settings.provider);
        await this.logMemorySnapshot('heavyRefresh:end', loaded.scannedFiles);
        if (!this.uiVisible) this.startWatcher('heavyRefresh:startupsync');
        this.logPerfTrace('heavyRefresh', totalPerf, {
          force,
          scannedFiles: loaded.scannedFiles,
          partial: loaded.partial,
          ...(apiPerf ? this.perfFields('api', apiPerf) : {}),
          ...(loadPerf ? this.perfFields('load', loadPerf) : {}),
          ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
          ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
        });
        return;
      }
      this.clearGitWarmup();

      const gitSample = this.beginPerfSample();
      const repoGitStats = await this.getRepoGitStats(settings, force, sessions);
      gitPerf = this.finishPerfSample(gitSample);
      sessions = this.attachCachedGitStats(sessions);
      const codeOutputStats = this.buildCodeOutputStats(sessions, repoGitStats);

      this.state = {
        sessions,
        usage: derived.usage,
        limits: derived.limits,
        settings,
        autoLimits: this.autoLimits,
        codexAccount,
        initialRefreshComplete: true,
        historyWarmupPending: startupPartial,
        historyWarmupStartsAt,
        lastUpdated: Date.now(),
        apiConnected: this.apiConnected,
        apiStatusLabel: this.apiStatusLabel || undefined,
        apiError: this.apiError || undefined,
        bridgeActive: derived.bridgeActive,
        extraUsage: derived.extraUsage,
        repoGitStats,
        codeOutputStats,
        codeOutputLoading: false,
        allTimeSessions: sessions.length,
      };
      this.onUpdate(this.state);

      checkAlerts(derived.limits, settings.alertThresholds, settings.enableAlerts, settings.provider);
      await this.logMemorySnapshot('heavyRefresh:end', loaded.scannedFiles);
      if (!this.uiVisible) this.startWatcher('heavyRefresh:hidden');
      this.logPerfTrace('heavyRefresh', totalPerf, {
        force,
        scannedFiles: loaded.scannedFiles,
        partial: loaded.partial,
        ...(apiPerf ? this.perfFields('api', apiPerf) : {}),
        ...(loadPerf ? this.perfFields('load', loadPerf) : {}),
        ...(sessionPerf ? this.perfFields('sessions', sessionPerf) : {}),
        ...(gitPerf ? this.perfFields('git', gitPerf) : {}),
        ...(sessionResult ? this.sessionDebugExtras(sessions, sessionResult) : {}),
      });
    } finally {
      this.heavyInFlight = false;
      if (this.heavyPending && !this.uiBusy) {
        this.heavyPending = false;
        void this.heavyRefresh();
      }
    }
  }

  private buildStartupPriorityFiles(provider: AppSettings['provider']): Set<string> {
    const priority = new Set<string>();

    if (provider === 'claude' || provider === 'both') {
      for (const filePath of this.collectTrackedSessionFiles('claude', StateManager.STARTUP_CLAUDE_FILE_LIMIT)) {
        priority.add(normalizeFileKey(filePath));
      }
    }
    if (provider === 'codex' || provider === 'both') {
      for (const filePath of this.collectTrackedSessionFiles('codex', StateManager.STARTUP_CODEX_FILE_LIMIT)) {
        priority.add(normalizeFileKey(filePath));
      }
    }

    return priority;
  }

  private buildStartupSessionInfos(summaries: Map<string, FileUsageSummary>): SessionInfo[] {
    return this.buildScopedSessionInfosDetailed(summaries).sessions;
  }

  private buildStartupClaudeSession(filePath: string): DiscoveredSession | null {
    try {
      const stat = fs.statSync(filePath);
      const cwd = readJsonlCwd(filePath, 'claude');
      if (!cwd || !isSafeLocalCwd(cwd)) return null;
      const repoContext = describeRepoContext(cwd);

      return {
        provider: 'claude',
        pid: null,
        sessionId: path.basename(filePath, '.jsonl'),
        cwd,
        projectName: repoContext.projectName,
        startedAt: stat.birthtime,
        entrypoint: 'cli',
        source: 'Terminal',
        state: approximateSessionState(stat.mtime),
        jsonlPath: filePath,
        lastModified: stat.mtime,
        isWorktree: repoContext.isWorktree,
        worktreeBranch: repoContext.worktreeBranch,
        gitBranch: repoContext.gitBranch,
        mainRepoName: repoContext.mainRepoName,
      };
    } catch {
      return null;
    }
  }

  private buildStartupCodexSession(filePath: string): DiscoveredSession | null {
    try {
      const stat = fs.statSync(filePath);
      const header = readCodexSessionHeader(filePath);
      const payload = header?.payload ?? {};
      const cwd = readJsonlCwd(filePath, 'codex');
      if (!cwd || !isSafeLocalCwd(cwd)) return null;

      const startedAtRaw = typeof payload.timestamp === 'string' ? payload.timestamp : header?.timestamp;
      const sessionId = typeof payload.id === 'string' ? payload.id : path.basename(filePath, '.jsonl');
      const originator = typeof payload.originator === 'string' ? payload.originator.toLowerCase() : '';
      const { entrypoint, source } = describeCodexSource(payload.source, originator);
      const repoContext = describeRepoContext(cwd);

      return {
        provider: 'codex',
        pid: null,
        sessionId,
        cwd,
        projectName: repoContext.projectName,
        startedAt: startedAtRaw ? new Date(startedAtRaw) : stat.birthtime,
        entrypoint,
        source,
        state: approximateSessionState(stat.mtime),
        jsonlPath: filePath,
        lastModified: stat.mtime,
        isWorktree: repoContext.isWorktree,
        worktreeBranch: repoContext.worktreeBranch,
        gitBranch: repoContext.gitBranch,
        mainRepoName: repoContext.mainRepoName,
      };
    } catch {
      return null;
    }
  }

  private buildLimits(): UsageLimits {
    const now = Date.now();
    const apiUsagePct = this.getAgedApiUsagePct(now);
    const codexResetMs = this.getCodexResetMs(now);
    const codexH5 = codexResetMs.h5;
    const codexWeek = codexResetMs.week;
    const rl = this.liveSession?.rate_limits;
    const bridgeActive = !!(this.liveSession?._ts && now - this.liveSession._ts < 300_000);
    const bridgeH5 = bridgeActive && rl?.five_hour
      ? {
          pct: rl.five_hour.used_percentage ?? 0,
          resetMs: rl.five_hour.resets_at ? rl.five_hour.resets_at - now : null,
        }
      : null;
    const bridgeWeek = bridgeActive && rl?.seven_day
      ? {
          pct: rl.seven_day.used_percentage ?? 0,
          resetMs: rl.seven_day.resets_at ? rl.seven_day.resets_at - now : null,
        }
      : null;

    if (apiUsagePct) {
      const source: UsageLimitSource = this.apiConnected ? 'api' : 'cache';
      const claudeH5 = !this.apiConnected && bridgeH5
        ? {
            pct: bridgeH5.pct,
            resetMs: bridgeH5.resetMs,
            source: 'statusLine' as UsageLimitSource,
          }
        : {
            pct: apiUsagePct.h5Pct,
            resetMs: apiUsagePct.h5ResetMs ?? bridgeH5?.resetMs ?? null,
            resetLabel: (apiUsagePct.h5ResetMs ?? bridgeH5?.resetMs ?? null) == null ? 'Claude 5h reset unavailable' : undefined,
            source,
          };
      const claudeWeek = !this.apiConnected && bridgeWeek
        ? {
            pct: bridgeWeek.pct,
            resetMs: bridgeWeek.resetMs,
            source: 'statusLine' as UsageLimitSource,
          }
        : {
            pct: apiUsagePct.weekPct,
            resetMs: apiUsagePct.weekResetMs ?? bridgeWeek?.resetMs ?? null,
            resetLabel: (apiUsagePct.weekResetMs ?? bridgeWeek?.resetMs ?? null) == null ? 'Claude weekly reset unavailable' : undefined,
            source,
          };
      return {
        h5: claudeH5,
        week: claudeWeek,
        so: {
          pct: apiUsagePct.soPct,
          resetMs: apiUsagePct.soResetMs,
          resetLabel: apiUsagePct.soResetMs == null ? 'Claude Sonnet reset unavailable' : undefined,
          source,
        },
        codexH5,
        codexWeek,
      };
    }

    if (bridgeH5 || bridgeWeek) {
      return {
        h5: bridgeH5 ? { pct: bridgeH5.pct, resetMs: bridgeH5.resetMs, source: 'statusLine' } : emptyUsageLimitWindow(),
        week: bridgeWeek ? { pct: bridgeWeek.pct, resetMs: bridgeWeek.resetMs, source: 'statusLine' } : emptyUsageLimitWindow(),
        so: emptyUsageLimitWindow(),
        codexH5,
        codexWeek,
      };
    }

    if (this.apiStatusLabel === 'local only') {
      return {
        h5: emptyUsageLimitWindow(),
        week: emptyUsageLimitWindow(),
        so: emptyUsageLimitWindow(),
        codexH5,
        codexWeek,
      };
    }

    const previous = this.state?.limits ?? {
      h5: { pct: 0, resetMs: null },
      week: { pct: 0, resetMs: null },
      so: { pct: 0, resetMs: null },
      codexH5,
      codexWeek,
    };
    return {
      h5: canReuseClaudeCachedWindow(previous.h5) ? { ...previous.h5, source: 'cache' } : emptyUsageLimitWindow(),
      week: canReuseClaudeCachedWindow(previous.week) ? { ...previous.week, source: 'cache' } : emptyUsageLimitWindow(),
      so: canReuseClaudeCachedWindow(previous.so) ? { ...previous.so, source: 'cache' } : emptyUsageLimitWindow(),
      codexH5,
      codexWeek,
    };
  }

  private getCodexResetMs(now: number): { h5: UsageLimitWindow; week: UsageLimitWindow } {
    return {
      h5: this.codexRateLimits?.h5
        ? { pct: this.codexRateLimits.h5.pct, resetMs: Math.max(0, this.codexRateLimits.h5.resetsAt * 1000 - now), source: 'localLog' }
        : emptyUsageLimitWindow(),
      week: this.codexRateLimits?.week
        ? { pct: this.codexRateLimits.week.pct, resetMs: Math.max(0, this.codexRateLimits.week.resetsAt * 1000 - now), source: 'localLog' }
        : emptyUsageLimitWindow(),
    };
  }

  private mergeCodexRateLimits(
    current: SessionSnapshot['codexRateLimits'] | null,
    next: SessionSnapshot['codexRateLimits'] | undefined,
  ): SessionSnapshot['codexRateLimits'] | null {
    if (!next?.h5 && !next?.week) return current;
    const merged: SessionSnapshot['codexRateLimits'] = { ...(current ?? {}) };
    if (next.h5 && (!merged.h5 || next.h5.observedAt >= merged.h5.observedAt)) merged.h5 = next.h5;
    if (next.week && (!merged.week || next.week.observedAt >= merged.week.observedAt)) merged.week = next.week;
    return merged;
  }

  private collectCodexRateLimits(settings: AppSettings = this.getSettings()): SessionSnapshot['codexRateLimits'] | null {
    let merged: SessionSnapshot['codexRateLimits'] | null = null;
    const visibleSummaries = this.getVisibleSummaries(settings);
    for (const summary of visibleSummaries) {
      if (summary.provider !== 'codex') continue;
      merged = this.mergeCodexRateLimits(merged, summary.sessionSnapshot.codexRateLimits);
    }
    return merged;
  }

  private async loadProviderSummaries(force = false, budgetMs: number | null = null): Promise<{
    summaries: Map<string, FileUsageSummary>;
    sessionCount: number;
    codexRateLimits: SessionSnapshot['codexRateLimits'] | null;
    scannedFiles: number;
    partial: boolean;
  }> {
    const settings = this.getSettings();
    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const hasExcludedProjects = (settings.excludedProjects?.length ?? 0) > 0;
    const summaries = new Map<string, FileUsageSummary>();
    let sessionCount = 0;
    let codexRateLimits: SessionSnapshot['codexRateLimits'] | null = null;
    let scannedFiles = 0;
    let partial = false;
    const startedAt = Date.now();
    const startupPriority = budgetMs !== null
      ? this.buildStartupPriorityFiles(settings.provider)
      : new Set(
          discoverSessions(settings.provider)
            .map(session => session.jsonlPath)
            .filter((filePath): filePath is string => !!filePath)
            .map(filePath => normalizeFileKey(filePath))
        );

    const shouldStopForBudget = () => budgetMs !== null && Date.now() - startedAt >= budgetMs;
    const shouldPrioritize = (filePath: string) => startupPriority.has(normalizeFileKey(filePath));
    const priorityClaudeFiles = [...startupPriority].filter(filePath => filePath.startsWith(normalizeFileKey(PROJECTS_DIR)));
    const priorityCodexFiles = [...startupPriority].filter(filePath => filePath.startsWith(normalizeFileKey(CODEX_SESSIONS_DIR)));

    const scanSummary = async (filePath: string, provider: 'claude' | 'codex'): Promise<FileUsageSummary | null> => {
      try {
        const normalizedPath = normalizeFileKey(filePath);
        const stat = fs.statSync(filePath);
        const allowPersistedReuse = budgetMs === null && !shouldPrioritize(filePath);
        if (!force && budgetMs !== null) {
          const cached = this.summaries.get(normalizedPath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
          const persisted = allowPersistedReuse ? this.jsonlCache.getFresh(filePath, stat.mtimeMs, stat.size) : null;
          if (persisted) return persisted;
          const cachedLoose = allowPersistedReuse ? this.jsonlCache.get(filePath) : null;
          if (cachedLoose && cachedLoose.mtimeMs === stat.mtimeMs && cachedLoose.size === stat.size) return cachedLoose;
          if (!shouldPrioritize(filePath) && shouldStopForBudget()) {
            partial = true;
            return null;
          }
        }
        if (!force) {
          const fresh = allowPersistedReuse ? this.jsonlCache.getFresh(filePath, stat.mtimeMs, stat.size) : null;
          if (fresh) return fresh;
          const existing = this.summaries.get(normalizedPath);
          if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return existing;
        }

        if (!shouldPrioritize(filePath) && shouldStopForBudget()) {
          partial = true;
          const fallback = this.summaries.get(normalizedPath) ?? this.jsonlCache.getFresh(filePath, stat.mtimeMs, stat.size);
          return fallback;
        }

        scannedFiles += 1;
        return await scanJsonlSummaryCached(filePath, provider, this.jsonlCache, force);
      } catch {
        return null;
      }
    };

    if ((settings.provider === 'claude' || settings.provider === 'both') && fs.existsSync(PROJECTS_DIR)) {
      if (budgetMs !== null) {
        const recentClaude = this.listRecentClaudeJsonlFiles(StateManager.STARTUP_CLAUDE_FILE_LIMIT);
        const recentClaudeFiles = recentClaude.files;
        const startupClaudeFiles = priorityClaudeFiles.length > 0
          ? priorityClaudeFiles
          : recentClaudeFiles.slice(0, StateManager.STARTUP_CLAUDE_FILE_LIMIT);
        if (priorityClaudeFiles.length > 0 || recentClaude.truncated || recentClaudeFiles.length > startupClaudeFiles.length) partial = true;
        for (const filePath of startupClaudeFiles) {
          if (this.isExcludedSummary(filePath, 'claude', isExcluded)) continue;
          const summary = await scanSummary(filePath, 'claude');
          if (!summary) continue;
          sessionCount += 1;
          summaries.set(normalizeFileKey(filePath), summary);
        }
      } else {
        try {
          const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

          for (const dir of projectDirs) {
            if (budgetMs !== null && shouldStopForBudget()) {
              partial = true;
              break;
            }
            const dirPath = path.join(PROJECTS_DIR, dir);
            try {
              const files = fs.readdirSync(dirPath)
                .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
                .sort((a, b) => Number(shouldPrioritize(path.join(dirPath, b))) - Number(shouldPrioritize(path.join(dirPath, a))));
              if (budgetMs !== null && shouldStopForBudget() && !files.some(file => shouldPrioritize(path.join(dirPath, file)))) {
                partial = true;
                break;
              }
              const cwd = hasExcludedProjects && files.length > 0
                ? readJsonlCwd(path.join(dirPath, files[0]), 'claude')
                : null;
              if (isExcluded([dir, ...(cwd ? projectKeysForCwd(cwd) : [])])) continue;
              sessionCount += files.length;
              for (const file of files) {
                const filePath = path.join(dirPath, file);
                if (budgetMs !== null && shouldStopForBudget() && !shouldPrioritize(filePath)) {
                  partial = true;
                  break;
                }
                const summary = await scanSummary(filePath, 'claude');
                if (summary) summaries.set(normalizeFileKey(filePath), summary);
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }

    if ((settings.provider === 'codex' || settings.provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
      const recentCodex = budgetMs !== null
        ? this.listRecentCodexJsonlFiles(StateManager.STARTUP_CODEX_FILE_LIMIT)
        : { files: [], truncated: false };
      const codexFiles = (budgetMs !== null
        ? (priorityCodexFiles.length > 0
            ? priorityCodexFiles
            : recentCodex.files)
        : this.listJsonlFiles(CODEX_SESSIONS_DIR, Number.POSITIVE_INFINITY, false))
        .sort((a, b) => Number(shouldPrioritize(b)) - Number(shouldPrioritize(a)));
      if (budgetMs !== null && (priorityCodexFiles.length > 0 || recentCodex.truncated)) partial = true;
      for (const filePath of codexFiles) {
        if (budgetMs !== null && shouldStopForBudget() && !shouldPrioritize(filePath)) {
          partial = true;
          break;
        }
        if (this.isExcludedSummary(filePath, 'codex', isExcluded)) continue;
        const cwd = hasExcludedProjects ? readJsonlCwd(filePath, 'codex') : null;
        if (cwd && isExcluded(projectKeysForCwd(cwd))) continue;
        const summary = await scanSummary(filePath, 'codex');
        if (!summary) continue;
        if (summary.recentEntries.length === 0
          && summary.historicalRollup.aggregate.requestCount === 0
          && !summary.sessionSnapshot.codexRateLimits) {
          continue;
        }
        sessionCount += 1;
        codexRateLimits = this.mergeCodexRateLimits(codexRateLimits, summary.sessionSnapshot.codexRateLimits);
        summaries.set(normalizeFileKey(filePath), summary);
      }
    }

    return { summaries, sessionCount, codexRateLimits, scannedFiles, partial };
  }

  private async refreshChangedSummaries(changedFiles: Set<string>): Promise<void> {
    const providerMode = this.getSettings().provider ?? 'both';
    for (const file of changedFiles) {
      const provider = this.providerForJsonlPath(file);
      if (!provider) continue;
      if (providerMode !== 'both' && providerMode !== provider) continue;
      if (!fs.existsSync(file)) {
        this.summaries.delete(normalizeFileKey(file));
        this.jsonlCache.invalidate(file);
        continue;
      }
      const summary = await scanJsonlSummaryCached(file, provider, this.jsonlCache);
      this.summaries.set(normalizeFileKey(file), summary);
    }
    this.jsonlCache.flushPersisted();
    this.codexRateLimits = this.collectCodexRateLimits();
  }

  private providerForJsonlPath(filePath: string): 'claude' | 'codex' | null {
    const normalized = normalizeFileKey(filePath);
    if (normalized.startsWith(normalizeFileKey(PROJECTS_DIR))) return 'claude';
    if (normalized.startsWith(normalizeFileKey(CODEX_SESSIONS_DIR))) return 'codex';
    return null;
  }

  private listRecentClaudeJsonlFiles(maxFiles: number): { files: string[]; truncated: boolean } {
    const recentFiles: Array<{ filePath: string; mtimeMs: number }> = [];
    const projectDirLimit = Math.max(maxFiles, 12);
    let truncated = false;

    try {
      const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const dirPath = path.join(PROJECTS_DIR, entry.name);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(dirPath).mtimeMs; } catch { /* skip */ }
          return { dirPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      truncated = projectDirs.length > projectDirLimit;

      for (const projectDir of projectDirs.slice(0, projectDirLimit)) {
        try {
          const files = fs.readdirSync(projectDir.dirPath)
            .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));
          for (const file of files) {
            const filePath = path.join(projectDir.dirPath, file);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* skip */ }
            recentFiles.push({ filePath, mtimeMs });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    const files = recentFiles
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(entry => entry.filePath);
    return {
      files,
      truncated: truncated || files.length > maxFiles,
    };
  }

  private listRecentCodexJsonlFiles(maxFiles: number): { files: string[]; truncated: boolean } {
    const files: string[] = [];
    let truncated = false;
    const targetCount = maxFiles + 1;

    const readSubdirs = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name);
      } catch {
        return [];
      }
    };

    const dayDirs: Array<{ dir: string; mtimeMs: number }> = [];

    for (const year of readSubdirs(CODEX_SESSIONS_DIR)) {
      const yearDir = path.join(CODEX_SESSIONS_DIR, year);
      for (const month of readSubdirs(yearDir)) {
        const monthDir = path.join(yearDir, month);
        for (const day of readSubdirs(monthDir)) {
          const dayDir = path.join(monthDir, day);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(dayDir).mtimeMs; } catch { /* skip */ }
          dayDirs.push({ dir: dayDir, mtimeMs });
        }
      }
    }

    dayDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const dayDir of dayDirs) {
      if (files.length >= targetCount) break;
      const remaining = targetCount - files.length;
      const recentFiles: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const filePath of this.listJsonlFiles(dayDir.dir, remaining, true)) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* skip */ }
        recentFiles.push({ filePath, mtimeMs });
      }
      recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      files.push(...recentFiles.map(entry => entry.filePath));
    }

    if (files.length > maxFiles) {
      truncated = true;
      files.length = maxFiles;
    }

    return { files, truncated };
  }

  private listJsonlFiles(dir: string, maxFiles = Number.POSITIVE_INFINITY, descending = false): string[] {
    const files: string[] = [];

    const walk = (currentDir: string): void => {
      if (files.length >= maxFiles) return;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
          .sort((a, b) => descending ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (files.length >= maxFiles) break;
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
        }
      } catch { /* skip */ }
    };

    walk(dir);
    return files;
  }

  private getSummary(filePath: string): FileUsageSummary | null {
    return this.summaries.get(normalizeFileKey(filePath)) ?? this.jsonlCache.get(filePath);
  }

  private peekCachedGitStats(cwd: string): GitStats | null {
    const now = Date.now();
    const cached = this.gitStatsCache.get(gitStatsCacheKey(cwd));
    if (cached && now - cached.ts < StateManager.GIT_STATS_TTL_MS) return cached.stats;
    return null;
  }

  private async getCachedGitStatsAsync(cwd: string): Promise<GitStats | null> {
    const now = Date.now();
    const key = gitStatsCacheKey(cwd);
    const cached = this.gitStatsCache.get(key);
    if (cached && now - cached.ts < StateManager.GIT_STATS_TTL_MS) return cached.stats;
    const stats = await getGitStatsAsync(cwd).catch(() => null);
    this.gitStatsCache.set(key, { stats, ts: now });
    return stats;
  }

  private async getRepoGitStats(settings: AppSettings, force = false, sessions: SessionInfo[] = []): Promise<Record<string, GitStats>> {
    const now = Date.now();
    if (!force
      && this.repoGitStatsLastRefresh > 0
      && now - this.repoGitStatsLastRefresh < StateManager.GIT_STATS_TTL_MS
      && !this.hasUnscopedSessionCwd(sessions, this.state.repoGitStats)) {
      return this.state.repoGitStats;
    }

    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const cwdSet = new Set(sessions.map(session => session.cwd));
    const allCwds = [...cwdSet]
      .filter(cwd => isSafeLocalCwd(cwd) && !isExcluded(projectKeysForCwd(cwd)));
    if (allCwds.length === 0) {
      this.repoGitStatsLastRefresh = now;
      return {};
    }
    const rawStats = await Promise.all(allCwds.map(cwd => this.getCachedGitStatsAsync(cwd)));
    const repoGitStats: Record<string, GitStats> = {};

    for (const stats of rawStats) {
      if (!stats?.gitCommonDir) continue;
      const repoKey = repoKeyFromGitStats(stats);
      if (!repoKey) continue;
      const preferred = preferGitStats(repoGitStats[repoKey], stats);
      if (preferred) repoGitStats[repoKey] = preferred;
    }

    this.repoGitStatsLastRefresh = now;
    return repoGitStats;
  }

  private hasUnscopedSessionCwd(sessions: SessionInfo[], repoGitStats: Record<string, GitStats>): boolean {
    if (sessions.length === 0) return false;
    return sessions.some(session => resolveSessionRepoKeys([session], repoGitStats).size === 0);
  }

  private buildCodeOutputStats(sessions: SessionInfo[], repoGitStats: Record<string, GitStats>): CodeOutputStats {
    const today = { commits: 0, added: 0, removed: 0 };
    const scopedRepoKeys = resolveSessionRepoKeys(sessions, repoGitStats);
    const repoStats = Object.entries(repoGitStats)
      .filter(([key, stats]) => {
        if (scopedRepoKeys.size === 0) return true;
        const repoKey = normalizeGitPathKey(key);
        const topLevelKey = normalizeGitPathKey(stats.toplevel);
        return (!!repoKey && scopedRepoKeys.has(repoKey)) || (!!topLevelKey && scopedRepoKeys.has(topLevelKey));
      })
      .map(([, stats]) => stats);
    let dailySources = repoStats;
    let repoCount = repoStats.length;
    let scopeLabel = repoStats.length > 0
      ? `Current session repos (${repoStats.length})`
      : 'Current session repos';

    if (repoStats.length > 0) {
      for (const stats of repoStats) {
        today.commits += stats.commitsToday;
        today.added += stats.linesAdded;
        today.removed += stats.linesRemoved;
      }
    } else {
      const seenToday = new Set<string>();
      const fallbackStats: GitStats[] = [];
      for (const session of sessions) {
        if (!session.gitStats) continue;
        const repoKey = repoKeyFromGitStats(session.gitStats) ?? normalizeGitCwdKey(session.cwd);
        if (seenToday.has(repoKey)) continue;
        seenToday.add(repoKey);
        today.commits += session.gitStats.commitsToday;
        today.added += session.gitStats.linesAdded;
        today.removed += session.gitStats.linesRemoved;
        fallbackStats.push(session.gitStats);
      }
      dailySources = fallbackStats;
      repoCount = fallbackStats.length;
      if (fallbackStats.length > 0) scopeLabel = `Current session repos (${fallbackStats.length})`;
    }

    const all = { commits: 0, added: 0, removed: 0 };
    for (const stats of repoStats) {
      all.commits += stats.totalCommits;
      all.added += stats.totalLinesAdded;
      all.removed += stats.totalLinesRemoved ?? 0;
    }

    return {
      today,
      all,
      daily7d: aggregateDailyStats(dailySources),
      dailyAll: aggregateDailyAllStats(dailySources),
      repoCount,
      scopeLabel,
    };
  }

  private attachCachedGitStats(sessions: SessionInfo[]): SessionInfo[] {
    let changed = false;
    const next = sessions.map(session => {
      const gitStats = this.peekCachedGitStats(session.cwd);
      if (gitStats === session.gitStats) return session;
      changed = true;
      return { ...session, gitStats };
    });
    return changed ? next : sessions;
  }

  private buildSessionInfo(
    s: DiscoveredSession,
    gitStats: GitStats | null = this.peekCachedGitStats(s.cwd),
    summaryOverride?: FileUsageSummary | null,
  ): SessionInfo {
    let modelName = '';
    let contextUsed = 0;
    let contextMax = 200_000;
    let toolCounts: Record<string, number> = {};
    let activityBreakdown: SessionInfo['activityBreakdown'] = null;
    let activityBreakdownKind: SessionInfo['activityBreakdownKind'] = null;

    const summary = summaryOverride !== undefined
      ? summaryOverride
      : (s.jsonlPath ? this.getSummary(s.jsonlPath) : null);
    if (summary) {
      const snapshot = summary.sessionSnapshot;
      modelName = snapshot.modelName;
      contextUsed = snapshot.latestInputTokens + snapshot.latestCacheCreationTokens + snapshot.latestCacheReadTokens;
      toolCounts = snapshot.toolCounts;
      activityBreakdown = snapshot.activityBreakdown;
      activityBreakdownKind = snapshot.activityBreakdownKind;

      const raw = snapshot.rawModel.toLowerCase();
      if (snapshot.contextMax && snapshot.contextMax > 0) contextMax = snapshot.contextMax;
      else if (raw.includes('1m') || raw.includes('1-000k')) contextMax = 1_000_000;
    }

    return { ...s, modelName, contextUsed, contextMax, toolCounts, gitStats, activityBreakdown, activityBreakdownKind };
  }

  private buildSessionInfoForJsonlPath(
    filePath: string,
    previousByKey = new Map(this.state.sessions.map(session => [this.sessionIdentityKey(session), session])),
    summaries: Map<string, FileUsageSummary> = this.summaries,
  ): SessionInfo | null {
    const normalized = normalizeFileKey(filePath);
    const summary = summaries.get(normalized);
    if (!summary) return null;

    const bootstrap = summary.provider === 'claude'
      ? this.buildStartupClaudeSession(normalized)
      : this.buildStartupCodexSession(normalized);
    if (!bootstrap) return null;

    const isExcluded = makeExcludedMatcher(this.getSettings().excludedProjects ?? []);
    if (isExcluded(this.sessionProjectKeys(bootstrap))) return null;

    const key = this.sessionIdentityKey(bootstrap);
    const previous = previousByKey.get(key);
    const next = this.buildSessionInfo(bootstrap, previous?.gitStats, summary);
    if (previous && this.isSameSessionInfo(previous, next)) return previous;
    return next;
  }

  private updateChangedSessionInfos(changedFiles: Set<string>): SessionBuildResult {
    const normalized = new Set([...changedFiles].map(file => normalizeFileKey(file)));
    const previousByKey = new Map(this.state.sessions.map(session => [this.sessionIdentityKey(session), session]));
    const previousSet = new Set(this.state.sessions);
    const matchedPaths = new Set<string>();
    const sessionsByKey = new Map<string, SessionInfo>();
    let discoveredCount = 0;

    for (const session of this.state.sessions) {
      if (!session.jsonlPath) {
        sessionsByKey.set(this.sessionIdentityKey(session), session);
        continue;
      }

      const fileKey = normalizeFileKey(session.jsonlPath);
      if (!normalized.has(fileKey)) {
        sessionsByKey.set(this.sessionIdentityKey(session), session);
        continue;
      }

      matchedPaths.add(fileKey);
      discoveredCount += 1;
      const lastModified = getJsonlMtime(session.jsonlPath) ?? session.lastModified;
      const next = this.buildSessionInfo({ ...session, lastModified }, session.gitStats);
      sessionsByKey.set(this.sessionIdentityKey(next), next);
    }

    for (const filePath of normalized) {
      if (matchedPaths.has(filePath)) continue;
      const next = this.buildSessionInfoForJsonlPath(filePath, previousByKey, this.summaries);
      if (!next) continue;
      discoveredCount += 1;
      sessionsByKey.set(this.sessionIdentityKey(next), next);
    }

    const sessions = [...sessionsByKey.values()].sort((a, b) => this.sessionSortValue(b) - this.sessionSortValue(a));
    return {
      sessions,
      discoveryScope: StateManager.SESSION_SCOPE,
      discoveredCount,
      dedupedCount: Math.max(0, discoveredCount - Math.max(0, sessions.length - this.state.sessions.length)),
      reusedCount: sessions.filter(session => previousSet.has(session)).length,
      sessionCountDelta: sessions.length - this.state.sessions.length,
    };
  }

  private refreshCachedSessionInfos(): SessionBuildResult {
    let changed = false;
    const next: SessionInfo[] = [];
    let reusedCount = 0;

    for (const session of this.state.sessions) {
      if (!session.jsonlPath) {
        next.push(session);
        reusedCount += 1;
        continue;
      }
      if (!fs.existsSync(session.jsonlPath)) {
        changed = true;
        continue;
      }

      const lastModified = getJsonlMtime(session.jsonlPath) ?? session.lastModified;
      const state = currentSessionState(session.provider, session.pid, lastModified);
      if (lastModified?.getTime() !== session.lastModified?.getTime() || state !== session.state) {
        changed = true;
        next.push({ ...session, lastModified, state });
      } else {
        next.push(session);
        reusedCount += 1;
      }
    }

    const sessions = changed ? next : this.state.sessions;
    return {
      sessions,
      discoveryScope: StateManager.SESSION_SCOPE,
      discoveredCount: sessions.length,
      dedupedCount: 0,
      reusedCount,
      sessionCountDelta: sessions.length - this.state.sessions.length,
    };
  }

  private buildSessionInfos(): SessionInfo[] {
    return this.buildScopedSessionInfosDetailed().sessions;
  }

  getState(): AppState {
    return this.state;
  }

  applySettingsChange() {
    const settings = this.getSettings();
    const providerChanged = settings.provider !== this.state.settings.provider;
    if (providerChanged) {
      this.summaries.clear();
      this.jsonlCache.clearAll();
      clearSessionMetadataCache();
      this.codexRateLimits = null;
      this.repoGitStatsLastRefresh = 0;
      this.startWatcher();
      this.clearHistoryWarmup();
      this.clearGitWarmup();
      void this.heavyRefresh(true);
      return;
    }

    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const sessions = this.state.sessions.filter(session => !isExcluded(this.sessionProjectKeys(session)));
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    this.state = { ...this.state, sessions, settings, codeOutputStats, codeOutputLoading: false, allTimeSessions: sessions.length, lastUpdated: Date.now() };
    this.onUpdate(this.state);
  }

  private async logMemorySnapshot(label: string, scannedFiles = 0): Promise<void> {
    const proc = process as NodeJS.Process & {
      defaultApp?: boolean;
      getProcessMemoryInfo?: () => Promise<{
        workingSetSize: number;
        private: number;
        shared: number;
      }>;
    };
    if (!this.isMemoryDebugEnabled()) return;
    if (!proc.getProcessMemoryInfo) return;

    try {
      const info = await proc.getProcessMemoryInfo() as unknown as {
        workingSetSize?: number;
        workingSet?: number;
        private: number;
        shared: number;
      };
      const workingSet = info.workingSetSize ?? info.workingSet ?? 0;
      const toMb = (kb: number) => Math.round((kb / 1024) * 10) / 10;
      const cacheStats = this.jsonlCache.getDebugStats();
      const watched = this.countWatchedPaths();
      console.info('[WhereMyTokens][memory]', {
        label,
        workingSetMB: toMb(workingSet),
        privateMB: toMb(info.private),
        sharedMB: toMb(info.shared),
        summaryCount: this.summaries.size,
        sessionCount: this.state.sessions.length,
        allTimeSessions: this.state.allTimeSessions,
        cacheSize: this.jsonlCache.size,
        cacheMemoryEntries: cacheStats.memoryEntries,
        cachePersistedEntries: cacheStats.persistedEntries,
        cachePendingPersistedEntries: cacheStats.pendingPersistedEntries,
        watcherProfile: this.watcherProfile,
        watcherTargets: this.watcherTargetCount,
        dirtyFiles: this.dirtySessionFiles.size,
        deferredFastFiles: this.deferredFastFiles.size,
        scannedFiles,
      });
      appendDebugMemoryLog('memory-snapshot', {
        label,
        electronProcessMemory: {
          workingSetMB: toMb(workingSet),
          privateMB: toMb(info.private),
          sharedMB: toMb(info.shared),
        },
        runtime: collectRuntimeMemorySnapshot(),
        collections: {
          summaries: this.summaries.size,
          sessions: this.state.sessions.length,
          repoGitStats: Object.keys(this.state.repoGitStats).length,
          gitStatsCache: this.gitStatsCache.size,
          dirtySessionFiles: this.dirtySessionFiles.size,
          deferredFastFiles: this.deferredFastFiles.size,
        },
        watcher: {
          profile: this.watcherProfile,
          targets: this.watcherTargetCount,
          watchedDirectories: watched.watchedDirectories,
          watchedFiles: watched.watchedFiles,
        },
        jsonlCache: cacheStats,
        scannedFiles,
      });
    } catch {
      // 메모리 로그 실패는 무시한다.
    }
  }
}
