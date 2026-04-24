import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { discoverSessions, DiscoveredSession, CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR, projectKeysForCwd } from './sessionDiscovery';
import { scanJsonlSummaryCached } from './jsonlParser';
import { JsonlCache } from './jsonlCache';
import { computeUsage, UsageData } from './usageWindows';
import { AppSettings, DEFAULT_SETTINGS } from './ipc';
import { fetchAutoLimits, fetchApiUsagePct, AutoLimits, ApiUsagePct, RateLimitedError } from './rateLimitFetcher';
import { checkAlerts } from './usageAlertManager';
import Store from 'electron-store';
import { BridgeWatcher, LiveSessionData } from './bridgeWatcher';
import { aggregateDailyAllStats, aggregateDailyStats, buildDaily7dWindow, getGitStatsAsync, GitDailyStats, GitStats } from './gitStatsCollector';
import { discoverAllProjectCwds } from './projectDiscovery';
import { isSafeLocalCwd } from './pathSafety';
import { clearSessionMetadataCache, invalidateSessionMetadataCache, readJsonlCwd } from './sessionMetadata';
import { normalizeGitCwdKey, normalizeGitPathKey, preferGitStats, repoKeyFromGitStats } from './gitStatsKeys';
import { ActivityBreakdown, ActivityBreakdownKind, FileUsageSummary, SessionSnapshot } from './jsonlTypes';

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
}

export type UsageLimitSource = 'api' | 'statusLine' | 'cache' | 'localLog';

export interface UsageLimitWindow {
  pct: number;
  resetMs: number;
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
  initialRefreshComplete: boolean;
  historyWarmupPending: boolean;
  lastUpdated: number;
  apiConnected: boolean;
  apiError?: string;
  bridgeActive: boolean;
  extraUsage: ApiUsagePct['extraUsage'];
  repoGitStats: Record<string, GitStats>;
  codeOutputStats: CodeOutputStats;
  codeOutputLoading: boolean;
  allTimeSessions: number;
}

const SESSIONS_DIR = CLAUDE_SESSIONS_DIR;
const PROJECTS_DIR = CLAUDE_PROJECTS_DIR;

