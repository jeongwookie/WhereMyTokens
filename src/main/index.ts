import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, nativeTheme, screen } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { StateManager, AppState } from './stateManager';
import { registerIpcHandlers, AppSettings, DEFAULT_SETTINGS, normalizeSettings } from './ipc';
import { Notification } from 'electron';
import { appendCrashLog, buildErrorPayload, buildQuitTrace, collectRuntimeMemorySnapshot, getCrashLogPath, getDebugMemLogPath, isDebugInstrumentationEnabled, setListenerTargetsProvider } from './debugInstrumentation';
import { initOAuthRefresh } from './oauthRefresh';
import type { WindowStats } from './usageWindows';
import type { ProviderId, ProviderQuotaWindow } from './providers/types';
import { compactWidgetSize } from './compactWidgetSizing';

if (isDebugInstrumentationEnabled()) {
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let tray: Tray | null = null;
let popupWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let stateManager: StateManager | null = null;
const store = new Store<AppSettings>() as Store<AppSettings>;
let pendingStateUpdate: AppState | null = null;
let stateUpdateTimer: NodeJS.Timeout | null = null;
let popupMoving = false;
let popupMoveEndTimer: NodeJS.Timeout | null = null;
let widgetMoveEndTimer: NodeJS.Timeout | null = null;
let lastTrayTitle = '';
let lastTrayTooltip = '';
let registeredGlobalHotkey = '';
const readyWidgetWindows = new WeakSet<BrowserWindow>();

type AppView = 'main' | 'settings' | 'notifications' | 'help';
const POPUP_WIDTH = 462;
const POPUP_HEIGHT = 1078;
const POPUP_MARGIN = 8;
function registerDebugTargets() {
  setListenerTargetsProvider(() => ([
    { name: 'process', emitter: process },
    { name: 'app', emitter: app },
    { name: 'ipcMain', emitter: ipcMain },
    { name: 'nativeTheme', emitter: nativeTheme },
    { name: 'tray', emitter: tray },
    { name: 'popupWindow', emitter: popupWindow },
    { name: 'popupWebContents', emitter: popupWindow?.webContents },
    { name: 'widgetWindow', emitter: widgetWindow },
    { name: 'widgetWebContents', emitter: widgetWindow?.webContents },
  ]));
}

function installDebugInstrumentation() {
  if (!isDebugInstrumentationEnabled()) return;

  process.on('uncaughtException', (error, origin) => {
    appendCrashLog('uncaughtException', {
      origin,
      ...buildErrorPayload(error),
    });
    setImmediate(() => app.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    appendCrashLog('unhandledRejection', buildErrorPayload(reason));
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    appendCrashLog('render-process-gone', {
      details,
      url: webContents.getURL(),
      runtime: collectRuntimeMemorySnapshot(),
    });
  });

  app.on('child-process-gone', (_event, details) => {
    appendCrashLog('child-process-gone', {
      details,
      runtime: collectRuntimeMemorySnapshot(),
    });
  });

  app.on('before-quit', () => {
    appendCrashLog('before-quit', {
      stack: buildQuitTrace('quit-trace'),
      runtime: collectRuntimeMemorySnapshot(),
    });
  });

  app.on('will-quit', () => {
    appendCrashLog('will-quit', {
      stack: buildQuitTrace('quit-trace'),
      runtime: collectRuntimeMemorySnapshot(),
    });
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const settings = getSettings();
  const widgetVisible = isCompactWidgetVisible();
  const widgetLabel = settings.compactWidgetEnabled && widgetVisible ? 'Hide Widget' : 'Show Widget';
  const widgetAction = settings.compactWidgetEnabled && widgetVisible ? hideCompactWidget : showCompactWidget;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WhereMyTokens', click: () => showPopup() },
    { type: 'separator' },
    { label: widgetLabel, click: widgetAction },
    { label: 'Settings', click: () => showPopup('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]));
}

function createTray(): Tray {
  const iconPath = path.join(__dirname, '../../assets/icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  const t = new Tray(icon);
  t.setToolTip('WhereMyTokens');
  t.on('click', () => {
    if (popupWindow?.isVisible()) popupWindow.hide();
    else showPopup();
  });
  registerDebugTargets();
  return t;
}

function keepWindowOutOfTaskbar(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  try {
    win.setSkipTaskbar(true);
  } catch { /* 창 종료 타이밍과 겹치는 일시적 오류는 무시한다. */ }
}

function createPopupWindow(): BrowserWindow {
  const settings = getSettings();
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#0d0d1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  keepWindowOutOfTaskbar(win);
  installNavigationGuards(win);
  const rendererPath = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  win.loadFile(rendererPath);
  win.on('move', markPopupMoving);
  win.on('show', () => {
    keepWindowOutOfTaskbar(win);
    syncUiVisibility();
  });
  win.on('hide', syncUiVisibility);
  win.webContents.on('context-menu', openDashboardContextMenu);
  registerDebugTargets();

  // blur 시 자동 숨김 없음 — 항상 떠있는 위젯 모드

  return win;
}

function isCompactWidgetVisible() {
  return !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible();
}

type WidgetPosition = { x: number; y: number };
type WidgetSize = { width: number; height: number };

function defaultWidgetPosition(width: number, height: number): WidgetPosition {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - width - 18),
    y: Math.round(workArea.y + 84),
  };
}

function validWidgetPosition(value: AppSettings['compactWidgetBounds']): value is WidgetPosition {
  return !!value
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && Number.isFinite(value.x)
    && Number.isFinite(value.y);
}

function constrainWidgetPosition(position: WidgetPosition, size: WidgetSize): WidgetPosition {
  const display = screen.getDisplayNearestPoint(position);
  const { workArea } = display;
  const maxX = workArea.x + Math.max(0, workArea.width - size.width);
  const maxY = workArea.y + Math.max(0, workArea.height - size.height);
  return {
    x: Math.round(Math.min(Math.max(position.x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(position.y, workArea.y), maxY)),
  };
}

function resolveWidgetPosition(settings: AppSettings, size: WidgetSize): WidgetPosition {
  const position = validWidgetPosition(settings.compactWidgetBounds)
    ? settings.compactWidgetBounds
    : defaultWidgetPosition(size.width, size.height);
  return constrainWidgetPosition(position, size);
}

function persistWidgetPosition(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  store.set('compactWidgetBounds', { x, y });
}

function flushWidgetPosition(win = widgetWindow) {
  if (widgetMoveEndTimer) {
    clearTimeout(widgetMoveEndTimer);
    widgetMoveEndTimer = null;
  }
  if (win && !win.isDestroyed()) persistWidgetPosition(win);
}

function schedulePersistWidgetPosition(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  if (widgetMoveEndTimer) clearTimeout(widgetMoveEndTimer);
  widgetMoveEndTimer = setTimeout(() => {
    widgetMoveEndTimer = null;
    if (widgetWindow === win && !win.isDestroyed()) persistWidgetPosition(win);
  }, 250);
}

function applyCompactWidgetBounds(settings = getSettings(), state: AppState | null | undefined = stateManager?.getState()) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const size = compactWidgetSize(settings, state);
  const [x, y] = widgetWindow.getPosition();
  const position = constrainWidgetPosition({ x, y }, size);
  widgetWindow.setBounds({ ...position, ...size }, false);
  keepWindowOutOfTaskbar(widgetWindow);
  if (position.x !== x || position.y !== y) schedulePersistWidgetPosition(widgetWindow);
}

function revealCompactWidget(win = widgetWindow, settings = getSettings()) {
  if (!win || win.isDestroyed() || !settings.compactWidgetEnabled) return;
  if (!win.isVisible() && !readyWidgetWindows.has(win)) return;
  applyCompactWidgetBounds(settings);
  win.setAlwaysOnTop(true);
  keepWindowOutOfTaskbar(win);
  if (!win.isVisible()) win.showInactive();
  keepWindowOutOfTaskbar(win);
  syncUiVisibility();
  const currentState = stateManager?.getState();
  if (currentState) win.webContents.send('state:updated', currentState);
}

function openWidgetContextMenu() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => showPopup('main') },
    { label: 'Refresh now', click: () => stateManager?.forceRefresh().catch(() => {}) },
    { label: 'Settings', click: () => showPopup('settings') },
    { type: 'separator' },
    { label: 'Hide widget', click: hideCompactWidget },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]).popup({ window: widgetWindow });
}

function openDashboardContextMenu() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: 'Hide dashboard', click: () => popupWindow?.hide() },
    { label: 'Refresh now', click: () => stateManager?.forceRefresh().catch(() => {}) },
    { label: 'Settings', click: () => showPopup('settings') },
    { type: 'separator' },
    { label: 'Show widget', click: showCompactWidget },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]).popup({ window: popupWindow });
}

