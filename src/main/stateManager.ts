import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar from 'chokidar';
import { discoverSessions, DiscoveredSession, TrackingProvider, CLAUDE_PROJECTS_DIR, CLAUDE_SESSIONS_DIR, CODEX_SESSIONS_DIR } from './sessionDiscovery';
import { parseJsonlFile, parseJsonlCached, parseCodexJsonlCached, ParsedEntry, ActivityBreakdown, ActivityBreakdownKind, ParsedFile } from './jsonlParser';
import { JsonlCache } from './jsonlCache';
import { computeUsage, UsageData } from './usageWindows';
import { AppSettings, DEFAULT_SETTINGS } from './ipc';
import { fetchAutoLimits, fetchApiUsagePct, AutoLimits, ApiUsagePct, RateLimitedError } from './rateLimitFetcher';
import { checkAlerts } from './usageAlertManager';
import Store from 'electron-store';
import { BridgeWatcher, LiveSessionData } from './bridgeWatcher';
import { getGitStatsAsync, GitStats, getAllPersistedStatsByRepo } from './gitStatsCollector';
import { discoverAllProjectCwds } from './projectDiscovery';

export interface SessionInfo extends DiscoveredSession {
  modelName: string;
  contextUsed: number;    // tokens
  contextMax: number;     // tokens
  toolCounts: Record<string, number>;
  gitStats: GitStats | null;
  activityBreakdown: ActivityBreakdown | null;
  activityBreakdownKind: ActivityBreakdownKind | null;
}

export interface CodeOutputStats {
  today: { commits: number; added: number; removed: number };
  all: { commits: number; added: number; removed: number };
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
  lastUpdated: number;
  apiConnected: boolean;
  apiError?: string;      // last API error message for debugging
  bridgeActive: boolean;  // whether the Claude Code statusLine bridge is connected
  extraUsage: ApiUsagePct['extraUsage'];
  repoGitStats: Record<string, GitStats>;  // gitCommonDir → GitStats (세션 유무 무관 전체 repo)
  codeOutputStats: CodeOutputStats;
  allTimeSessions: number;
}

const SESSIONS_DIR = CLAUDE_SESSIONS_DIR;
const PROJECTS_DIR = CLAUDE_PROJECTS_DIR;

function getJsonlMtime(filePath: string): Date | null {
  try { return fs.statSync(filePath).mtime; }
  catch { return null; }
}