function getJsonlMtime(filePath: string): Date | null {
  try { return fs.statSync(filePath).mtime; }
  catch { return null; }
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
  private apiConnected = false;
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
  private uiBusy = false;
  private repoGitStatsLastRefresh = 0;
  private static readonly API_MIN_INTERVAL_MS = 180_000;
  private static readonly GIT_STATS_TTL_MS = 600_000;
  private static readonly STARTUP_SCAN_BUDGET_MS = 4_000;
  private static readonly STARTUP_WARMUP_DELAY_MS = 30_000;
  private static readonly STARTUP_GIT_DELAY_MS = 20_000;

  constructor(store: Store<AppSettings>, onUpdate: (s: AppState) => void) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.state = this.emptyState();
    const cached = (this.store as unknown as Store<Record<string, unknown>>).get('_cachedApiPct', null) as (ApiUsagePct & { storedAt?: number }) | null;
    if (cached) {
      const elapsed = cached.storedAt ? Date.now() - cached.storedAt : Infinity;
      this.apiUsagePct = {
        ...cached,
        h5Pct: elapsed > cached.h5ResetMs ? 0 : cached.h5Pct,
        weekPct: elapsed > cached.weekResetMs ? 0 : cached.weekPct,
        soPct: elapsed > cached.soResetMs ? 0 : cached.soPct,
        h5ResetMs: Math.max(0, cached.h5ResetMs - elapsed),
        weekResetMs: Math.max(0, cached.weekResetMs - elapsed),
        soResetMs: Math.max(0, cached.soResetMs - elapsed),
        extraUsage: cached.extraUsage ?? null,
      };
    }

    this.bridgeWatcher = new BridgeWatcher((data) => {
      this.liveSession = data;
      const limits = this.buildLimits();
      this.state = { ...this.state, limits, bridgeActive: true, apiConnected: true };
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
        h5: { pct: 0, resetMs: 0, source: 'cache' },
        week: { pct: 0, resetMs: 0, source: 'cache' },
        so: { pct: 0, resetMs: 0, source: 'cache' },
        codexH5: { pct: 0, resetMs: 0, source: 'cache' },
        codexWeek: { pct: 0, resetMs: 0, source: 'cache' },
      },
      settings: this.getSettings(),
      autoLimits: null,
      initialRefreshComplete: false,
      historyWarmupPending: false,
      lastUpdated: 0,
      apiConnected: false,
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
    void Promise.all([this.refreshAutoLimits(), this.refreshApiUsagePct()])
      .then(() => {
        const limits = this.buildLimits();
        this.state = { ...this.state, limits, autoLimits: this.autoLimits, apiConnected: this.apiConnected, apiError: this.apiError };
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
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    if (this.historyWarmupTimer) clearTimeout(this.historyWarmupTimer);
    if (this.gitWarmupTimer) clearTimeout(this.gitWarmupTimer);
    this.watcher?.close();
    this.bridgeWatcher.stop();
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

  private async refreshAutoLimits(): Promise<void> {
    try {
      const result = await fetchAutoLimits();
      if (result) this.autoLimits = result;
    } catch { /* ignore */ }
  }

  private async refreshApiUsagePct(force = false): Promise<void> {
    const now = Date.now();
    const interval = Math.max(StateManager.API_MIN_INTERVAL_MS, this.apiBackoffMs);
    if (!force && now - this.lastApiCallMs < interval) return;
    this.lastApiCallMs = now;
    try {
      const result = await fetchApiUsagePct();
      if (result) {
        this.apiUsagePct = result;
        this.apiConnected = true;
        this.apiError = '';
        this.apiBackoffMs = 0;
        (this.store as unknown as Store<Record<string, unknown>>).set('_cachedApiPct', { ...result, storedAt: Date.now() });
      } else {
        this.apiConnected = false;
        this.apiError = 'no credentials';
      }
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.apiBackoffMs = Math.min(this.apiBackoffMs === 0 ? 120_000 : this.apiBackoffMs * 2, 600_000);
        this.apiError = `429 rate limited (retry in ${Math.round(this.apiBackoffMs / 60000)}m)`;
      } else {
        this.apiConnected = false;
        this.apiError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async forceRefresh(): Promise<void> {
    this.clearHistoryWarmup();
    this.clearGitWarmup();
    await this.refreshApiUsagePct(true);
    await this.heavyRefresh(true);
  }

  private startTimers() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    this.fastTimer = setInterval(() => { void this.fastRefresh(); }, 60_000);
    this.heavyTimer = setInterval(() => { void this.heavyRefresh(); }, 300_000);
  }

  private scheduleHistoryWarmup(delayMs = StateManager.STARTUP_WARMUP_DELAY_MS): void {
    if (this.historyWarmupTimer) clearTimeout(this.historyWarmupTimer);
    this.historyWarmupTimer = setTimeout(() => {
      this.historyWarmupTimer = null;
      void this.heavyRefresh();
    }, delayMs);
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
    const rl = this.liveSession?.rate_limits;
    const bridgeActive = !!(this.liveSession?._ts && now - this.liveSession._ts < 300_000);
    const h5ResetMs = this.apiUsagePct?.h5ResetMs
      ?? (bridgeActive && rl?.five_hour?.resets_at ? rl.five_hour.resets_at - now : 0);
    const weekResetMs = this.apiUsagePct?.weekResetMs
      ?? (bridgeActive && rl?.seven_day?.resets_at ? rl.seven_day.resets_at - now : 0);
    const codexResetMs = this.getCodexResetMs(now);
    const usage = computeUsage([...this.summaries.values()], effectiveLimits, {
      claude: { weekResetMs, h5ResetMs },
      codex: { weekResetMs: codexResetMs.week.resetMs, h5ResetMs: codexResetMs.h5.resetMs },
    });
    return {
      usage,
      limits: this.buildLimits(),
      bridgeActive,
      extraUsage: this.apiUsagePct?.extraUsage ?? null,
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

  private startWatcher() {
    this.watcher?.close();
    this.watcher = null;

    const provider = this.getSettings().provider ?? 'both';
    const watchTargets: string[] = [];

    if ((provider === 'claude' || provider === 'both') && fs.existsSync(SESSIONS_DIR)) {
      watchTargets.push(SESSIONS_DIR);
    }
    if ((provider === 'claude' || provider === 'both') && fs.existsSync(PROJECTS_DIR)) {
      watchTargets.push(PROJECTS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
    }
    if ((provider === 'codex' || provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
      watchTargets.push(CODEX_SESSIONS_DIR.replace(/\\/g, '/') + '/**/*.jsonl');
    }
    if (watchTargets.length === 0) return;

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
  }

  private async fastRefresh(changedFiles?: Set<string>) {
    if (this.uiBusy) {
      if (changedFiles) for (const file of changedFiles) this.deferredFastFiles.add(normalizeFileKey(file));
      return;
    }

    if (changedFiles && changedFiles.size > 0) {
      await this.refreshChangedSummaries(changedFiles);
    }

    const sessions = changedFiles && changedFiles.size > 0
      ? this.updateChangedSessionInfos(changedFiles)
      : this.buildSessionInfos();
    const settings = this.getSettings();
    const derived = this.computeDerivedUsage(settings);
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    this.state = {
      ...this.state,
      sessions,
      settings,
      usage: derived.usage,
      limits: derived.limits,
      bridgeActive: derived.bridgeActive,
      extraUsage: derived.extraUsage,
      codeOutputStats,
      codeOutputLoading: false,
      lastUpdated: Date.now(),
    };
    this.onUpdate(this.state);

    void this.refreshApiUsagePct().then(() => {
      const refreshed = this.computeDerivedUsage(settings);
      this.state = {
        ...this.state,
        usage: refreshed.usage,
        limits: refreshed.limits,
        apiConnected: this.apiConnected,
        apiError: this.apiError,
        bridgeActive: refreshed.bridgeActive,
        extraUsage: refreshed.extraUsage,
      };
      this.onUpdate(this.state);
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
      await this.refreshApiUsagePct(force);
      const initialRefreshDone = this.state.initialRefreshComplete;
      const loaded = await this.loadProviderSummaries(
        force,
        allowStartupBudget && !initialRefreshDone ? StateManager.STARTUP_SCAN_BUDGET_MS : null,
      );
      this.summaries = loaded.summaries;
      this.codexRateLimits = loaded.codexRateLimits;

      const settings = this.getSettings();
      const derived = this.computeDerivedUsage(settings);
      let sessions = this.buildSessionInfos();
      const partialCodeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
      const startupPartial = allowStartupBudget && !initialRefreshDone && loaded.partial;
      this.state = {
        sessions,
        usage: derived.usage,
        limits: derived.limits,
        settings,
        autoLimits: this.autoLimits,
        initialRefreshComplete: true,
        historyWarmupPending: startupPartial,
        lastUpdated: Date.now(),
        apiConnected: this.apiConnected,
        apiError: this.apiError,
        bridgeActive: derived.bridgeActive,
        extraUsage: derived.extraUsage,
        repoGitStats: this.state.repoGitStats,
        codeOutputStats: partialCodeOutputStats,
        codeOutputLoading: true,
        allTimeSessions: loaded.sessionCount,
      };
      this.onUpdate(this.state);

      if (startupPartial) {
        this.scheduleHistoryWarmup();
      } else {
        this.clearHistoryWarmup();
      }
      if (!initialRefreshDone && !force) {
        this.scheduleGitWarmup();
        checkAlerts(derived.limits, settings.alertThresholds, settings.enableAlerts, settings.provider);
        await this.logMemorySnapshot('heavyRefresh:end', loaded.scannedFiles);
        return;
      }
      this.clearGitWarmup();

      const repoGitStats = await this.getRepoGitStats(settings, force, sessions);
      sessions = this.attachCachedGitStats(sessions);
      const codeOutputStats = this.buildCodeOutputStats(sessions, repoGitStats);

      this.state = {
        sessions,
        usage: derived.usage,
        limits: derived.limits,
        settings,
        autoLimits: this.autoLimits,
        initialRefreshComplete: true,
        historyWarmupPending: startupPartial,
        lastUpdated: Date.now(),
        apiConnected: this.apiConnected,
        apiError: this.apiError,
        bridgeActive: derived.bridgeActive,
        extraUsage: derived.extraUsage,
        repoGitStats,
        codeOutputStats,
        codeOutputLoading: false,
        allTimeSessions: loaded.sessionCount,
      };
      this.onUpdate(this.state);

      checkAlerts(derived.limits, settings.alertThresholds, settings.enableAlerts, settings.provider);
      await this.logMemorySnapshot('heavyRefresh:end', loaded.scannedFiles);
    } finally {
      this.heavyInFlight = false;
      if (this.heavyPending && !this.uiBusy) {
        this.heavyPending = false;
        void this.heavyRefresh();
      }
    }
  }

  private buildLimits(): UsageLimits {
    const now = Date.now();
    const codexResetMs = this.getCodexResetMs(now);
    const codexH5 = codexResetMs.h5;
    const codexWeek = codexResetMs.week;

    if (this.apiUsagePct) {
      const source: UsageLimitSource = this.apiConnected ? 'api' : 'cache';
      return {
        h5: { pct: this.apiUsagePct.h5Pct, resetMs: this.apiUsagePct.h5ResetMs, source },
        week: { pct: this.apiUsagePct.weekPct, resetMs: this.apiUsagePct.weekResetMs, source },
        so: { pct: this.apiUsagePct.soPct, resetMs: this.apiUsagePct.soResetMs, source },
        codexH5,
        codexWeek,
      };
    }

    const rl = this.liveSession?.rate_limits;
    if (rl && this.liveSession?._ts && now - this.liveSession._ts < 300_000) {
      return {
        h5: { pct: rl.five_hour?.used_percentage ?? 0, resetMs: rl.five_hour?.resets_at ? rl.five_hour.resets_at - now : 0, source: 'statusLine' },
        week: { pct: rl.seven_day?.used_percentage ?? 0, resetMs: rl.seven_day?.resets_at ? rl.seven_day.resets_at - now : 0, source: 'statusLine' },
        so: { pct: 0, resetMs: 0, source: 'statusLine' },
        codexH5,
        codexWeek,
      };
    }

    const previous = this.state?.limits ?? {
      h5: { pct: 0, resetMs: 0 },
      week: { pct: 0, resetMs: 0 },
      so: { pct: 0, resetMs: 0 },
      codexH5,
      codexWeek,
    };
    return {
      h5: { ...previous.h5, source: 'cache' },
      week: { ...previous.week, source: 'cache' },
      so: { ...previous.so, source: 'cache' },
      codexH5,
      codexWeek,
    };
  }

  private getCodexResetMs(now: number): { h5: UsageLimitWindow; week: UsageLimitWindow } {
    const previousH5 = this.state?.limits.codexH5 ?? { pct: 0, resetMs: 0, source: 'cache' as UsageLimitSource };
    const previousWeek = this.state?.limits.codexWeek ?? { pct: 0, resetMs: 0, source: 'cache' as UsageLimitSource };
    return {
      h5: this.codexRateLimits?.h5
        ? { pct: this.codexRateLimits.h5.pct, resetMs: Math.max(0, this.codexRateLimits.h5.resetsAt * 1000 - now), source: 'localLog' }
        : { ...previousH5, source: previousH5.source ?? 'cache' },
      week: this.codexRateLimits?.week
        ? { pct: this.codexRateLimits.week.pct, resetMs: Math.max(0, this.codexRateLimits.week.resetsAt * 1000 - now), source: 'localLog' }
        : { ...previousWeek, source: previousWeek.source ?? 'cache' },
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

  private collectCodexRateLimits(): SessionSnapshot['codexRateLimits'] | null {
    let merged: SessionSnapshot['codexRateLimits'] | null = null;
    for (const summary of this.summaries.values()) {
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
    const summaries = new Map<string, FileUsageSummary>();
    let sessionCount = 0;
    let codexRateLimits: SessionSnapshot['codexRateLimits'] | null = null;
    let scannedFiles = 0;
    let partial = false;
    const startedAt = Date.now();
    const discovered = discoverSessions(settings.provider);
    const startupPriority = new Set(
      discovered
        .map(session => session.jsonlPath)
        .filter((filePath): filePath is string => !!filePath)
        .map(filePath => normalizeFileKey(filePath))
    );

    const shouldStopForBudget = () => budgetMs !== null && Date.now() - startedAt >= budgetMs;
    const shouldPrioritize = (filePath: string) => startupPriority.has(normalizeFileKey(filePath));

    const scanSummary = async (filePath: string, provider: 'claude' | 'codex'): Promise<FileUsageSummary | null> => {
      try {
        const normalizedPath = normalizeFileKey(filePath);
        if (!force && budgetMs !== null) {
          const cached = this.summaries.get(normalizedPath) ?? this.jsonlCache.get(filePath);
          if (cached) return cached;
          if (!shouldPrioritize(filePath) && shouldStopForBudget()) {
            partial = true;
            return null;
          }
        }

        const stat = fs.statSync(filePath);
        if (!force) {
          const fresh = this.jsonlCache.getFresh(filePath, stat.mtimeMs, stat.size);
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
      try {
        const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const dir of projectDirs) {
          const dirPath = path.join(PROJECTS_DIR, dir);
          try {
            const files = fs.readdirSync(dirPath)
              .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
              .sort((a, b) => Number(shouldPrioritize(path.join(dirPath, b))) - Number(shouldPrioritize(path.join(dirPath, a))));
            if (budgetMs !== null && shouldStopForBudget() && !files.some(file => shouldPrioritize(path.join(dirPath, file)))) {
              partial = true;
              continue;
            }
            const cwd = files.length > 0 ? readJsonlCwd(path.join(dirPath, files[0]), 'claude') : null;
            if (isExcluded([dir, ...(cwd ? projectKeysForCwd(cwd) : [])])) continue;
            sessionCount += files.length;
            for (const file of files) {
              const filePath = path.join(dirPath, file);
              if (budgetMs !== null && shouldStopForBudget() && !shouldPrioritize(filePath)) {
                partial = true;
                continue;
              }
              const summary = await scanSummary(filePath, 'claude');
              if (summary) summaries.set(normalizeFileKey(filePath), summary);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    if ((settings.provider === 'codex' || settings.provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
      const codexFiles = this.listJsonlFiles(CODEX_SESSIONS_DIR)
        .sort((a, b) => Number(shouldPrioritize(b)) - Number(shouldPrioritize(a)));
      for (const filePath of codexFiles) {
        if (budgetMs !== null && shouldStopForBudget() && !shouldPrioritize(filePath)) {
          partial = true;
          continue;
        }
        const cwd = readJsonlCwd(filePath, 'codex');
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
    this.codexRateLimits = this.collectCodexRateLimits();
  }

  private providerForJsonlPath(filePath: string): 'claude' | 'codex' | null {
    const normalized = normalizeFileKey(filePath);
    if (normalized.startsWith(normalizeFileKey(PROJECTS_DIR))) return 'claude';
    if (normalized.startsWith(normalizeFileKey(CODEX_SESSIONS_DIR))) return 'codex';
    return null;
  }

  private listJsonlFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...this.listJsonlFiles(fullPath));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
      }
    } catch { /* skip */ }
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
    const cwdSet = new Set(discoverAllProjectCwds(settings.provider));
    for (const session of sessions) cwdSet.add(session.cwd);
    const allCwds = [...cwdSet]
      .filter(cwd => isSafeLocalCwd(cwd) && !isExcluded(projectKeysForCwd(cwd)));
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

  private buildSessionInfo(s: DiscoveredSession, gitStats: GitStats | null = this.peekCachedGitStats(s.cwd)): SessionInfo {
    let modelName = '';
    let contextUsed = 0;
    let contextMax = 200_000;
    let toolCounts: Record<string, number> = {};
    let activityBreakdown: SessionInfo['activityBreakdown'] = null;
    let activityBreakdownKind: SessionInfo['activityBreakdownKind'] = null;

    if (s.jsonlPath) {
      const summary = this.getSummary(s.jsonlPath);
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
    }

    return { ...s, modelName, contextUsed, contextMax, toolCounts, gitStats, activityBreakdown, activityBreakdownKind };
  }

  private updateChangedSessionInfos(changedFiles: Set<string>): SessionInfo[] {
    const normalized = new Set([...changedFiles].map(file => normalizeFileKey(file)));
    let matched = false;
    const sessions = this.state.sessions.map(session => {
      if (!session.jsonlPath || !normalized.has(normalizeFileKey(session.jsonlPath))) return session;
      matched = true;
      const lastModified = getJsonlMtime(session.jsonlPath) ?? session.lastModified;
      return this.buildSessionInfo({ ...session, lastModified }, session.gitStats);
    });
    return matched ? sessions : this.buildSessionInfos();
  }

  private buildSessionInfos(): SessionInfo[] {
    const settings = this.getSettings();
    const isExcluded = makeExcludedMatcher(settings.excludedProjects ?? []);
    const discovered = discoverSessions(settings.provider).filter(session => !isExcluded(this.sessionProjectKeys(session)));
    return discovered.map(session => this.buildSessionInfo(session));
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
    this.state = { ...this.state, sessions, settings, codeOutputStats, codeOutputLoading: false, lastUpdated: Date.now() };
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
    if (!proc.defaultApp && process.env.WMT_DEBUG_MEMORY !== '1') return;
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
      console.info('[WhereMyTokens][memory]', {
        label,
        workingSetMB: toMb(workingSet),
        privateMB: toMb(info.private),
        sharedMB: toMb(info.shared),
        summaryCount: this.summaries.size,
        cacheSize: this.jsonlCache.size,
        scannedFiles,
      });
    } catch {
      // 메모리 로그 실패는 무시한다.
    }
  }
}
