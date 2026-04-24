import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { AppState, AppSettings } from './types';
import MainView from './views/MainView';
import SettingsView from './views/SettingsView';
import NotificationsView from './views/NotificationsView';
import HelpView from './views/HelpView';
import RenderErrorBoundary from './components/RenderErrorBoundary';
import { getTheme, applyThemeCssVars } from './theme';
import { ThemeProvider } from './ThemeContext';

type View = 'main' | 'settings' | 'notifications' | 'help';

const EMPTY_WINDOW = { inputTokens:0, outputTokens:0, cacheCreationTokens:0, cacheReadTokens:0, totalTokens:0, costUSD:0, requestCount:0, cacheEfficiency:0, cacheSavingsUSD:0 };
const EMPTY_CODE_OUTPUT = { today: { commits: 0, added: 0, removed: 0 }, all: { commits: 0, added: 0, removed: 0 }, daily7d: [], dailyAll: [] };

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
    h5: { pct:0, resetMs:0 }, week: { pct:0, resetMs:0 }, so: { pct:0, resetMs:0 },
    codexH5: { pct:0, resetMs:0 }, codexWeek: { pct:0, resetMs:0 },
  },
  settings: {
    usageLimits: { h5:100, week:2000, sonnetWeek:100_000_000 },
    provider: 'both',
    alertThresholds: [50,80,90], openAtLogin: false,
    currency: 'USD', usdToKrw: 1380,
    globalHotkey: 'CommandOrControl+Shift+D', enableAlerts: true,
    trayDisplay: 'h5pct', theme: 'auto',
    hiddenProjects: [], excludedProjects: [],
  },
  autoLimits: null,
  initialRefreshComplete: false,
  historyWarmupPending: false,
  lastUpdated: 0,
  apiConnected: false,
  apiError: undefined,
  bridgeActive: false,
  extraUsage: null,
  repoGitStats: {},
  codeOutputStats: EMPTY_CODE_OUTPUT,
  codeOutputLoading: false,
  allTimeSessions: 0,
};

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

export default function App() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [view, setView] = useState<View>('main');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const scrollingRef = useRef(false);
  const pendingStateRef = useRef<AppState | null>(null);
  const scrollTimerRef = useRef<number | null>(null);

  const commitState = useCallback((next: AppState) => {
    setState(prev => stabilizeAppState(prev, next));
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
      if (s) applyState(s);
    } catch (e) { console.error('state:get failed', e); }
  }, [applyState]);

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

  // Hide HTML splash as soon as core usage/session data is ready; git stats can finish in-card.
  useEffect(() => {
    if (!state.initialRefreshComplete) return;
    const splash = document.getElementById('splash');
    const root = document.getElementById('root');
    if (splash) splash.style.display = 'none';
    if (root) root.style.display = '';
  }, [state.initialRefreshComplete]);

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
