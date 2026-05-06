import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, nativeTheme, screen } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { StateManager, AppState } from './stateManager';
import { registerIpcHandlers, AppSettings, DEFAULT_SETTINGS, normalizeSettings } from './ipc';
import { Notification } from 'electron';
import { appendCrashLog, buildErrorPayload, buildQuitTrace, collectRuntimeMemorySnapshot, getCrashLogPath, getDebugMemLogPath, isDebugInstrumentationEnabled, setListenerTargetsProvider } from './debugInstrumentation';

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

type AppView = 'main' | 'settings' | 'notifications' | 'help';
const POPUP_WIDTH = 462;
const POPUP_HEIGHT = 1078;
const POPUP_MARGIN = 8;
const WIDGET_WIDTH = 250;
const WIDGET_HEIGHT_SINGLE = 96;
const WIDGET_HEIGHT_BOTH = 150;

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

function createTray(): Tray {
  const iconPath = path.join(__dirname, '../../assets/icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  const t = new Tray(icon);
  t.setToolTip('WhereMyTokens');
  t.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WhereMyTokens', click: () => showPopup() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]));
  t.on('click', () => {
    if (popupWindow?.isVisible()) popupWindow.hide();
    else showPopup();
  });
  registerDebugTargets();
  return t;
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

  installNavigationGuards(win);
  const rendererPath = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  win.loadFile(rendererPath);
  win.on('move', markPopupMoving);
  win.on('show', syncUiVisibility);
  win.on('hide', syncUiVisibility);
  win.webContents.on('context-menu', openDashboardContextMenu);
  registerDebugTargets();

  // blur 시 자동 숨김 없음 — 항상 떠있는 위젯 모드

  return win;
}

function compactWidgetSize(settings: AppSettings): { width: number; height: number } {
  return {
    width: WIDGET_WIDTH,
    height: (settings.provider ?? 'both') === 'both' ? WIDGET_HEIGHT_BOTH : WIDGET_HEIGHT_SINGLE,
  };
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

function schedulePersistWidgetPosition(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  if (widgetMoveEndTimer) clearTimeout(widgetMoveEndTimer);
  widgetMoveEndTimer = setTimeout(() => {
    widgetMoveEndTimer = null;
    if (widgetWindow === win && !win.isDestroyed()) persistWidgetPosition(win);
  }, 250);
}

function applyCompactWidgetBounds(settings = getSettings()) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const size = compactWidgetSize(settings);
  const [x, y] = widgetWindow.getPosition();
  const position = constrainWidgetPosition({ x, y }, size);
  widgetWindow.setBounds({ ...position, ...size }, false);
  if (position.x !== x || position.y !== y) schedulePersistWidgetPosition(widgetWindow);
}

function revealCompactWidget(win = widgetWindow, settings = getSettings()) {
  if (!win || win.isDestroyed() || !settings.compactWidgetEnabled) return;
  applyCompactWidgetBounds(settings);
  win.setAlwaysOnTop(settings.alwaysOnTop);
  if (!win.isVisible()) win.showInactive();
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
  const size = compactWidgetSize(settings);
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
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#0d0f13',
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  installNavigationGuards(win);
  const rendererPath = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  win.loadFile(rendererPath, { query: { view: 'widget' } });
  win.on('move', () => schedulePersistWidgetPosition(win));
  win.on('show', syncUiVisibility);
  win.on('hide', syncUiVisibility);
  win.once('ready-to-show', () => revealCompactWidget(win));
  win.webContents.once('did-finish-load', () => revealCompactWidget(win));
  win.on('closed', () => {
    if (widgetMoveEndTimer) {
      clearTimeout(widgetMoveEndTimer);
      widgetMoveEndTimer = null;
    }
    if (widgetWindow === win) widgetWindow = null;
    syncUiVisibility();
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
  stateManager?.setUiVisible(popupVisible || widgetVisible);
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

  popupWindow.setBounds(resolvePopupBounds(tray.getBounds()));
  popupWindow.show();
  popupWindow.focus();
  sendPopupNavigation(view);
  const currentState = stateManager?.getState();
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
  applyCompactWidgetBounds(state.settings);
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
  store.set('compactWidgetEnabled', false);
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
  widgetWindow = null;
  syncUiVisibility();
  stateManager?.applySettingsChange();
}

function showCompactWidget() {
  store.set('compactWidgetEnabled', true);
  syncCompactWidget();
  stateManager?.applySettingsChange();
  applyRuntimeSettings();
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
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setAlwaysOnTop(settings.alwaysOnTop);
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

function applyRuntimeSettings() {
  const settings = getSettings();
  applyWindowSettings();
  syncCompactWidget();
  if (!registerGlobalHotkey(settings.globalHotkey)) {
    store.set('globalHotkey', registeredGlobalHotkey);
  }
}

function buildTrayTitle(state: AppState): string {
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const display = settings.trayDisplay ?? 'h5pct';
  const provider = settings.provider ?? 'both';
  const h5Tokens = (provider === 'codex')
    ? state.usage.h5Codex.totalTokens
    : (provider === 'both' ? state.usage.h5.totalTokens + state.usage.h5Codex.totalTokens : state.usage.h5.totalTokens);
  const h5Cost = (provider === 'codex')
    ? state.usage.h5Codex.costUSD
    : (provider === 'both' ? state.usage.h5.costUSD + state.usage.h5Codex.costUSD : state.usage.h5.costUSD);
  const h5Pct = provider === 'codex'
    ? state.limits.codexH5.pct
    : (provider === 'both' ? Math.max(state.limits.h5.pct, state.limits.codexH5.pct) : state.limits.h5.pct);
  switch (display) {
    case 'h5pct':
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
    () => manager.getDebugMemSnapshot('ipc'),
    {
      openDashboard: () => showPopup('main'),
      openSettings: () => showPopup('settings'),
      hideCompactWidget,
    },
  );

  tray = createTray();
  popupWindow = createPopupWindow();
  manager.start();
  syncCompactWidget();
  app.once('before-quit', () => manager.stop());

  // Show popup on first launch (after renderer is ready)
  popupWindow.once('ready-to-show', () => showPopup());

  // Global shortcut
  const settings = getSettings();
  if (!registerGlobalHotkey(settings.globalHotkey)) {
    store.set('globalHotkey', registeredGlobalHotkey);
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
    const size = compactWidgetSize(getSettings());
    const next = constrainWidgetPosition({ x: position.x, y: position.y }, size);
    widgetWindow.setBounds({ ...next, width: size.width, height: size.height });
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
