import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as os from 'os';
import Store from 'electron-store';
import { AppState, DebugMemSnapshot } from './stateManager';
import { getHistory, clearHistory } from './notificationHistory';
import { isDebugInstrumentationEnabled } from './debugInstrumentation';
import {
  disableIntegration,
  getIntegrationStatus,
  setupIntegration,
} from './integration';
import type { ProviderId } from './providers/types';
import { normalizeEnabledProviders } from './providers/settings';

const DEFAULT_MAIN_SECTION_ORDER = ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'];
const MAIN_SECTION_IDS = new Set(DEFAULT_MAIN_SECTION_ORDER);

export interface CompactWidgetBounds {
  x: number;
  y: number;
}

export interface AppSettings {
  usageLimits: { h5: number; week: number; sonnetWeek: number };
  enabledProviders: ProviderId[];

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
  hiddenMainSections: string[];
  hiddenProjects: string[];
  excludedProjects: string[];
  compactWidgetEnabled: boolean;
  compactWidgetWaitingAnimationEnabled: boolean;
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

function normalizeHiddenMainSections(value: unknown, order: string[] = DEFAULT_MAIN_SECTION_ORDER): string[] | null {
  if (!Array.isArray(value)) return null;
  const ordered = normalizeMainSectionOrder(order) ?? DEFAULT_MAIN_SECTION_ORDER;
  const valid = new Set<string>(ordered);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  if (normalized.length >= ordered.length) return [];
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

function legacyProviderToEnabledProviders(value: unknown): ProviderId[] | null {
  if (value === 'claude') return ['claude'];
  if (value === 'codex') return ['codex'];
  if (value === 'both') return ['claude', 'codex'];
  return null;
}

function normalizedSettingsPartial(partial: unknown): Partial<AppSettings> {
  const record = asRecord(partial);
  if (!record) return {};
  const next: Partial<AppSettings> = {};

  const usageLimits = normalizeUsageLimits(record.usageLimits);
  if (usageLimits) next.usageLimits = usageLimits;
  if (Array.isArray(record.enabledProviders)) {
    next.enabledProviders = normalizeEnabledProviders(record.enabledProviders);
  } else {
    const migratedProviders = legacyProviderToEnabledProviders(record.provider);
    if (migratedProviders) next.enabledProviders = migratedProviders;
  }
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
  const hiddenMainSections = normalizeHiddenMainSections(record.hiddenMainSections, mainSectionOrder ?? DEFAULT_MAIN_SECTION_ORDER);
  if (hiddenMainSections) next.hiddenMainSections = hiddenMainSections;
  const hiddenProjects = stringArray(record.hiddenProjects);
  if (hiddenProjects) next.hiddenProjects = hiddenProjects;
  const excludedProjects = stringArray(record.excludedProjects);
  if (excludedProjects) next.excludedProjects = excludedProjects;
  if (typeof record.compactWidgetEnabled === 'boolean') next.compactWidgetEnabled = record.compactWidgetEnabled;
  if (typeof record.compactWidgetWaitingAnimationEnabled === 'boolean') next.compactWidgetWaitingAnimationEnabled = record.compactWidgetWaitingAnimationEnabled;
  if (Object.prototype.hasOwnProperty.call(record, 'compactWidgetBounds')) {
    const compactWidgetBounds = normalizeCompactWidgetBounds(record.compactWidgetBounds);
    if (compactWidgetBounds !== undefined) next.compactWidgetBounds = compactWidgetBounds;
  }
  if (record.theme === 'auto' || record.theme === 'light' || record.theme === 'dark') next.theme = record.theme;

  return next;
}

export function normalizeSettings(value: unknown): AppSettings {
  const sanitized = normalizedSettingsPartial(value);
  const enabledProviders = normalizeEnabledProviders(sanitized.enabledProviders);
  return {
    ...DEFAULT_SETTINGS,
    ...sanitized,
    enabledProviders,
    mainSectionOrder: sanitized.mainSectionOrder ?? DEFAULT_SETTINGS.mainSectionOrder,
    hiddenMainSections: sanitized.hiddenMainSections ?? DEFAULT_SETTINGS.hiddenMainSections,
    hiddenProjects: sanitized.hiddenProjects ?? DEFAULT_SETTINGS.hiddenProjects,
    excludedProjects: sanitized.excludedProjects ?? DEFAULT_SETTINGS.excludedProjects,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  usageLimits: { h5: 100, week: 2000, sonnetWeek: 100_000_000 },
  enabledProviders: ['claude', 'codex'],
  alertThresholds: [50, 80, 90],
  openAtLogin: false,
  alwaysOnTop: true,
  currency: 'USD',
  usdToKrw: 1380,
  globalHotkey: 'CommandOrControl+Shift+D',
  enableAlerts: true,
  trayDisplay: 'h5pct',
  mainSectionOrder: DEFAULT_MAIN_SECTION_ORDER,
  hiddenMainSections: [],
  hiddenProjects: [],
  excludedProjects: [],
  compactWidgetEnabled: false,
  compactWidgetWaitingAnimationEnabled: false,
  compactWidgetBounds: null,
  theme: 'auto',
};

function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function bridgeScriptPath(): string {
  return path.join(app.getAppPath(), '..', 'bridge', 'bridge.js');
}

export function registerIpcHandlers(
  store: Store<AppSettings>,
  getState: () => AppState,
  forceRefresh: () => Promise<void>,
  applySettingsChange: () => void,
  rebuildUsageLedger?: () => Promise<void>,
  getDebugMemSnapshot?: () => Promise<DebugMemSnapshot>,
  windowActions?: {
    openDashboard: () => void;
    openSettings: () => void;
    hideCompactWidget: () => void;
  },
) {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('state:refresh', async () => { await forceRefresh(); return getState(); });
  ipcMain.handle('ledger:rebuild', async () => {
    if (rebuildUsageLedger) await rebuildUsageLedger();
    return getState();
  });

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

  const handleIntegrationSetup = () => setupIntegration(claudeSettingsPath(), bridgeScriptPath());
  const handleIntegrationStatus = () => getIntegrationStatus(claudeSettingsPath(), bridgeScriptPath());
  const handleIntegrationDisable = () => disableIntegration(claudeSettingsPath(), bridgeScriptPath());

  ipcMain.handle('integration-setup', handleIntegrationSetup);
  ipcMain.handle('integration-status', handleIntegrationStatus);
  ipcMain.handle('integration-disable', handleIntegrationDisable);
  ipcMain.handle('integration:setup', handleIntegrationSetup);
  ipcMain.handle('integration:status', handleIntegrationStatus);
}