function gitStatsCacheKey(cwd: string): string {
  const key = path.resolve(cwd);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

export class StateManager {
  private store: Store<AppSettings>;
  private allEntries: ParsedEntry[] = [];
  private state: AppState;
  private fastTimer: NodeJS.Timeout | null = null;
  private heavyTimer: NodeJS.Timeout | null = null;
  private autoLimitTimer: NodeJS.Timeout | null = null;
  private watcher: chokidar.FSWatcher | null = null;
  private fastDebounce: NodeJS.Timeout | null = null;
  private heavyDebounce: NodeJS.Timeout | null = null;
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
  private codexRateLimits: ParsedFile['codexRateLimits'] | null = null;
  private gitStatsCache = new Map<string, { stats: GitStats | null; ts: number }>();
  private dirtySessionFiles = new Set<string>();
  private deferredFastFiles = new Set<string>();
  private heavyInFlight = false;
  private heavyPending = false;
  private uiBusy = false;
  private repoGitStatsLastRefresh = 0;
  private static readonly API_MIN_INTERVAL_MS = 180_000; // 3분 간격 (429 방지)

  private static readonly GIT_STATS_TTL_MS = 600_000;

  constructor(store: Store<AppSettings>, onUpdate: (s: AppState) => void) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.state = this.emptyState();
    // 재시작 후에도 마지막 성공값 유지 — storedAt 기준으로 만료된 창은 pct/resetMs 보정
    const cached = (this.store as unknown as Store<Record<string, unknown>>).get('_cachedApiPct', null) as (ApiUsagePct & { storedAt?: number }) | null;
    if (cached) {
      const elapsed = cached.storedAt ? Date.now() - cached.storedAt : Infinity;
      this.apiUsagePct = {
        ...cached,
        // 저장 당시 resetMs보다 더 많은 시간이 지났으면 해당 창은 이미 리셋됨
        h5Pct:    elapsed > cached.h5ResetMs   ? 0 : cached.h5Pct,
        weekPct:  elapsed > cached.weekResetMs ? 0 : cached.weekPct,
        soPct:    elapsed > cached.soResetMs   ? 0 : cached.soPct,
        // resetMs도 현재 기준으로 보정 (음수 방지)
        h5ResetMs:   Math.max(0, cached.h5ResetMs   - elapsed),
        weekResetMs: Math.max(0, cached.weekResetMs - elapsed),
        soResetMs:   Math.max(0, cached.soResetMs   - elapsed),
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
        h5: this.emptyWindow(), week: this.emptyWindow(),
        h5Codex: this.emptyWindow(), weekCodex: this.emptyWindow(),
        models: [], heatmap: [], heatmap30: [], heatmap90: [], weeklyTimeline: [],
        todayTokens: 0, todayCost: 0, todayRequestCount: 0,
        todayInputTokens: 0, todayOutputTokens: 0, todayCacheTokens: 0,
        allTimeRequestCount: 0, allTimeCost: 0, allTimeCacheTokens: 0,
        allTimeInputTokens: 0, allTimeOutputTokens: 0,
        allTimeSavedUSD: 0, allTimeAvgCacheEfficiency: 0,
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
      lastUpdated: 0,
      apiConnected: false,
      bridgeActive: false,
      extraUsage: null,
      repoGitStats: {},
      codeOutputStats: this.emptyCodeOutputStats(),
      allTimeSessions: 0,
    };
  }

  private emptyWindow() {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0 };
  }

  private emptyCodeOutputStats(): CodeOutputStats {
    return {
      today: { commits: 0, added: 0, removed: 0 },
      all: { commits: 0, added: 0, removed: 0 },
    };
  }

  start() {
    this.bridgeWatcher.start();
    // Parse JSONL immediately so UI shows data right away
    void this.heavyRefresh();
    this.startTimers();
    this.startWatcher();
    // Fetch API limits in background — non-blocking, updates limits when ready
    void Promise.all([this.refreshAutoLimits(), this.refreshApiUsagePct()])
      .then(() => {
        const limits = this.buildLimits();
        this.state = { ...this.state, limits, autoLimits: this.autoLimits, apiConnected: this.apiConnected, apiError: this.apiError };
        this.onUpdate(this.state);
      });
    // Refresh autoLimits every 5 minutes
    this.autoLimitTimer = setInterval(() => {
      this.refreshAutoLimits();
    }, 5 * 60 * 1000);
  }

  stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    if (this.autoLimitTimer) clearInterval(this.autoLimitTimer);
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    if (this.heavyDebounce) clearTimeout(this.heavyDebounce);
    this.watcher?.close();
    this.bridgeWatcher.stop();
  }

  setUiBusy(busy: boolean): void {
    this.uiBusy = busy;
    if (busy) return;
    if (this.deferredFastFiles.size > 0) {
      const files = new Set(this.deferredFastFiles);
      this.deferredFastFiles.clear();
      this.fastRefresh(files);
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
        // 마지막 성공값 캐시 — 재시작/429 시에도 표시 (storedAt으로 만료 감지)
        (this.store as unknown as Store<Record<string, unknown>>).set('_cachedApiPct', { ...result, storedAt: Date.now() });
      } else {
        this.apiConnected = false;
        this.apiError = 'no credentials';
      }
    } catch (e) {
      if (e instanceof RateLimitedError) {
        this.apiBackoffMs = Math.min(
          this.apiBackoffMs === 0 ? 120_000 : this.apiBackoffMs * 2,
          600_000
        );
        this.apiError = `429 rate limited (retry in ${Math.round(this.apiBackoffMs / 60000)}m)`;
      } else {
        this.apiConnected = false;
        this.apiError = e instanceof Error ? e.message : String(e);
      }
    }
  }

  // Renderer refresh button → immediate API + JSONL re-parse
  async forceRefresh(): Promise<void> {
    await this.refreshApiUsagePct(true);
    await this.heavyRefresh(true);
  }

  private startTimers() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);

    this.fastTimer = setInterval(() => this.fastRefresh(), 60_000);
    this.heavyTimer = setInterval(() => { void this.heavyRefresh(); }, 300_000);
  }

  // 디바운스된 heavyRefresh — 연속 JSONL 변경 시 최소 3초 대기
  private debouncedHeavyRefresh() {
    if (this.heavyDebounce) clearTimeout(this.heavyDebounce);
    this.heavyDebounce = setTimeout(() => {
      this.heavyDebounce = null;
      void this.heavyRefresh();
    }, 8000);
  }

  private debouncedFastRefresh(filePath?: string) {
    if (filePath) this.dirtySessionFiles.add(path.normalize(filePath));
    if (this.fastDebounce) clearTimeout(this.fastDebounce);
    this.fastDebounce = setTimeout(() => {
      this.fastDebounce = null;
      const files = this.dirtySessionFiles.size > 0 ? new Set(this.dirtySessionFiles) : undefined;
      this.dirtySessionFiles.clear();
      this.fastRefresh(files);
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
        this.debouncedHeavyRefresh();
      }
      else this.fastRefresh();
    });
    this.watcher.on('unlink', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) this.jsonlCache.invalidate(filePath);
      this.debouncedFastRefresh();
    });

    // Watch for JSONL changes — 디바운스 적용
    // Windows에서 path.join이 백슬래시를 사용하면 chokidar glob이 동작하지 않으므로 슬래시로 변환
    this.watcher.on('change', (filePath: string) => {
      this.debouncedFastRefresh(filePath);
      this.debouncedHeavyRefresh();
    });
  }

  private fastRefresh(changedFiles?: Set<string>) {
    if (this.uiBusy) {
      if (changedFiles) for (const file of changedFiles) this.deferredFastFiles.add(path.normalize(file));
      return;
    }
    const sessions = changedFiles && changedFiles.size > 0
      ? this.updateChangedSessionInfos(changedFiles)
      : this.buildSessionInfos();
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    this.state = { ...this.state, sessions, codeOutputStats, lastUpdated: Date.now() };
    this.onUpdate(this.state);
    // Also refresh usage limit API periodically (independent of heavyRefresh)
    void this.refreshApiUsagePct().then(() => {
      const limits = this.buildLimits();
      const bridgeActive = !!(this.liveSession?._ts && Date.now() - this.liveSession._ts < 300_000);
      const extraUsage = this.apiUsagePct?.extraUsage ?? null;
      this.state = { ...this.state, limits, apiConnected: this.apiConnected, apiError: this.apiError, bridgeActive, extraUsage };
      this.onUpdate(this.state);
    });
  }

  private async heavyRefresh(force = false) {
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
      await this.refreshApiUsagePct(force);
      const loaded = this.loadProviderEntries();
      this.allEntries = loaded.entries;
      this.codexRateLimits = loaded.codexRateLimits;

      const settings = this.getSettings();
      const effectiveLimits = this.autoLimits
        ? { h5: this.autoLimits.h5, week: this.autoLimits.week, sonnetWeek: this.autoLimits.sonnetWeek }
        : settings.usageLimits;
      // API 기준으로 각 창의 실제 시작 시각 역산 (API 우선, bridge fallback, calendar 최후)
      const now = Date.now();
      const rl = this.liveSession?.rate_limits;
      const bridgeActive = !!(this.liveSession?._ts && now - this.liveSession._ts < 300_000);
      const h5ResetMs = this.apiUsagePct?.h5ResetMs
        ?? (bridgeActive && rl?.five_hour?.resets_at ? rl.five_hour.resets_at - now : 0);
      const weekResetMs = this.apiUsagePct?.weekResetMs
        ?? (bridgeActive && rl?.seven_day?.resets_at ? rl.seven_day.resets_at - now : 0);
      const codexResetMs = this.getCodexResetMs(now);
      const usage = computeUsage(this.allEntries, effectiveLimits, {
        claude: { weekResetMs, h5ResetMs },
        codex: { weekResetMs: codexResetMs.week.resetMs, h5ResetMs: codexResetMs.h5.resetMs },
      });
      const limits = this.buildLimits();
      let sessions = this.buildSessionInfos();
      const extraUsage = this.apiUsagePct?.extraUsage ?? null;
      const repoGitStats = await this.getRepoGitStats(settings, force);
      sessions = this.attachCachedGitStats(sessions);
      const codeOutputStats = this.buildCodeOutputStats(sessions, repoGitStats);

      this.state = { sessions, usage, limits, settings, autoLimits: this.autoLimits, lastUpdated: Date.now(), apiConnected: this.apiConnected, apiError: this.apiError, bridgeActive, extraUsage, repoGitStats, codeOutputStats, allTimeSessions: loaded.sessionCount };
      this.onUpdate(this.state);

      checkAlerts(limits, settings.alertThresholds, settings.enableAlerts, settings.provider);
    } finally {
      this.heavyInFlight = false;
      if (this.heavyPending && !this.uiBusy) {
        this.heavyPending = false;
        void this.heavyRefresh();
      }
    }
  }

  /** API 데이터 항상 우선 (서버 권위값); API 없을 때만 bridge fallback */
  private buildLimits(): UsageLimits {
    const now = Date.now();
    const codexResetMs = this.getCodexResetMs(now);
    const codexH5 = codexResetMs.h5;
    const codexWeek = codexResetMs.week;

    // API 데이터가 있으면 항상 우선 — 웹 대시보드와 동일한 서버 권위값
    if (this.apiUsagePct) {
      const source: UsageLimitSource = this.apiConnected ? 'api' : 'cache';
      return {
        h5:   { pct: this.apiUsagePct.h5Pct,   resetMs: this.apiUsagePct.h5ResetMs, source },
        week: { pct: this.apiUsagePct.weekPct,  resetMs: this.apiUsagePct.weekResetMs, source },
        so:   { pct: this.apiUsagePct.soPct,    resetMs: this.apiUsagePct.soResetMs, source },
        codexH5,
        codexWeek,
      };
    }

    // API 없을 때만 bridge fallback (5분 이내 신선한 데이터)
    // bridge는 Claude Code 요청 시에만 갱신되므로 리셋 후 stale해질 수 있음
    const rl = this.liveSession?.rate_limits;
    if (rl && this.liveSession?._ts && now - this.liveSession._ts < 300_000) {
      return {
        h5:   { pct: rl.five_hour?.used_percentage ?? 0, resetMs: rl.five_hour?.resets_at  ? rl.five_hour.resets_at  - now : 0, source: 'statusLine' },
        week: { pct: rl.seven_day?.used_percentage  ?? 0, resetMs: rl.seven_day?.resets_at ? rl.seven_day.resets_at  - now : 0, source: 'statusLine' },
        so:   { pct: 0, resetMs: 0, source: 'statusLine' },
        codexH5,
        codexWeek,
      };
    }

    // 모두 없으면 이전 상태 유지 (재시작/오프라인 시 0 대신 마지막 값 표시)
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
    current: ParsedFile['codexRateLimits'] | null,
    next: ParsedFile['codexRateLimits'] | undefined,
  ): ParsedFile['codexRateLimits'] | null {
    if (!next?.h5 && !next?.week) return current;
    const merged: ParsedFile['codexRateLimits'] = { ...(current ?? {}) };
    if (next.h5 && (!merged.h5 || next.h5.observedAt >= merged.h5.observedAt)) merged.h5 = next.h5;
    if (next.week && (!merged.week || next.week.observedAt >= merged.week.observedAt)) merged.week = next.week;
    return merged;
  }

  private loadAllEntries(): { entries: ParsedEntry[]; sessionCount: number } {
    const entries: ParsedEntry[] = [];
    if (!fs.existsSync(PROJECTS_DIR)) return { entries, sessionCount: 0 };

    const settings = this.getSettings();
    const excluded = new Set(settings.excludedProjects ?? []);
    // requestId → entries 배열 인덱스 (동일 ID 중 outputTokens 최대값 보존)
    const seen = new Map<string, number>();
    let sessionCount = 0;
    try {
      const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of projectDirs) {
        if (excluded.has(dir)) continue; // excluded from tracking
        const dirPath = path.join(PROJECTS_DIR, dir);
        try {
          // agent- 접두사 파일 제외 (서브에이전트 세션 — 중복 계산 방지)
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
          sessionCount += files.length;
          for (const file of files) {
            const parsed = parseJsonlCached(path.join(dirPath, file), this.jsonlCache);
            for (const e of parsed.entries) {
              const prevIdx = seen.get(e.requestId);
              if (prevIdx === undefined) {
                // 첫 등장 — 추가
                seen.set(e.requestId, entries.length);
                entries.push(e);
              } else if (e.outputTokens > entries[prevIdx].outputTokens) {
                // 동일 requestId에서 outputTokens가 더 큰 엔트리(최종 청크)로 교체
                // → 파일 읽기 순서에 무관하게 항상 동일 결과 보장
                entries[prevIdx] = e;
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return { entries, sessionCount };
  }

  private loadProviderEntries(): { entries: ParsedEntry[]; sessionCount: number; codexRateLimits: ParsedFile['codexRateLimits'] | null } {
    const settings = this.getSettings();
    const entries: ParsedEntry[] = [];
    const excluded = new Set(settings.excludedProjects ?? []);
    const seen = new Map<string, number>();
    let sessionCount = 0;
    let codexRateLimits: ParsedFile['codexRateLimits'] | null = null;

    const addEntries = (parsed: ParsedFile) => {
      for (const e of parsed.entries) {
        const prevIdx = seen.get(e.requestId);
        if (prevIdx === undefined) {
          seen.set(e.requestId, entries.length);
          entries.push(e);
        } else if (e.outputTokens > entries[prevIdx].outputTokens) {
          entries[prevIdx] = e;
        }
      }
    };

    if ((settings.provider === 'claude' || settings.provider === 'both') && fs.existsSync(PROJECTS_DIR)) {
      try {
        const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);

        for (const dir of projectDirs) {
          if (excluded.has(dir)) continue;
          const dirPath = path.join(PROJECTS_DIR, dir);
          try {
            const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
            sessionCount += files.length;
            for (const file of files) addEntries(parseJsonlCached(path.join(dirPath, file), this.jsonlCache));
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    if ((settings.provider === 'codex' || settings.provider === 'both') && fs.existsSync(CODEX_SESSIONS_DIR)) {
      for (const filePath of this.listJsonlFiles(CODEX_SESSIONS_DIR)) {
        const parsed = parseCodexJsonlCached(filePath, this.jsonlCache);
        if (parsed.entries.length === 0 && !parsed.codexRateLimits) continue;
        sessionCount += 1;
        codexRateLimits = this.mergeCodexRateLimits(codexRateLimits, parsed.codexRateLimits);
        addEntries(parsed);
      }
    }

    return { entries, sessionCount, codexRateLimits };
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

  private async getRepoGitStats(settings: AppSettings, force = false): Promise<Record<string, GitStats>> {
    const now = Date.now();
    if (!force && this.repoGitStatsLastRefresh > 0 && now - this.repoGitStatsLastRefresh < StateManager.GIT_STATS_TTL_MS) {
      return this.state.repoGitStats;
    }

    const allCwds = discoverAllProjectCwds(settings.provider);
    const rawStats = await Promise.all(allCwds.map(cwd => this.getCachedGitStatsAsync(cwd)));
    const repoGitStats: Record<string, GitStats> = {};

    for (const stats of rawStats) {
      if (!stats?.gitCommonDir) continue;
      if (repoGitStats[stats.gitCommonDir]) continue;
      repoGitStats[stats.gitCommonDir] = stats;
    }

    const persisted = getAllPersistedStatsByRepo();
    for (const [gitCommonDir, stats] of Object.entries(persisted)) {
      if (!repoGitStats[gitCommonDir]) repoGitStats[gitCommonDir] = stats;
    }

    this.repoGitStatsLastRefresh = now;
    return repoGitStats;
  }

  private buildCodeOutputStats(sessions: SessionInfo[], repoGitStats: Record<string, GitStats>): CodeOutputStats {
    const today = { commits: 0, added: 0, removed: 0 };

    const repoStats = Object.values(repoGitStats);
    if (repoStats.length > 0) {
      for (const stats of repoStats) {
        today.commits += stats.commitsToday;
        today.added += stats.linesAdded;
        today.removed += stats.linesRemoved;
      }
    } else {
      const seenToday = new Set<string>();
      for (const s of sessions) {
        if (!s.gitStats) continue;
        const repoKey = s.gitStats.gitCommonDir ?? s.gitStats.toplevel ?? s.cwd;
        if (seenToday.has(repoKey)) continue;
        seenToday.add(repoKey);
        today.commits += s.gitStats.commitsToday;
        today.added += s.gitStats.linesAdded;
        today.removed += s.gitStats.linesRemoved;
      }
    }

    const all = { commits: 0, added: 0, removed: 0 };
    for (const stats of repoStats) {
      all.commits += stats.totalCommits;
      all.added += stats.totalLinesAdded;
      all.removed += stats.totalLinesRemoved ?? 0;
    }

    return { today, all };
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
      try {
        const parsed = s.provider === 'codex'
          ? parseCodexJsonlCached(s.jsonlPath, this.jsonlCache)
          : parseJsonlCached(s.jsonlPath, this.jsonlCache);
        modelName = parsed.modelName;
        contextUsed = parsed.latestInputTokens + parsed.latestCacheCreationTokens + parsed.latestCacheReadTokens;
        toolCounts = parsed.toolCounts;
        activityBreakdown = parsed.activityBreakdown;
        activityBreakdownKind = parsed.activityBreakdownKind;

        const raw = parsed.rawModel.toLowerCase();
        if (parsed.contextMax && parsed.contextMax > 0) contextMax = parsed.contextMax;
        else if (raw.includes('1m') || raw.includes('1-000k')) contextMax = 1_000_000;
      } catch { /* skip */ }
    }

    return { ...s, modelName, contextUsed, contextMax, toolCounts, gitStats, activityBreakdown, activityBreakdownKind };
  }

  private updateChangedSessionInfos(changedFiles: Set<string>): SessionInfo[] {
    const normalized = new Set([...changedFiles].map(file => path.normalize(file)));
    let matched = false;
    const sessions = this.state.sessions.map(session => {
      if (!session.jsonlPath || !normalized.has(path.normalize(session.jsonlPath))) return session;
      matched = true;
      const lastModified = getJsonlMtime(session.jsonlPath) ?? session.lastModified;
      return this.buildSessionInfo({ ...session, lastModified }, session.gitStats);
    });
    return matched ? sessions : this.buildSessionInfos();
  }

  private buildSessionInfos(): SessionInfo[] {
    const settings = this.getSettings();
    const excluded = new Set(settings.excludedProjects ?? []);
    const discovered = discoverSessions(settings.provider).filter(s => {
      const key = s.mainRepoName ?? s.projectName;
      return !excluded.has(key) && !excluded.has(s.projectName);
    });
    return discovered.map(s => this.buildSessionInfo(s));
  }

  getState(): AppState {
    return this.state;
  }

  // Instant settings update: filters cached sessions without re-parsing JSONL.
  // Called after hide/exclude changes so the UI reflects immediately.
  applySettingsChange() {
    const settings = this.getSettings();
    const providerChanged = settings.provider !== this.state.settings.provider;
    if (providerChanged) {
      this.jsonlCache.clear();
      this.codexRateLimits = null;
      this.repoGitStatsLastRefresh = 0;
      this.startWatcher();
      void this.heavyRefresh();
      return;
    }
    const excluded = new Set(settings.excludedProjects ?? []);
    const sessions = this.state.sessions.filter(s => {
      const key = s.mainRepoName ?? s.projectName;
      return !excluded.has(key) && !excluded.has(s.projectName);
    });
    const codeOutputStats = this.buildCodeOutputStats(sessions, this.state.repoGitStats);
    this.state = { ...this.state, sessions, settings, codeOutputStats, lastUpdated: Date.now() };
    this.onUpdate(this.state);
  }
}
