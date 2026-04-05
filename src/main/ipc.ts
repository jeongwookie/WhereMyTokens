import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Store from 'electron-store';
import { AppState } from './stateManager';
import { getHistory, clearHistory } from './notificationHistory';

export interface AppSettings {
  language: 'ko' | 'en';
  refreshInterval: number;   // seconds
  usageLimits: { h5: number; week: number; sonnetWeek: number };
  alertThresholds: number[]; // [50, 80, 90]
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

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'en',
  refreshInterval: 5,
  usageLimits: { h5: 100, week: 2000, sonnetWeek: 100_000_000 },
  alertThresholds: [50, 80, 90],
  openAtLogin: false,
  defaultChartView: 'heatmap',
  currency: 'USD',
  usdToKrw: 1380,
  globalHotkey: 'CommandOrControl+Shift+D',
  enableAlerts: true,
  provider: 'both',
  trayDisplay: 'h5pct',
  hiddenProjects: [],
  excludedProjects: [],
};

export function registerIpcHandlers(
  store: Store<AppSettings>,
  getState: () => AppState,
  forceRefresh: () => Promise<void>,
  applySettingsChange: () => void,
) {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('state:refresh', async () => { await forceRefresh(); return getState(); });

  ipcMain.handle('settings:get', () => ({ ...DEFAULT_SETTINGS, ...store.store }));

  ipcMain.handle('settings:set', (_e, partial: Partial<AppSettings>) => {
    for (const [k, v] of Object.entries(partial)) {
      store.set(k as keyof AppSettings, v as AppSettings[keyof AppSettings]);
    }
    if (partial.openAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: partial.openAtLogin });
    }
    applySettingsChange();
    return { ...DEFAULT_SETTINGS, ...store.store };
  });

  ipcMain.handle('notifications:get', () => getHistory());
  ipcMain.handle('notifications:clear', () => { clearHistory(); return []; });

  // Claude Code statusLine bridge setup
  ipcMain.handle('integration:setup', () => {
    try {
      const bridgeJs = path.join(app.getAppPath(), '..', 'bridge', 'bridge.js');
      const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

      let settings: Record<string, unknown> = {};
      if (fs.existsSync(claudeSettingsPath)) {
        try { settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8')); } catch { /* use empty */ }
      }

      const cmd = `node "${bridgeJs.replace(/\\/g, '\\\\')}"`;
      settings['statusLine'] = { type: 'command', command: cmd };

      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return { ok: true, command: cmd };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('integration:status', () => {
    try {
      const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (!fs.existsSync(claudeSettingsPath)) return { configured: false };
      const s = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8')) as Record<string, unknown>;
      const sl = s['statusLine'] as Record<string, unknown> | undefined;
      const configured = !!(sl?.command && String(sl.command).includes('bridge'));
      return { configured, command: sl?.command ?? '' };
    } catch { return { configured: false }; }
  });
}
