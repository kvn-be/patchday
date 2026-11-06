import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('patchday', {
  state: () => ipcRenderer.invoke('state'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('settings', patch),
  check: () => ipcRenderer.invoke('check'),
  update: () => ipcRenderer.invoke('update'),
  saveToken: (token: string) => ipcRenderer.invoke('token', token),
  coffee: () => ipcRenderer.invoke('coffee'),
  onLog: (listener: (message: string) => void) => ipcRenderer.on('log', (_event, message) => listener(message)),
});
