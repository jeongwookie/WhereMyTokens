import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('wmt', {
  getState:             () => ipcRenderer.invoke('state:get'),
  forceRefresh:         () => ipcRenderer.invoke('state:refresh'),
  getSettings:          () => ipcRenderer.invoke('settings:get'),
  setSettings:          (p: Record<string, unknown>) => ipcRenderer.invoke('settings:set', p),
  getNotifications:     () => ipcRenderer.invoke('notifications:get'),
  clearNotifications:   () => ipcRenderer.invoke('notifications:clear'),
setupIntegration:     () => ipcRenderer.invoke('integration:setup'),
  getIntegrationStatus: () => ipcRenderer.invoke('integration:status'),
  quit:                 () => ipcRenderer.invoke('app:quit'),
  minimize:             () => ipcRenderer.invoke('window:minimize'),
  openDashboard:        () => ipcRenderer.invoke('window:open-dashboard'),
  openSettings:         () => ipcRenderer.invoke('window:open-settings'),
  hideCompactWidget:    () => ipcRenderer.invoke('window:hide-compact-widget'),
  getCompactWidgetPosition: () => ipcRenderer.invoke('window:get-compact-widget-position'),
  setCompactWidgetPosition: (p: { x: number; y: number }) => ipcRenderer.invoke('window:set-compact-widget-position', p),
  isDebugInstrumentationEnabled: () => ipcRenderer.invoke('debug-instrumentation-enabled'),
  getDebugMemSnapshot:  () => ipcRenderer.invoke('debug-mem-snapshot'),
  reportDebugRendererEvent: (payload: Record<string, unknown>) => ipcRenderer.invoke('debug-renderer-event', payload),
  onUpdated:            (cb: (state: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on('state:updated', handler);
    return () => ipcRenderer.removeListener('state:updated', handler);
  },
  onNavigate:           (cb: (view: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, view: string) => cb(view);
    ipcRenderer.on('app:navigate', handler);
    return () => ipcRenderer.removeListener('app:navigate', handler);
  },
  getResolvedTheme:     () => ipcRenderer.invoke('theme:resolved') as Promise<'light' | 'dark'>,
  onThemeChanged:       (cb: (theme: 'light' | 'dark') => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: 'light' | 'dark') => cb(theme);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },
});
