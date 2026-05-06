import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Store from 'electron-store';
import { AppState, DebugMemSnapshot } from './stateManager';
import { getHistory, clearHistory } from './notificationHistory';
import { isDebugInstrumentationEnabled } from './debugInstrumentation';

const DEFAULT_MAIN_SECTION_ORDER = ['planUsage', 'codeOutput', 'sessions', 'activity', 'modelUsage'];
const MAIN_SECTION_IDS = new Set(DEFAULT_MAIN_SECTION_ORDER);

export interface CompactWidgetBounds {
  x: number;
  y: number;
}

export interface AppSettings {
  // 내부용 (UI 미노출, fallback 용도)
  usageLimits: { h5: number; week: number; sonnetWeek: number };
  provider: 'claude' | 'codex' | 'both';

  // 사용자 설정
  alertThresholds: number[]; // [50, 80, 90]
  openAtLogin: boolean;
  alwaysOnTop: boolean;
  currency: 'USD' | 'KRW';
  usdToKrw: number;
  globalHotkey: string;
  enableAlerts: boolean;
  trayDisplay: 'none' | 'h5pct' | 'tokens' | 'cost';
  mainSectionOrder: string[];
  hiddenProjects: string[];
  excludedProjects: string[];
  compactWidgetEnabled: boolean;
  compactWidgetBounds: CompactWidgetBounds | null;
  theme: 'auto' | 'light' | 'dark';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const numberValue = finiteNumber(value);
  return numberValue != null && numberValue > 0 ? numberValue : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeUsageLimits(value: unknown): AppSettings['usageLimits'] | null {
  const record = asRecord(value);
  if (!record) return null;
  const h5 = positiveNumber(record.h5);
  const week = positiveNumber(record.week);
  const sonnetWeek = positiveNumber(record.sonnetWeek);
  if (h5 == null || week == null || sonnetWeek == null) return null;
  return { h5, week, sonnetWeek };
}

function normalizeAlertThresholds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const thresholds = value
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    .map(item => Math.max(0, Math.min(100, item)));
  return [...new Set(thresholds)].sort((a, b) => a - b);
}

function normalizeMainSectionOrder(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !MAIN_SECTION_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  for (const id of DEFAULT_MAIN_SECTION_ORDER) {
    if (!seen.has(id)) normalized.push(id);
  }
  return normalized;
}

function normalizeCompactWidgetBounds(value: unknown): CompactWidgetBounds | null | undefined {
  if (value == null) return null;
  const record = asRecord(value);
  if (!record) return undefined;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  return x == null || y == null ? undefined : { x, y };
}

function normalizedSettingsPartial(partial: unknown): Partial<AppSettings> {
  const record = asRecord(partial);
  if (!record) return {};
  const next: Partial<AppSettings> = {};

  const usageLimits = normalizeUsageLimits(record.usageLimits);
  if (usageLimits) next.usageLimits = usageLimits;
  if (record.provider === 'claude' || record.provider === 'codex' || record.provider === 'both') next.provider = record.provider;
  const alertThresholds = normalizeAlertThresholds(record.alertThresholds);
  if (alertThresholds) next.alertThresholds = alertThresholds;
  if (typeof record.openAtLogin === 'boolean') next.openAtLogin = record.openAtLogin;
  if (typeof record.alwaysOnTop === 'boolean') next.alwaysOnTop = record.alwaysOnTop;
  if (record.currency === 'USD' || record.currency === 'KRW') next.currency = record.currency;
  const usdToKrw = positiveNumber(record.usdToKrw);
  if (usdToKrw != null) next.usdToKrw = usdToKrw;
  if (typeof record.globalHotkey === 'string') next.globalHotkey = record.globalHotkey.slice(0, 80);
  if (typeof record.enableAlerts === 'boolean') next.enableAlerts = record.enableAlerts;
  if (record.trayDisplay === 'none' || record.trayDisplay === 'h5pct' || record.trayDisplay === 'tokens' || record.trayDisplay === 'cost') next.trayDisplay = record.trayDisplay;
  const mainSectionOrder = normalizeMainSectionOrder(record.mainSectionOrder);
  if (mainSectionOrder) next.mainSectionOrder = mainSectionOrder;
  const hiddenProjects = stringArray(record.hiddenProjects);
  if (hiddenProjects) next.hiddenProjects = hiddenProjects;
  const excludedProjects = stringArray(record.excludedProjects);
  if (excludedProjects) next.excludedProjects = excludedProjects;
  if (typeof record.compactWidgetEnabled === 'boolean') next.compactWidgetEnabled = record.compactWidgetEnabled;
  if (Object.prototype.hasOwnProperty.call(record, 'compactWidgetBounds')) {
    const compactWidgetBounds = normalizeCompactWidgetBounds(record.compactWidgetBounds);
    if (compactWidgetBounds !== undefined) next.compactWidgetBounds = compactWidgetBounds;
  }
  if (record.theme === 'auto' || record.theme === 'light' || record.theme === 'dark') next.theme = record.theme;

  return next;
}

