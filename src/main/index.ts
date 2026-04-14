import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { StateManager, AppState } from './stateManager';
import { registerIpcHandlers, AppSettings, DEFAULT_SETTINGS } from './ipc';
import { Notification } from 'electron';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let tray: Tray | null = null;
let popupWindow: BrowserWindow | null = null;
const store = new Store<AppSettings>() as Store<AppSettings>;

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
}

function buildTrayTitle(state: AppState): string {
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const display = settings.trayDisplay ?? 'h5pct';
  switch (display) {
    case 'h5pct':
      return state.limits.h5.pct > 0 ? `${Math.round(state.limits.h5.pct)}%` : '';
    case 'tokens': {
      const t = state.usage.h5.totalTokens;
      if (t >= 1_000_000) return `${(t/1_000_000).toFixed(1)}M`;
      if (t >= 1_000) return `${(t/1_000).toFixed(0)}K`;
      return t > 0 ? String(t) : '';
    }
    case 'cost': {
      const c = state.usage.h5.costUSD;
      return settings.currency === 'KRW'
        ? `₩${Math.round(c * (settings.usdToKrw ?? 1380)).toLocaleString()}`
        : `$${c.toFixed(2)}`;
    }
    default: return '';
  }
}

function updateTray(state: AppState) {
  if (!tray) return;
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const t = state.usage.todayTokens;
  const c = state.usage.todayCost;
  const costStr = settings.currency === 'KRW'
    ? `₩${Math.round(c * (settings.usdToKrw ?? 1380)).toLocaleString()}`
    : `$${c.toFixed(2)}`;
  tray.setToolTip(`WhereMyTokens  |  Today ${t.toLocaleString()} tok  ${costStr}`);
  const title = buildTrayTitle(state);
  if (title) tray.setTitle(title);

  if (popupWindow?.isVisible()) {
    popupWindow.webContents.send('state:updated');
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.wheremytokens.app');

  const stateManager = new StateManager(store, (state) => updateTray(state));
  registerIpcHandlers(store, () => stateManager.getState(), () => stateManager.forceRefresh(), () => stateManager.applySettingsChange());

  tray = createTray();
  popupWindow = createPopupWindow();
  stateManager.start();

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

  // nativeTheme.updated not needed — light mode is fixed
});

app.on('window-all-closed', () => { /* tray app: do not quit */ });
app.on('second-instance', showPopup);
app.on('will-quit', () => globalShortcut.unregisterAll());
