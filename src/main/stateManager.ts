import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar from 'chokidar';
import { discoverSessions, DiscoveredSession } from './sessionDiscovery';
import { parseJsonlFile, ParsedEntry, ActivityBreakdown } from './jsonlParser';
import { computeUsage, UsageData } from './usageWindows';
import { AppSettings, DEFAULT_SETTINGS } from './ipc';
import { fetchAutoLimits, fetchApiUsagePct, AutoLimits, ApiUsagePct, RateLimitedError } from './rateLimitFetcher';
import { checkAlerts } from './usageAlertManager';
import Store from 'electron-store';
import { BridgeWatcher, LiveSessionData } from './bridgeWatcher';
import { getGitStats, getGitStatsAsync, GitStats, getAllPersistedStatsByRepo } from './gitStatsCollector';
import { discoverAllProjectCwds } from './projectDiscovery';

export interface SessionInfo extends DiscoveredSession {
  modelName: string;
  contextUsed: number;    // tokens
  contextMax: number;     // tokens
  toolCounts: Record<string, number>;
  gitStats: GitStats | null;
  activityBreakdown: ActivityBreakdown | null;
}

export interface UsageLimits {
  h5: { pct: number; resetMs: number };
  week: { pct: number; resetMs: number };
  so: { pct: number; resetMs: number };
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
}

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export class StateManager {
  private store: Store<AppSettings>;
  private allEntries: ParsedEntry[] = [];
  private state: AppState;
  private fastTimer: NodeJS.Timeout | null = null;
  private heavyTimer: NodeJS.Timeout | null = null;
  private autoLimitTimer: NodeJS.Timeout | null = null;
  private watcher: chokidar.FSWatcher | null = null;
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
  private static readonly API_MIN_INTERVAL_MS = 180_000; // 3분 간격 (429 방지)

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
        todayTokens: 0, todayCost: 0, sonnetWeekTokens: 0,
        burnRate: { h5OutputPerMin: 0, h5EtaMs: null, weekEtaMs: null },
        todBuckets: [],
      },
      limits: {
        h5: { pct: 0, resetMs: 0 },
        week: { pct: 0, resetMs: 0 },
        so: { pct: 0, resetMs: 0 },
      },
      settings: this.getSettings(),
      autoLimits: null,
      lastUpdated: 0,
      apiConnected: false,
      bridgeActive: false,
      extraUsage: null,
      repoGitStats: {},
    };
  }

  private emptyWindow() {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, costUSD: 0, requestCount: 0, cacheEfficiency: 0, cacheSavingsUSD: 0 };
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
    this.watcher?.close();
    this.bridgeWatcher.stop();
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
    await this.heavyRefresh();
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
    }, 3000);
  }

  private startWatcher() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    this.watcher = chokidar.watch(SESSIONS_DIR, { ignoreInitial: true, depth: 0 });
    this.watcher.on('add', (filePath: string) => {
      if (filePath.endsWith('.jsonl')) this.debouncedHeavyRefresh();
      else this.fastRefresh();
    });
    this.watcher.on('unlink', () => this.fastRefresh());

    // Watch for JSONL changes — 디바운스 적용
    if (fs.existsSync(PROJECTS_DIR)) {
      this.watcher.add(path.join(PROJECTS_DIR, '**', '*.jsonl'));
      this.watcher.on('change', () => this.debouncedHeavyRefresh());
    }
  }

  private fastRefresh() {
    const sessions = this.buildSessionInfos();
    this.state = { ...this.state, sessions, lastUpdated: Date.now() };
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

  private async heavyRefresh() {
    await this.refreshApiUsagePct();
    this.allEntries = this.loadAllEntries();

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
    const usage = computeUsage(this.allEntries, effectiveLimits, weekResetMs, h5ResetMs);
    const limits = this.buildLimits();
    const sessions = await this.buildSessionInfosAsync();

    const extraUsage = this.apiUsagePct?.extraUsage ?? null;

    // ~/.claude/projects/ 기반으로 모든 Claude 작업 repo의 git stats 수집
    const allCwds = discoverAllProjectCwds();
    const rawStats = await Promise.all(allCwds.map(cwd => getGitStatsAsync(cwd).catch(() => null)));
    const repoGitStats: Record<string, GitStats> = {};

    // 1단계: fresh 수집 결과 먼저 적용 (신선도 우선, 중복 제거)
    for (const stats of rawStats) {
      if (!stats?.gitCommonDir) continue;
      if (repoGitStats[stats.gitCommonDir]) continue;
      repoGitStats[stats.gitCommonDir] = stats;
    }

    // 2단계: 영속 캐시로 누락 repo 보충 (삭제된 워크트리 복원)
    const persisted = getAllPersistedStatsByRepo();
    for (const [gitCommonDir, stats] of Object.entries(persisted)) {
      if (!repoGitStats[gitCommonDir]) {
        repoGitStats[gitCommonDir] = stats;
      }
    }

    this.state = { sessions, usage, limits, settings, autoLimits: this.autoLimits, lastUpdated: Date.now(), apiConnected: this.apiConnected, apiError: this.apiError, bridgeActive, extraUsage, repoGitStats };
    this.onUpdate(this.state);

    checkAlerts(limits, settings.alertThresholds, settings.enableAlerts);
  }

  /** API 데이터 항상 우선 (서버 권위값); API 없을 때만 bridge fallback */
  private buildLimits(): UsageLimits {
    const now = Date.now();

    // API 데이터가 있으면 항상 우선 — 웹 대시보드와 동일한 서버 권위값
    if (this.apiUsagePct) {
      return {
        h5:   { pct: this.apiUsagePct.h5Pct,   resetMs: this.apiUsagePct.h5ResetMs },
        week: { pct: this.apiUsagePct.weekPct,  resetMs: this.apiUsagePct.weekResetMs },
        so:   { pct: this.apiUsagePct.soPct,    resetMs: this.apiUsagePct.soResetMs },
      };
    }

    // API 없을 때만 bridge fallback (5분 이내 신선한 데이터)
    // bridge는 Claude Code 요청 시에만 갱신되므로 리셋 후 stale해질 수 있음
    const rl = this.liveSession?.rate_limits;
    if (rl && this.liveSession?._ts && now - this.liveSession._ts < 300_000) {
      return {
        h5:   { pct: rl.five_hour?.used_percentage ?? 0, resetMs: rl.five_hour?.resets_at  ? rl.five_hour.resets_at  - now : 0 },
        week: { pct: rl.seven_day?.used_percentage  ?? 0, resetMs: rl.seven_day?.resets_at ? rl.seven_day.resets_at  - now : 0 },
        so:   { pct: 0, resetMs: 0 },
      };
    }

    // 모두 없으면 이전 상태 유지 (재시작/오프라인 시 0 대신 마지막 값 표시)
    return this.state?.limits ?? { h5: { pct: 0, resetMs: 0 }, week: { pct: 0, resetMs: 0 }, so: { pct: 0, resetMs: 0 } };
  }

  private loadAllEntries(): ParsedEntry[] {
    const entries: ParsedEntry[] = [];
    if (!fs.existsSync(PROJECTS_DIR)) return entries;

    const settings = this.getSettings();
    const excluded = new Set(settings.excludedProjects ?? []);
    const seen = new Set<string>();
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
          for (const file of files) {
            const parsed = parseJsonlFile(path.join(dirPath, file));
            for (const e of parsed.entries) {
              if (!seen.has(e.requestId)) {
                seen.add(e.requestId);
                entries.push(e);
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return entries;
  }

  private buildSessionInfos(): SessionInfo[] {
    const settings = this.getSettings();
    const excluded = new Set(settings.excludedProjects ?? []);
    const discovered = discoverSessions().filter(s => !excluded.has(s.projectName));
    return discovered.map(s => {
      let modelName = '';
      let contextUsed = 0;
      let contextMax = 200_000;
      let toolCounts: Record<string, number> = {};

      let activityBreakdown: SessionInfo['activityBreakdown'] = null;
      if (s.jsonlPath) {
        try {
          const parsed = parseJsonlFile(s.jsonlPath);
          modelName = parsed.modelName;
          contextUsed = parsed.latestInputTokens + parsed.latestCacheCreationTokens + parsed.latestCacheReadTokens;
          toolCounts = parsed.toolCounts;
          activityBreakdown = parsed.activityBreakdown;

          const raw = parsed.rawModel.toLowerCase();
          if (raw.includes('1m') || raw.includes('1-000k')) contextMax = 1_000_000;
          else contextMax = 200_000;
        } catch { /* skip */ }
      }

      const gitStats = getGitStats(s.cwd);
      return { ...s, modelName, contextUsed, contextMax, toolCounts, gitStats, activityBreakdown };
    });
  }

  // heavyRefresh용 — git stats를 async로 확보하여 첫 렌더링에 브랜치명 포함
  private async buildSessionInfosAsync(): Promise<SessionInfo[]> {
    const settings = this.getSettings();
    const excluded = new Set(settings.excludedProjects ?? []);
    const discovered = discoverSessions().filter(s => !excluded.has(s.projectName));
    return Promise.all(discovered.map(async s => {
      let modelName = '';
      let contextUsed = 0;
      let contextMax = 200_000;
      let toolCounts: Record<string, number> = {};

      let activityBreakdown: SessionInfo['activityBreakdown'] = null;
      if (s.jsonlPath) {
        try {
          const parsed = parseJsonlFile(s.jsonlPath);
          modelName = parsed.modelName;
          contextUsed = parsed.latestInputTokens + parsed.latestCacheCreationTokens + parsed.latestCacheReadTokens;
          toolCounts = parsed.toolCounts;
          activityBreakdown = parsed.activityBreakdown;

          const raw = parsed.rawModel.toLowerCase();
          if (raw.includes('1m') || raw.includes('1-000k')) contextMax = 1_000_000;
          else contextMax = 200_000;
        } catch { /* skip */ }
      }

      const gitStats = await getGitStatsAsync(s.cwd);
      return { ...s, modelName, contextUsed, contextMax, toolCounts, gitStats, activityBreakdown };
    }));
  }

  getState(): AppState {
    return this.state;
  }

  // Instant settings update: filters cached sessions without re-parsing JSONL.
  // Called after hide/exclude changes so the UI reflects immediately.
  applySettingsChange() {
    const settings = this.getSettings();
    const excluded = new Set(settings.excludedProjects ?? []);
    const sessions = this.state.sessions.filter(s => {
      const key = s.mainRepoName ?? s.projectName;
      return !excluded.has(key) && !excluded.has(s.projectName);
    });
    this.state = { ...this.state, sessions, settings, lastUpdated: Date.now() };
    this.onUpdate(this.state);
  }
}
