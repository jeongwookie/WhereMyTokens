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
  setPinned:            (v: boolean) => ipcRenderer.invoke('window:setPinned', v),
  getPinned:            () => ipcRenderer.invoke('window:getPinned'),
  onUpdated:            (cb: () => void) => {
    ipcRenderer.on('state:updated', cb);
    return () => ipcRenderer.removeListener('state:updated', cb);
  },
});
