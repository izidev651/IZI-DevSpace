'use strict';
// Only the built-in tide:// pages (e.g. the New Tab page) get a bridge.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'tide:') {
  contextBridge.exposeInMainWorld('tideNewTab', {
    getSettings: () => ipcRenderer.invoke('newtab:settings'),
    setSettings: (patch) => ipcRenderer.invoke('newtab:set', patch),
    navigate: (input) => ipcRenderer.invoke('newtab:navigate', input),
    onSettings: (cb) => ipcRenderer.on('newtab:settings-changed', (_e, s) => cb(s)),
  });
}