function createWidgetWindow(): BrowserWindow {
  const settings = getSettings();
  const size = compactWidgetSize(settings, stateManager?.getState());
  const position = resolveWidgetPosition(settings, size);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  keepWindowOutOfTaskbar(win);
  installNavigationGuards(win);
  const rendererPath = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  win.loadFile(rendererPath, { query: { view: 'widget' } });
  win.on('move', () => schedulePersistWidgetPosition(win));
  win.on('show', () => {
    keepWindowOutOfTaskbar(win);
    syncWidgetVisibility();
  });
  win.on('hide', syncWidgetVisibility);
  win.once('ready-to-show', () => {
    readyWidgetWindows.add(win);
    revealCompactWidget(win);
  });
  win.on('close', () => flushWidgetPosition(win));
  win.on('closed', () => {
    if (widgetWindow === win) widgetWindow = null;
    syncWidgetVisibility();
  });
  win.webContents.on('context-menu', openWidgetContextMenu);
  registerDebugTargets();
  return win;
}

function getSettings(): AppSettings {
  return normalizeSettings(store.store);
}

function installNavigationGuards(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => {
    event.preventDefault();
  });
  win.webContents.on('will-attach-webview', event => {
    event.preventDefault();
  });
}

function sendPopupNavigation(view: AppView) {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const send = () => popupWindow?.webContents.send('app:navigate', view);
  if (popupWindow.webContents.isLoading()) popupWindow.webContents.once('did-finish-load', send);
  else send();
}

