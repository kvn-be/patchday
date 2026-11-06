import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('patchday', {
  state: () => ipcRenderer.invoke('state'),
  saveSettings: (patch: unknown) => ipcRenderer.invoke('settings', patch),
  check: () => ipcRenderer.invoke('check'),
  update: () => ipcRenderer.invoke('update'),
  saveToken: (token: string) => ipcRenderer.invoke('token', token),
  coffee: () => ipcRenderer.invoke('coffee'),
  checkSelf: () => ipcRenderer.invoke('self-check'),
  installSelf: () => ipcRenderer.invoke('self-install'),
  onSelfProgress: (listener: (percent: number) => void) => ipcRenderer.on('self-progress', (_event, percent) => listener(percent)),
  onSelfAvailable: (listener: (version: string) => void) => ipcRenderer.on('self-available', (_event, version) => listener(version)),
  setupAdmin: () => ipcRenderer.invoke('admin'),
  onProgress: (listener: (items: unknown[]) => void) => ipcRenderer.on('progress', (_event, items) => listener(items)),
  onLog: (listener: (message: string) => void) => ipcRenderer.on('log', (_event, message) => listener(message)),
});
