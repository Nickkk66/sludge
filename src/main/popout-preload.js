'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The detached caption window only ever receives updates and sends back the
// two commands its buttons offer.
contextBridge.exposeInMainWorld('popout', {
  onUpdate: (cb) => ipcRenderer.on('popout:update', (_e, msg) => cb(msg)),
  command: (name) => ipcRenderer.send('popout:command', name)
});
