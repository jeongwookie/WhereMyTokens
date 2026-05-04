import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { AppState, AppSettings } from './types';
import MainView from './views/MainView';
import SettingsView from './views/SettingsView';
import NotificationsView from './views/NotificationsView';
import HelpView from './views/HelpView';
import RenderErrorBoundary from './components/RenderErrorBoundary';
import { getTheme, applyThemeCssVars, Theme } from './theme';
import { ThemeProvider } from './ThemeContext';
import { DEFAULT_MAIN_SECTION_ORDER, normalizeMainSectionOrder } from './mainSections';

type View = 'main' | 'settings' | 'notifications' | 'help';

const EMPTY_WINDOW = { inputTokens:0, outputTokens:0, cacheCreationTokens:0, cacheReadTokens:0, totalTokens:0, costUSD:0, requestCount:0, cacheEfficiency:0, cacheSavingsUSD:0 };
const EMPTY_CODE_OUTPUT = {
  today: { commits: 0, added: 0, removed: 0 },
  all: { commits: 0, added: 0, removed: 0 },
  daily7d: [],
  dailyAll: [],
  repoCount: 0,
  scopeLabel: 'Current session repos',
};
const BOOT_FALLBACK_DELAY_MS = 12_000;

const DEFAULT_STATE: AppState = {
  sessions: [],
  usage: {
    h5: EMPTY_WINDOW, week: EMPTY_WINDOW,
    h5Codex: EMPTY_WINDOW, weekCodex: EMPTY_WINDOW,
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
    h5: { pct:0, resetMs:null }, week: { pct:0, resetMs:null }, so: { pct:0, resetMs:null },
    codexH5: { pct:0, resetMs:null }, codexWeek: { pct:0, resetMs:null },
  },
  settings: {
    usageLimits: { h5:100, week:2000, sonnetWeek:100_000_000 },
    provider: 'both',
    alertThresholds: [50,80,90], openAtLogin: false,
    alwaysOnTop: true,
    currency: 'USD', usdToKrw: 1380,
    globalHotkey: 'CommandOrControl+Shift+D', enableAlerts: true,
    trayDisplay: 'h5pct', theme: 'auto',
    mainSectionOrder: DEFAULT_MAIN_SECTION_ORDER,
    hiddenProjects: [], excludedProjects: [],
  },
  autoLimits: null,
  codexAccount: { serviceTier: null },
  initialRefreshComplete: false,
  historyWarmupPending: false,
  historyWarmupStartsAt: null,
  lastUpdated: 0,
  apiConnected: false,
  apiStatusLabel: undefined,
  apiError: undefined,
  bridgeActive: false,
  extraUsage: null,
  repoGitStats: {},
  codeOutputStats: EMPTY_CODE_OUTPUT,
  codeOutputLoading: false,
  allTimeSessions: 0,
};

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) record[key] = entry;
  }
  return record;
}

function normalizeLimitWindow(window: Partial<AppState['limits']['h5']> | null | undefined): AppState['limits']['h5'] {
  return {
    pct: typeof window?.pct === 'number' ? window.pct : 0,
    resetMs: typeof window?.resetMs === 'number' ? window.resetMs : null,
    resetLabel: typeof window?.resetLabel === 'string' ? window.resetLabel : undefined,
    source: window?.source,
  };
}

function normalizeExtraUsage(extraUsage: AppState['extraUsage'] | null | undefined): AppState['extraUsage'] {
  if (!extraUsage || typeof extraUsage !== 'object') return null;
  const monthlyLimit = typeof extraUsage.monthlyLimit === 'number' && Number.isFinite(extraUsage.monthlyLimit)
    ? Math.max(0, extraUsage.monthlyLimit)
    : 0;
  const usedCredits = typeof extraUsage.usedCredits === 'number' && Number.isFinite(extraUsage.usedCredits)
    ? Math.max(0, extraUsage.usedCredits)
    : 0;
  const utilization = typeof extraUsage.utilization === 'number' && Number.isFinite(extraUsage.utilization)
    ? Math.max(0, Math.min(100, extraUsage.utilization))
    : 0;
  return {
    isEnabled: extraUsage.isEnabled === true,
    monthlyLimit,
    usedCredits,
    utilization,
    currency: typeof extraUsage.currency === 'string' ? extraUsage.currency : null,
  };
}

