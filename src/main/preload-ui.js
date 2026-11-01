'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tide', {
  action: (type, payload = {}) => ipcRenderer.invoke('ui:action', { type, ...payload }),
  getState: () => ipcRenderer.invoke('ui:state'),
  onState: (cb) => ipcRenderer.on('ui:state', (_e, s) => cb(s)),
  onCommand: (cb) => ipcRenderer.on('ui:command', (_e, c) => cb(c)),
});
