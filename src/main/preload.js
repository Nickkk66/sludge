'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((res) => {
  if (!res || res.ok !== true) throw new Error((res && res.error) || `${channel} failed`);
  return res.data;
});

contextBridge.exposeInMainWorld('api', {
  ready: () => call('app:ready'),
  pickPdf: () => call('dialog:openPdf'),
  openDoc: (filePath) => call('doc:open', filePath),
  saveDoc: (filePath, docId, payload) => call('doc:save', filePath, docId, payload),
  revealSidecar: (filePath, docId) => call('doc:revealSidecar', filePath, docId),

  library: {
    list: () => call('library:list'),
    upsert: (entry) => call('library:upsert', entry),
    remove: (docId) => call('library:remove', docId)
  },

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch)
  },

  index: {
    get: (docId) => call('index:get', docId),
    save: (docId, pages) => call('index:save', docId, pages)
  },

  exportNotes: (defaultName, content) => call('export:save', defaultName, content),

  media: {
    list: () => call('media:list'),
    remove: (id) => call('media:remove', id),
    reveal: () => call('media:reveal'),
    download: (id) => ipcRenderer.send('media:download', { id }),
    cancel: (id) => ipcRenderer.send('media:cancel', id),
    onProgress: (cb) => ipcRenderer.on('media:progress', (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on('media:done', (_e, p) => cb(p))
  },
  setTheme: (theme) => call('theme:set', theme),

  ai: {
    status: (autostart) => call('ai:status', autostart),
    retrieve: (payload) => call('ai:retrieve', payload),
    warm: (model) => call('ai:warm', model),
    rewrite: (payload) => call('ai:rewrite', payload),
    ask: (payload) => ipcRenderer.send('ai:ask', payload),
    stop: (streamId) => ipcRenderer.send('ai:stop', streamId),
    onToken: (cb) => ipcRenderer.on('ai:token', (_e, p) => cb(p)),
    onEvidence: (cb) => ipcRenderer.on('ai:evidence', (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on('ai:done', (_e, p) => cb(p)),
    onError: (cb) => ipcRenderer.on('ai:error', (_e, p) => cb(p))
  },

  // Electron 32 removed File.path; this is the supported replacement.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },

  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action))
});