function normalizeSession(session: Partial<AppState['sessions'][number]> | null | undefined): AppState['sessions'][number] {
  const state = session?.state;
  const normalizedState = state === 'active' || state === 'waiting' || state === 'idle' || state === 'compacting'
    ? state
    : 'idle';
  const startedAt = session?.startedAt instanceof Date
    ? session.startedAt.toISOString()
    : typeof session?.startedAt === 'string'
      ? session.startedAt
      : new Date(0).toISOString();
  const lastModified = session?.lastModified instanceof Date
    ? session.lastModified.toISOString()
    : typeof session?.lastModified === 'string'
      ? session.lastModified
      : null;

  return {
    provider: session?.provider === 'codex' ? 'codex' : 'claude',
    pid: typeof session?.pid === 'number' ? session.pid : null,
    sessionId: typeof session?.sessionId === 'string' ? session.sessionId : '',
    cwd: typeof session?.cwd === 'string' ? session.cwd : '',
    projectName: typeof session?.projectName === 'string' ? session.projectName : '',
    startedAt,
    entrypoint: typeof session?.entrypoint === 'string' ? session.entrypoint : '',
    source: typeof session?.source === 'string' ? session.source : '',
    state: normalizedState,
    jsonlPath: typeof session?.jsonlPath === 'string' ? session.jsonlPath : null,
    lastModified,
    modelName: typeof session?.modelName === 'string' ? session.modelName : '',
    contextUsed: typeof session?.contextUsed === 'number' ? session.contextUsed : 0,
    contextMax: typeof session?.contextMax === 'number' ? session.contextMax : 0,
    toolCounts: numberRecord(session?.toolCounts),
    isWorktree: !!session?.isWorktree,
    worktreeBranch: typeof session?.worktreeBranch === 'string' ? session.worktreeBranch : null,
    gitBranch: typeof session?.gitBranch === 'string' ? session.gitBranch : null,
    mainRepoName: typeof session?.mainRepoName === 'string' ? session.mainRepoName : null,
    gitStats: session?.gitStats ?? null,
    activityBreakdown: session?.activityBreakdown ? numberRecord(session.activityBreakdown) as AppState['sessions'][number]['activityBreakdown'] : null,
    activityBreakdownKind: session?.activityBreakdownKind === 'tokens' || session?.activityBreakdownKind === 'events'
      ? session.activityBreakdownKind
      : null,
  };
}

