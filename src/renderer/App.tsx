import React, { useEffect, useState, useCallback } from 'react';
import { AppState, AppSettings } from './types';
import MainView from './views/MainView';
import SettingsView from './views/SettingsView';
import NotificationsView from './views/NotificationsView';
import HelpView from './views/HelpView';
import { getTheme } from './theme';
import { ThemeProvider } from './ThemeContext';

type View = 'main' | 'settings' | 'notifications' | 'help';

const EMPTY_WINDOW = { inputTokens:0, outputTokens:0, cacheCreationTokens:0, cacheReadTokens:0, totalTokens:0, costUSD:0, requestCount:0, cacheEfficiency:0, cacheSavingsUSD:0 };

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
  lastUpdated: 0,
  apiConnected: false,
  apiError: undefined,
  bridgeActive: false,
  extraUsage: null,
  repoGitStats: {},
  allTimeSessions: 0,
};

export default function App() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [view, setView] = useState<View>('main');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const refresh = useCallback(async () => {
    try {
      const s = await window.wmt.getState();
      if (s) setState(s);
    } catch (e) { console.error('state:get failed', e); }
  }, []);

  useEffect(() => {
    refresh();
    const cleanup = window.wmt.onUpdated(refresh);
    return cleanup;
  }, [refresh]);

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

  // Hide HTML splash and reveal app only when data is ready
  useEffect(() => {
    if (state.lastUpdated === 0) return;
    const splash = document.getElementById('splash');
    const root = document.getElementById('root');
    if (splash) splash.style.display = 'none';
    if (root) root.style.display = '';
  }, [state.lastUpdated]);

  async function handleSaveSettings(partial: Partial<AppSettings>) {
    const updated = await window.wmt.setSettings(partial);
    setState(prev => ({ ...prev, settings: updated }));
  }

  function handleQuit() {
    window.wmt.quit().catch(() => window.close());
  }

  const theme = getTheme(resolvedTheme);
  const bgStyle: React.CSSProperties = { background: theme.bg, height: '100vh', color: theme.text };

  if (view === 'settings') {
    return (
      <ThemeProvider value={theme}>
        <div style={bgStyle}>
          <SettingsView settings={state.settings} onSave={handleSaveSettings} onBack={() => setView('main')} />
        </div>
      </ThemeProvider>
    );
  }

  if (view === 'notifications') {
    return (
      <ThemeProvider value={theme}>
        <div style={bgStyle}>
          <NotificationsView onBack={() => setView('main')} />
        </div>
      </ThemeProvider>
    );
  }

  if (view === 'help') {
    return (
      <ThemeProvider value={theme}>
        <div style={bgStyle}>
          <HelpView onBack={() => setView('main')} />
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider value={theme}>
      <MainView
        state={state}
        onNav={setView}
        onQuit={handleQuit}
        onRefresh={refresh}
      />
    </ThemeProvider>
  );
}