function syncUiVisibility() {
  const popupVisible = !!popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible();
  const widgetVisible = !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible();
  // 화면에 보이는 창이 하나라도 있으면 새 세션 발견을 놓치지 않도록 foreground 스캔을 유지한다.
  const foregroundVisible = popupVisible || widgetVisible;
  stateManager?.setUiVisible(foregroundVisible);
}

function syncWidgetVisibility() {
  syncUiVisibility();
  rebuildTrayMenu();
}

function resolvePopupBounds(trayBounds: Electron.Rectangle): Electron.Rectangle {
  const trayCenter = {
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  };
  const { workArea } = screen.getDisplayNearestPoint(trayCenter);
  const width = Math.min(POPUP_WIDTH, Math.max(240, workArea.width - POPUP_MARGIN * 2));
  const height = Math.min(POPUP_HEIGHT, Math.max(240, workArea.height - POPUP_MARGIN * 2));
  const preferredX = Math.round(trayCenter.x - width / 2);
  const preferredY = Math.round(trayBounds.y - height - POPUP_MARGIN);
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  return {
    x: Math.min(Math.max(preferredX, workArea.x), maxX),
    y: Math.min(Math.max(preferredY, workArea.y), maxY),
    width,
    height,
  };
}

function showPopup(view: AppView = 'main') {
  if (!popupWindow || popupWindow.isDestroyed()) popupWindow = createPopupWindow();
  if (!tray) return;
  const currentState = stateManager?.getState();
  syncCompactWidget();

  popupWindow.setBounds(resolvePopupBounds(tray.getBounds()));
  popupWindow.show();
  popupWindow.focus();
  keepWindowOutOfTaskbar(popupWindow);
  sendPopupNavigation(view);
  if (currentState) {
    pendingStateUpdate = null;
    if (stateUpdateTimer) clearTimeout(stateUpdateTimer);
    stateUpdateTimer = null;
    popupWindow.webContents.send('state:updated', currentState);
  }
}

function sendWidgetStateUpdate(state: AppState) {
  if (!state.settings.compactWidgetEnabled) return;
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    syncCompactWidget();
    return;
  }
  if (!widgetWindow.isVisible()) return;
  applyCompactWidgetBounds(state.settings, state);
  keepWindowOutOfTaskbar(widgetWindow);
  widgetWindow.webContents.send('state:updated', state);
}