function normalizeState(next: AppState): AppState {
  return {
    ...DEFAULT_STATE,
    ...next,
    sessions: arrayOrEmpty(next.sessions).map(session => normalizeSession(session)),
    usage: {
      ...DEFAULT_STATE.usage,
      ...next.usage,
      h5: { ...EMPTY_WINDOW, ...next.usage?.h5 },
      week: { ...EMPTY_WINDOW, ...next.usage?.week },
      h5Codex: { ...EMPTY_WINDOW, ...next.usage?.h5Codex },
      weekCodex: { ...EMPTY_WINDOW, ...next.usage?.weekCodex },
      models: arrayOrEmpty(next.usage?.models),
      heatmap: arrayOrEmpty(next.usage?.heatmap),
      heatmap30: arrayOrEmpty(next.usage?.heatmap30),
      heatmap90: arrayOrEmpty(next.usage?.heatmap90),
      weeklyTimeline: arrayOrEmpty(next.usage?.weeklyTimeline),
      todBuckets: arrayOrEmpty(next.usage?.todBuckets),
      burnRate: { ...DEFAULT_STATE.usage.burnRate, ...next.usage?.burnRate },
    },
    limits: {
      h5: normalizeLimitWindow(next.limits?.h5),
      week: normalizeLimitWindow(next.limits?.week),
      so: normalizeLimitWindow(next.limits?.so),
      codexH5: normalizeLimitWindow(next.limits?.codexH5),
      codexWeek: normalizeLimitWindow(next.limits?.codexWeek),
    },
    settings: {
      ...DEFAULT_STATE.settings,
      ...next.settings,
      alertThresholds: arrayOrEmpty(next.settings?.alertThresholds),
      mainSectionOrder: normalizeMainSectionOrder(next.settings?.mainSectionOrder),
      hiddenProjects: arrayOrEmpty(next.settings?.hiddenProjects),
      excludedProjects: arrayOrEmpty(next.settings?.excludedProjects),
    },
    historyWarmupStartsAt: typeof next.historyWarmupStartsAt === 'number' && Number.isFinite(next.historyWarmupStartsAt)
      ? next.historyWarmupStartsAt
      : null,
    apiStatusLabel: typeof next.apiStatusLabel === 'string' ? next.apiStatusLabel : undefined,
    apiError: typeof next.apiError === 'string' ? next.apiError : undefined,
    extraUsage: normalizeExtraUsage(next.extraUsage),
    repoGitStats: next.repoGitStats && typeof next.repoGitStats === 'object' ? next.repoGitStats : {},
    codeOutputStats: {
      ...EMPTY_CODE_OUTPUT,
      ...next.codeOutputStats,
      today: { ...EMPTY_CODE_OUTPUT.today, ...next.codeOutputStats?.today },
      all: { ...EMPTY_CODE_OUTPUT.all, ...next.codeOutputStats?.all },
      daily7d: arrayOrEmpty(next.codeOutputStats?.daily7d),
      dailyAll: arrayOrEmpty(next.codeOutputStats?.dailyAll),
      repoCount: typeof next.codeOutputStats?.repoCount === 'number' ? next.codeOutputStats.repoCount : 0,
      scopeLabel: typeof next.codeOutputStats?.scopeLabel === 'string' ? next.codeOutputStats.scopeLabel : EMPTY_CODE_OUTPUT.scopeLabel,
    },
  };
}

function sameNumberRecord(a: Record<string, number> | null | undefined, b: Record<string, number> | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => a[key] === b[key]);
}

function sameGitStats(a: AppState['sessions'][number]['gitStats'], b: AppState['sessions'][number]['gitStats']): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  return a.branch === b.branch
    && a.toplevel === b.toplevel
    && a.gitCommonDir === b.gitCommonDir
    && a.commitsToday === b.commitsToday
    && a.linesAdded === b.linesAdded
    && a.linesRemoved === b.linesRemoved
    && a.commits7d === b.commits7d
    && a.linesAdded7d === b.linesAdded7d
    && a.linesRemoved7d === b.linesRemoved7d
    && a.commits30d === b.commits30d
    && a.linesAdded30d === b.linesAdded30d
    && a.linesRemoved30d === b.linesRemoved30d
    && a.totalCommits === b.totalCommits
    && a.totalLinesAdded === b.totalLinesAdded
    && a.totalLinesRemoved === b.totalLinesRemoved
    && sameDailyStats(a.daily7d, b.daily7d)
    && sameDailyStats(a.dailyAll, b.dailyAll);
}

function sameDailyStats(a: NonNullable<AppState['sessions'][number]['gitStats']>['daily7d'] | undefined, b: NonNullable<AppState['sessions'][number]['gitStats']>['daily7d'] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  return a.every((day, index) => {
    const other = b[index];
    return day.date === other.date
      && day.commits === other.commits
      && day.added === other.added
      && day.removed === other.removed;
  });
}

