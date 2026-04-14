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
    todayTokens: 0, todayCost: 0, sonnetWeekTokens: 0,
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
    trayDisplay: 'h5pct', theme: 'dark',
  },
  autoLimits: null,
  lastUpdated: 0,
  extraUsage: null,
};

export default function App() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [view, setView] = useState<View>('main');
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

  const theme = getTheme(state.settings.theme ?? 'light');
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