function syncCompactWidget() {
  const settings = getSettings();
  if (!settings.compactWidgetEnabled) {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
    widgetWindow = null;
    syncUiVisibility();
    return;
  }

  if (!widgetWindow || widgetWindow.isDestroyed()) {
    widgetWindow = createWidgetWindow();
    return;
  }
  revealCompactWidget(widgetWindow, settings);
}

function hideCompactWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
  syncUiVisibility();
  rebuildTrayMenu();
}

function showCompactWidget() {
  store.set('compactWidgetEnabled', true);
  syncCompactWidget();
  stateManager?.applySettingsChange();
  applyRuntimeSettings();
  rebuildTrayMenu();
}

function togglePopupFromShortcut() {
  if (popupWindow?.isVisible() && popupWindow.isFocused()) {
    popupWindow.hide();
    return;
  }
  showPopup();
}

function applyWindowSettings() {
  const settings = getSettings();
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setAlwaysOnTop(settings.alwaysOnTop);
    keepWindowOutOfTaskbar(popupWindow);
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setAlwaysOnTop(true);
    keepWindowOutOfTaskbar(widgetWindow);
  }
}

function registerGlobalHotkey(hotkey: string): boolean {
  const nextHotkey = hotkey.trim();
  if (nextHotkey === registeredGlobalHotkey) return true;
  if (!nextHotkey) {
    if (registeredGlobalHotkey) {
      globalShortcut.unregister(registeredGlobalHotkey);
      registeredGlobalHotkey = '';
    }
    return true;
  }

  let nextRegistered = false;
  try {
    nextRegistered = globalShortcut.register(nextHotkey, togglePopupFromShortcut);
  } catch { /* ignore */ }
  if (!nextRegistered) return false;

  if (registeredGlobalHotkey) {
    globalShortcut.unregister(registeredGlobalHotkey);
  }
  registeredGlobalHotkey = nextHotkey;
  return true;
}

function rollbackHotkeySettingAfterFailedRegistration(): boolean {
  if (!registeredGlobalHotkey) return false;
  store.set('globalHotkey', registeredGlobalHotkey);
  return true;
}

function applyRuntimeSettings() {
  const settings = getSettings();
  applyWindowSettings();
  syncCompactWidget();
  rebuildTrayMenu();
  if (!registerGlobalHotkey(settings.globalHotkey)) {
    if (rollbackHotkeySettingAfterFailedRegistration()) {
      stateManager?.applySettingsChange();
    }
  }
}