function sameSession(a: AppState['sessions'][number], b: AppState['sessions'][number]): boolean {
  return a.provider === b.provider
    && a.pid === b.pid
    && a.sessionId === b.sessionId
    && a.cwd === b.cwd
    && a.projectName === b.projectName
    && String(a.startedAt) === String(b.startedAt)
    && a.entrypoint === b.entrypoint
    && a.source === b.source
    && a.state === b.state
    && a.jsonlPath === b.jsonlPath
    && String(a.lastModified) === String(b.lastModified)
    && a.modelName === b.modelName
    && a.contextUsed === b.contextUsed
    && a.contextMax === b.contextMax
    && a.isWorktree === b.isWorktree
    && a.worktreeBranch === b.worktreeBranch
    && a.gitBranch === b.gitBranch
    && a.mainRepoName === b.mainRepoName
    && a.activityBreakdownKind === b.activityBreakdownKind
    && sameNumberRecord(a.toolCounts, b.toolCounts)
    && sameNumberRecord(a.activityBreakdown as Record<string, number> | null | undefined, b.activityBreakdown as Record<string, number> | null | undefined)
    && sameGitStats(a.gitStats, b.gitStats);
}

function stabilizeSessions(prev: AppState['sessions'], next: AppState['sessions']): AppState['sessions'] {
  if (prev.length === 0 || next.length === 0) return next;
  const prevById = new Map(prev.map(session => [session.sessionId, session]));
  let changed = prev.length !== next.length;
  const sessions = next.map(session => {
    const previous = prevById.get(session.sessionId);
    if (previous && sameSession(previous, session)) return previous;
    changed = true;
    return session;
  });
  if (!changed) {
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== sessions[i]) return sessions;
    }
    return prev;
  }
  return sessions;
}

function stabilizeAppState(prev: AppState, next: AppState): AppState {
  const sessions = stabilizeSessions(prev.sessions, next.sessions);
  return sessions === next.sessions ? next : { ...next, sessions };
}

