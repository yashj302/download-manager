const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('idm', {
  getState: () => ipcRenderer.invoke('state:get'),
  add: (payload) => ipcRenderer.invoke('download:add', payload),
  pause: (id) => ipcRenderer.invoke('download:pause', id),
  resume: (id) => ipcRenderer.invoke('download:resume', id),
  cancel: (id) => ipcRenderer.invoke('download:cancel', id),
  remove: (id) => ipcRenderer.invoke('download:remove', id),
  retry: (id) => ipcRenderer.invoke('download:retry', id),
  pauseAll: () => ipcRenderer.invoke('download:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('download:resumeAll'),
  clearCompleted: () => ipcRenderer.invoke('download:clearCompleted'),
  deleteFile: (id) => ipcRenderer.invoke('download:deleteFile', id),
  open: (id) => ipcRenderer.invoke('download:open', id),
  show: (id) => ipcRenderer.invoke('download:show', id),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  regenerateToken: () => ipcRenderer.invoke('settings:regenerateToken'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openExtension: () => ipcRenderer.invoke('shell:openExtension'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },
});
