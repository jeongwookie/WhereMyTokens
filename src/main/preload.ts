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
  isDebugInstrumentationEnabled: () => ipcRenderer.invoke('debug-instrumentation-enabled'),
  getDebugMemSnapshot:  () => ipcRenderer.invoke('debug-mem-snapshot'),
  reportDebugRendererEvent: (payload: Record<string, unknown>) => ipcRenderer.invoke('debug-renderer-event', payload),
  onUpdated:            (cb: (state: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on('state:updated', handler);
    return () => ipcRenderer.removeListener('state:updated', handler);
  },
  getResolvedTheme:     () => ipcRenderer.invoke('theme:resolved') as Promise<'light' | 'dark'>,
  onThemeChanged:       (cb: (theme: 'light' | 'dark') => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: 'light' | 'dark') => cb(theme);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },
});