function BootFallback({
  theme,
  message,
  onRetry,
  onQuit,
}: {
  theme: Theme;
  message: string;
  onRetry: () => void;
  onQuit: () => void;
}) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 10,
      padding: '22px 18px',
      background: theme.bg,
      color: theme.text,
      fontFamily: theme.fontSans,
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.headerAccent }}>
        Startup Recovery
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>
        WhereMyTokens is still loading.
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.6 }}>
        {message}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <button
          onClick={onRetry}
          style={{
            background: `${theme.accent}22`,
            color: theme.accent,
            border: `1px solid ${theme.accent}44`,
            borderRadius: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          Retry
        </button>
        <button
          onClick={() => window.wmt.minimize().catch(() => {})}
          style={{
            background: theme.bgRow,
            color: theme.textDim,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          Minimize
        </button>
        <button
          onClick={onQuit}
          style={{
            background: `${theme.barRed}14`,
            color: theme.barRed,
            border: `1px solid ${theme.barRed}33`,
            borderRadius: 8,
            padding: '7px 12px',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          Quit
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [view, setView] = useState<View>('main');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [bootFallbackVisible, setBootFallbackVisible] = useState(false);
  const [bootFallbackMessage, setBootFallbackMessage] = useState('Still waiting for initial session and usage data.');
  const scrollingRef = useRef(false);
  const pendingStateRef = useRef<AppState | null>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const revealRoot = useCallback(() => {
    const splash = document.getElementById('splash');
    const root = document.getElementById('root');
    if (splash) splash.style.display = 'none';
    if (root) root.style.display = '';
  }, []);

  const commitState = useCallback((next: AppState) => {
    setState(prev => stabilizeAppState(prev, normalizeState(next)));
  }, []);

  const applyState = useCallback((next: AppState) => {
    if (scrollingRef.current) {
      pendingStateRef.current = next;
      return;
    }
    commitState(next);
  }, [commitState]);

  const handleScrollActivity = useCallback(() => {
    scrollingRef.current = true;
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      if (pendingStateRef.current) {
        const pending = pendingStateRef.current;
        pendingStateRef.current = null;
        commitState(pending);
      }
    }, 300);
  }, [commitState]);

  const refresh = useCallback(async () => {
    try {
      const s = await window.wmt.getState();
      if (s) {
        applyState(s);
        return;
      }
      setBootFallbackMessage('The app returned an empty startup state. Try refreshing once.');
      setBootFallbackVisible(true);
      revealRoot();
    } catch (e) {
      console.error('state:get failed', e);
      setBootFallbackMessage('The main process did not return startup data. Try refreshing or reopen the tray window.');
      setBootFallbackVisible(true);
      revealRoot();
    }
  }, [applyState, revealRoot]);

  const retryStartup = useCallback(async () => {
    try {
      const next = await window.wmt.forceRefresh();
      if (next) applyState(next);
      await refresh();
    } catch {
      await refresh();
    }
  }, [applyState, refresh]);

  useEffect(() => {
    refresh();
    const cleanup = window.wmt.onUpdated(applyState);
    return cleanup;
  }, [refresh, applyState]);

  useEffect(() => () => {
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
  }, []);

  // 시스템 테마 감지: 초기 resolve + 실시간 변경 리스너
  useEffect(() => {
    window.wmt.getResolvedTheme().then(setResolvedTheme);
    const cleanup = window.wmt.onThemeChanged(setResolvedTheme);
    return cleanup;
  }, []);

  // settings.theme 변경 시 재resolve (auto가 아니면 직접 사용)
  useEffect(() => {
    const t = state.settings.theme;
    if (t === 'auto') {
      window.wmt.getResolvedTheme().then(setResolvedTheme);
    } else {
      setResolvedTheme(t);
    }
  }, [state.settings.theme]);

  // 핵심 상태가 준비되면 스플래시를 닫고, 장시간 응답이 없으면 복구 화면으로 전환한다.
  useEffect(() => {
    if (state.initialRefreshComplete) {
      setBootFallbackVisible(false);
      revealRoot();
      return;
    }
    const timer = window.setTimeout(() => {
      setBootFallbackMessage('Showing a recovery view while recent sessions and usage continue loading in the background.');
      setBootFallbackVisible(true);
      revealRoot();
    }, BOOT_FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state.initialRefreshComplete, revealRoot]);

  async function handleSaveSettings(partial: Partial<AppSettings>) {
    const updated = await window.wmt.setSettings(partial);
    setState(prev => ({ ...prev, settings: updated }));
  }

  const handleQuit = useCallback(() => {
    window.wmt.quit().catch(() => window.close());
  }, []);

  const theme = useMemo(() => getTheme(resolvedTheme), [resolvedTheme]);

  // CSS 커스텀 프로퍼티 동기화 — body/scrollbar 등 CSS 레벨에서 var(--wmt-*) 사용 가능
  useEffect(() => { applyThemeCssVars(theme); }, [theme]);

  const bgStyle: React.CSSProperties = { background: theme.bg, height: '100vh', color: theme.text };

  if (bootFallbackVisible && !state.initialRefreshComplete && view === 'main') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Startup Recovery" fill>
          <BootFallback theme={theme} message={bootFallbackMessage} onRetry={retryStartup} onQuit={handleQuit} />
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (view === 'settings') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Settings View" fill>
          <div style={bgStyle}>
            <SettingsView settings={state.settings} onSave={handleSaveSettings} onBack={() => setView('main')} />
          </div>
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (view === 'notifications') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Notifications View" fill>
          <div style={bgStyle}>
            <NotificationsView onBack={() => setView('main')} />
          </div>
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  if (view === 'help') {
    return (
      <ThemeProvider value={theme}>
        <RenderErrorBoundary label="Help View" fill>
          <div style={bgStyle}>
            <HelpView onBack={() => setView('main')} />
          </div>
        </RenderErrorBoundary>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={theme}>
      <RenderErrorBoundary label="Main View" fill>
        <MainView
          state={state}
          onNav={setView}
          onQuit={handleQuit}
          onRefresh={refresh}
          onScrollActivity={handleScrollActivity}
        />
      </RenderErrorBoundary>
    </ThemeProvider>
  );
}