export function normalizeSettings(value: unknown): AppSettings {
  const sanitized = normalizedSettingsPartial(value);
  return {
    ...DEFAULT_SETTINGS,
    ...sanitized,
    mainSectionOrder: sanitized.mainSectionOrder ?? DEFAULT_SETTINGS.mainSectionOrder,
    hiddenProjects: sanitized.hiddenProjects ?? DEFAULT_SETTINGS.hiddenProjects,
    excludedProjects: sanitized.excludedProjects ?? DEFAULT_SETTINGS.excludedProjects,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  usageLimits: { h5: 100, week: 2000, sonnetWeek: 100_000_000 },
  provider: 'both',
  alertThresholds: [50, 80, 90],
  openAtLogin: false,
  alwaysOnTop: true,
  currency: 'USD',
  usdToKrw: 1380,
  globalHotkey: 'CommandOrControl+Shift+D',
  enableAlerts: true,
  trayDisplay: 'h5pct',
  mainSectionOrder: DEFAULT_MAIN_SECTION_ORDER,
  hiddenProjects: [],
  excludedProjects: [],
  compactWidgetEnabled: false,
  compactWidgetBounds: null,
  theme: 'auto',
};

export function registerIpcHandlers(
  store: Store<AppSettings>,
  getState: () => AppState,
  forceRefresh: () => Promise<void>,
  applySettingsChange: () => void,
  getDebugMemSnapshot?: () => Promise<DebugMemSnapshot>,
  windowActions?: {
    openDashboard: () => void;
    openSettings: () => void;
    hideCompactWidget: () => void;
  },
) {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('state:refresh', async () => { await forceRefresh(); return getState(); });

  ipcMain.handle('settings:get', () => normalizeSettings(store.store));

  ipcMain.handle('settings:set', (_e, partial: unknown) => {
    const sanitized = normalizedSettingsPartial(partial);
    for (const [k, v] of Object.entries(sanitized)) {
      store.set(k as keyof AppSettings, v as AppSettings[keyof AppSettings]);
    }
    if (sanitized.openAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: sanitized.openAtLogin });
    }
    applySettingsChange();
    return normalizeSettings(store.store);
  });

  ipcMain.handle('notifications:get', () => getHistory());
  ipcMain.handle('notifications:clear', () => { clearHistory(); return []; });
  ipcMain.handle('window:open-dashboard', () => windowActions?.openDashboard());
  ipcMain.handle('window:open-settings', () => windowActions?.openSettings());
  ipcMain.handle('window:hide-compact-widget', () => windowActions?.hideCompactWidget());
  ipcMain.handle('debug-instrumentation-enabled', () => isDebugInstrumentationEnabled());
  ipcMain.handle('debug-mem-snapshot', async () => {
    if (!isDebugInstrumentationEnabled()) return null;
    if (!getDebugMemSnapshot) return null;
    return getDebugMemSnapshot();
  });

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
