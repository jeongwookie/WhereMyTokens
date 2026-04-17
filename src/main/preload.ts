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
  onUpdated:            (cb: () => void) => {
    ipcRenderer.on('state:updated', cb);
    return () => ipcRenderer.removeListener('state:updated', cb);
  },
  getResolvedTheme:     () => ipcRenderer.invoke('theme:resolved') as Promise<'light' | 'dark'>,
  onThemeChanged:       (cb: (theme: 'light' | 'dark') => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: 'light' | 'dark') => cb(theme);
    ipcRenderer.on('theme:changed', handler);
    return () => ipcRenderer.removeListener('theme:changed', handler);
  },
});