function quotaWindow(state: AppState, provider: ProviderId, window: string): ProviderQuotaWindow | null {
  return state.providerQuotas[provider]?.windows?.[window] ?? null;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function isCodexLimitProvisional(state: AppState, limit: ProviderQuotaWindow | null): boolean {
  return state.historyWarmupPending && limit?.source === 'localLog';
}

function usageWindow(state: AppState, provider: ProviderId, window: string): WindowStats | null {
  return state.usage.byProvider[provider]?.windows[window] ?? null;
}

function isFiveHourDuration(durationMs: number | null | undefined): boolean {
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && Math.abs(durationMs - FIVE_HOURS_MS) < 1000;
}

function modelStatsWindowKey(model: { statsWindowKey?: string; model: string }): string {
  return model.statsWindowKey || `model.${model.model}`;
}

function trayH5WindowKeys(state: AppState, provider: ProviderId): string[] {
  const keys = new Set<string>();
  const providerUsage = state.usage.byProvider[provider]?.windows ?? {};
  const quota = state.providerQuotas[provider];
  if (providerUsage.h5 || quota?.windows?.h5) keys.add('h5');

  for (const [windowKey, display] of Object.entries(quota?.windowDisplay ?? {})) {
    if (windowKey === 'h5' || isFiveHourDuration(display.durationMs)) keys.add(windowKey);
  }
  for (const model of quota?.models ?? []) {
    if (isFiveHourDuration(model.durationMs)) {
      keys.add(modelStatsWindowKey(model));
    }
  }
  return [...keys];
}

function trayH5Stats(state: AppState, provider: ProviderId): WindowStats | null {
  let selected: WindowStats | null = null;
  for (const windowKey of trayH5WindowKeys(state, provider)) {
    const stats = usageWindow(state, provider, windowKey);
    if (!stats) continue;
    if (!selected || stats.totalTokens > selected.totalTokens) selected = stats;
  }
  return selected;
}

function trayH5Pct(state: AppState, provider: ProviderId): { pct: number; provisional: boolean } {
  const quota = state.providerQuotas[provider];
  let pct = 0;
  let provisional = false;
  const consider = (candidatePct: number, window: ProviderQuotaWindow | null) => {
    if (provider === 'codex' && isCodexLimitProvisional(state, window)) {
      provisional = true;
      return;
    }
    if (Number.isFinite(candidatePct)) pct = Math.max(pct, Math.max(0, Math.min(100, candidatePct)));
  };

  for (const windowKey of trayH5WindowKeys(state, provider)) {
    const window = quotaWindow(state, provider, windowKey);
    if (window) consider(window.pct, window);
  }
  for (const model of quota?.models ?? []) {
    if (isFiveHourDuration(model.durationMs)) {
      consider(100 - model.remainingPct, { pct: 100 - model.remainingPct, resetMs: model.resetMs ?? null, source: quota?.source });
    }
  }
  return { pct, provisional };
}

function buildTrayTitle(state: AppState): string {
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const display = settings.trayDisplay ?? 'h5pct';
  const enabledProviders = settings.enabledProviders;
  const h5Stats = enabledProviders
    .map(provider => trayH5Stats(state, provider))
    .filter((stats): stats is WindowStats => !!stats);
  const h5Tokens = h5Stats.reduce((total, stats) => total + stats.totalTokens, 0);
  const h5Cost = h5Stats.reduce((total, stats) => total + stats.costUSD, 0);
  const pctRows = enabledProviders.map(provider => trayH5Pct(state, provider));
  const h5Pct = Math.max(0, ...pctRows.map(row => row.pct));
  const provisionalOnly = pctRows.some(row => row.provisional) && h5Pct <= 0;
  switch (display) {
    case 'h5pct':
      if (provisionalOnly) return 'scan';
      return h5Pct > 0 ? `${Math.round(h5Pct)}%` : '';
    case 'tokens': {
      const t = h5Tokens;
      if (t >= 1_000_000) return `${(t/1_000_000).toFixed(1)}M`;
      if (t >= 1_000) return `${(t/1_000).toFixed(0)}K`;
      return t > 0 ? String(t) : '';
    }
    case 'cost': {
      const c = h5Cost;
      return settings.currency === 'KRW'
        ? `₩${Math.round(c * (settings.usdToKrw ?? 1380)).toLocaleString()}`
        : `$${c.toFixed(2)}`;
    }
    default: return '';
  }
}

function updateTray(state: AppState) {
  if (!tray) return;
  try {
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const t = state.usage.todayTokens;
  const c = state.usage.todayCost;
  const costStr = settings.currency === 'KRW'
    ? `₩${Math.round(c * (settings.usdToKrw ?? 1380)).toLocaleString()}`
    : `$${c.toFixed(2)}`;
  const tooltip = `WhereMyTokens  |  Today ${t.toLocaleString()} tok  ${costStr}`;
  if (tooltip !== lastTrayTooltip) {
    tray.setToolTip(tooltip);
    lastTrayTooltip = tooltip;
  }
  const title = buildTrayTitle(state);
  if (title !== lastTrayTitle) {
    tray.setTitle(title);
    lastTrayTitle = title;
  }

  queueRendererStateUpdate(state);
  sendWidgetStateUpdate(state);
  } catch { /* 종료 중 tray/window가 이미 소멸된 경우 무시 */ }
}

function queueRendererStateUpdate(state: AppState) {
  if (!popupWindow || popupWindow.isDestroyed() || !popupWindow.isVisible()) return;
  keepWindowOutOfTaskbar(popupWindow);
  pendingStateUpdate = state;
  if (stateUpdateTimer) clearTimeout(stateUpdateTimer);
  stateUpdateTimer = setTimeout(flushRendererStateUpdate, popupMoving ? 250 : 150);
}

function flushRendererStateUpdate() {
  if (popupMoving) {
    stateUpdateTimer = setTimeout(flushRendererStateUpdate, 250);
    return;
  }
  stateUpdateTimer = null;
  const next = pendingStateUpdate;
  pendingStateUpdate = null;
  if (next && popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) {
    popupWindow.webContents.send('state:updated', next);
  }
}

function markPopupMoving() {
  popupMoving = true;
  stateManager?.setUiBusy(true);
  if (popupMoveEndTimer) clearTimeout(popupMoveEndTimer);
  popupMoveEndTimer = setTimeout(() => {
    popupMoving = false;
    stateManager?.setUiBusy(false);
    if (pendingStateUpdate) {
      if (stateUpdateTimer) clearTimeout(stateUpdateTimer);
      stateUpdateTimer = setTimeout(flushRendererStateUpdate, 250);
    }
  }, 250);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.wheremytokens.app');
  initOAuthRefresh(
    store as unknown as { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void },
  );
  registerDebugTargets();
  installDebugInstrumentation();
  if (isDebugInstrumentationEnabled()) {
    appendCrashLog('debug-instrumentation-enabled', {
      crashLogPath: getCrashLogPath(),
      debugMemLogPath: getDebugMemLogPath(),
      runtime: collectRuntimeMemorySnapshot(),
    });
  }

  const manager = new StateManager(store, (state) => updateTray(state));
  stateManager = manager;
  registerIpcHandlers(
    store,
    () => manager.getState(),
    () => manager.forceRefresh(),
    () => {
      manager.applySettingsChange();
      applyRuntimeSettings();
    },
    () => manager.rebuildUsageLedger(),
    () => manager.getDebugMemSnapshot('ipc'),
    {
      openDashboard: () => showPopup('main'),
      openSettings: () => showPopup('settings'),
      hideCompactWidget,
    },
  );

  tray = createTray();
  rebuildTrayMenu();
  popupWindow = createPopupWindow();
  manager.start();
  syncCompactWidget();
  app.once('before-quit', () => manager.stop());

  // Show popup on first launch (after renderer is ready)
  popupWindow.once('ready-to-show', () => showPopup());

  // Global shortcut
  const settings = getSettings();
  if (!registerGlobalHotkey(settings.globalHotkey)) {
    rollbackHotkeySettingAfterFailedRegistration();
  }

  // Auto-start at login
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });

  // App quit IPC
  ipcMain.handle('app:quit', () => { app.exit(0); });
  ipcMain.handle('debug-renderer-event', (_event, payload: Record<string, unknown>) => {
    if (!isDebugInstrumentationEnabled()) return;
    appendCrashLog('renderer-event', {
      payload,
      runtime: collectRuntimeMemorySnapshot(),
    });
  });

  // 최소화(숨김) IPC
  ipcMain.handle('window:minimize', () => { popupWindow?.hide(); });
  ipcMain.handle('window:get-compact-widget-position', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return null;
    const [x, y] = widgetWindow.getPosition();
    return { x, y };
  });
  ipcMain.handle('window:set-compact-widget-position', (_event, position: { x?: unknown; y?: unknown }) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (typeof position?.x !== 'number' || typeof position?.y !== 'number') return;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
    const size = compactWidgetSize(getSettings(), stateManager?.getState());
    const next = constrainWidgetPosition({ x: position.x, y: position.y }, size);
    widgetWindow.setBounds({ ...next, width: size.width, height: size.height });
    keepWindowOutOfTaskbar(widgetWindow);
    schedulePersistWidgetPosition(widgetWindow);
  });

  // 시스템 테마 감지: auto 설정 시 OS 다크모드에 따라 resolve
  function resolveTheme(): 'light' | 'dark' {
    const s = getSettings();
    if (s.theme === 'auto') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    return s.theme as 'light' | 'dark';
  }

  ipcMain.handle('theme:resolved', () => resolveTheme());

  nativeTheme.on('updated', () => {
    const s = getSettings();
    if (s.theme === 'auto' && popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('theme:changed', resolveTheme());
    }
    if (s.theme === 'auto' && widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.webContents.send('theme:changed', resolveTheme());
    }
  });
});

app.on('window-all-closed', () => { /* tray app: do not quit */ });
app.on('second-instance', () => showPopup());
app.on('will-quit', () => globalShortcut.unregisterAll());
