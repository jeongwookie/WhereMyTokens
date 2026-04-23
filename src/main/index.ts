import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, nativeTheme } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { StateManager, AppState } from './stateManager';
import { registerIpcHandlers, AppSettings, DEFAULT_SETTINGS } from './ipc';
import { Notification } from 'electron';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let tray: Tray | null = null;
let popupWindow: BrowserWindow | null = null;
let stateManager: StateManager | null = null;
const store = new Store<AppSettings>() as Store<AppSettings>;
let pendingStateUpdate: AppState | null = null;
let stateUpdateTimer: NodeJS.Timeout | null = null;
let popupMoving = false;
let popupMoveEndTimer: NodeJS.Timeout | null = null;
let lastTrayTitle = '';
let lastTrayTooltip = '';

function createTray(): Tray {
  const iconPath = path.join(__dirname, '../../assets/icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  const t = new Tray(icon);
  t.setToolTip('WhereMyTokens');
  t.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WhereMyTokens', click: showPopup },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.exit(0); } },
  ]));
  t.on('click', () => {
    if (popupWindow?.isVisible()) popupWindow.hide();
    else showPopup();
  });
  return t;
}

function createPopupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 980,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#0d0d1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const rendererPath = path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  win.loadFile(rendererPath);
  win.on('move', markPopupMoving);

  // blur 시 자동 숨김 없음 — 항상 떠있는 위젯 모드

  return win;
}

function showPopup() {
  if (!popupWindow || popupWindow.isDestroyed()) popupWindow = createPopupWindow();
  if (!tray) return;

  const tb = tray.getBounds();
  const [w, h] = popupWindow.getSize();
  const x = Math.round(tb.x + tb.width / 2 - w / 2);
  const y = Math.round(tb.y - h - 8);
  popupWindow.setPosition(x, y);
  popupWindow.show();
  popupWindow.focus();
  const currentState = stateManager?.getState();
  if (currentState) {
    pendingStateUpdate = null;
    if (stateUpdateTimer) clearTimeout(stateUpdateTimer);
    stateUpdateTimer = null;
    popupWindow.webContents.send('state:updated', currentState);
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

  const manager = new StateManager(store, (state) => updateTray(state));
  stateManager = manager;
  registerIpcHandlers(store, () => manager.getState(), () => manager.forceRefresh(), () => manager.applySettingsChange());

  tray = createTray();
  popupWindow = createPopupWindow();
  manager.start();
  app.once('before-quit', () => manager.stop());

  // Show popup on first launch (after renderer is ready)
  popupWindow.once('ready-to-show', () => showPopup());

  // Global shortcut
  const settings = { ...DEFAULT_SETTINGS, ...store.store };
  try {
    globalShortcut.register(settings.globalHotkey, () => {
      if (popupWindow?.isVisible()) popupWindow.hide();
      else showPopup();
    });
  } catch { /* ignore */ }

  // Auto-start at login
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });

  // App quit IPC
  ipcMain.handle('app:quit', () => { app.exit(0); });

  // 최소화(숨김) IPC
  ipcMain.handle('window:minimize', () => { popupWindow?.hide(); });

  // 시스템 테마 감지: auto 설정 시 OS 다크모드에 따라 resolve
  function resolveTheme(): 'light' | 'dark' {
    const s = { ...DEFAULT_SETTINGS, ...store.store };
    if (s.theme === 'auto') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    return s.theme as 'light' | 'dark';
  }

  ipcMain.handle('theme:resolved', () => resolveTheme());

  nativeTheme.on('updated', () => {
    const s = { ...DEFAULT_SETTINGS, ...store.store };
    if (s.theme === 'auto' && popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('theme:changed', resolveTheme());
    }
  });
});

app.on('window-all-closed', () => { /* tray app: do not quit */ });
app.on('second-instance', showPopup);
app.on('will-quit', () => globalShortcut.unregisterAll());
