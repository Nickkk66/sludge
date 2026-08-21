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

  questions: {
    pick: () => call('questions:pick'),
    read: (filePath) => call('questions:read', filePath)
  },
  pickAiFiles: () => call('ai:pickFiles'),

  ocr: {
    page: (payload) => call('ocr:page', payload),
    buffer: (payload) => call('ocr:buffer', payload),
    cache: (docId) => call('ocr:cache', docId)
  },

  tts: {
    status: () => call('tts:status'),
    preview: (id) => call('tts:preview', id),
    remove: (id) => call('tts:remove', id),
    synth: (payload) => call('tts:synth', payload),
    install: (id) => ipcRenderer.send('tts:install', { id }),
    cancel: (id) => ipcRenderer.send('tts:cancel', id),
    onProgress: (cb) => ipcRenderer.on('tts:progress', (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on('tts:done', (_e, p) => cb(p))
  },

  popout: {
    open: (bounds) => call('popout:open', bounds),
    close: () => call('popout:close'),
    isOpen: () => call('popout:isOpen'),
    update: (msg) => ipcRenderer.send('popout:update', msg),
    onCommand: (cb) => ipcRenderer.on('popout:command', (_e, name) => cb(name)),
    onClosed: (cb) => ipcRenderer.on('popout:closed', () => cb())
  },

  update: {
    check: () => call('update:check'),
    open: (url) => call('update:open', url),
    oldCopies: () => call('update:oldCopies'),
    cleanup: () => call('update:cleanup'),
    version: () => call('app:version'),
    onAvailable: (cb) => ipcRenderer.on('update:available', (_e, p) => cb(p)),
    onCleaned: (cb) => ipcRenderer.on('update:cleaned', (_e, p) => cb(p))
  },

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
  openVoiceSettings: () => call('voices:openSettings'),
  restart: () => call('app:restart'),

  ai: {
    status: (autostart) => call('ai:status', autostart),
    retrieve: (payload) => call('ai:retrieve', payload),
    warm: (model) => call('ai:warm', model),
    rewrite: (payload) => call('ai:rewrite', payload),
    story: (payload) => call('ai:story', payload),
    ask: (payload) => ipcRenderer.send('ai:ask', payload),
    stop: (streamId) => ipcRenderer.send('ai:stop', streamId),
    onToken: (cb) => ipcRenderer.on('ai:token', (_e, p) => cb(p)),
    onEvidence: (cb) => ipcRenderer.on('ai:evidence', (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on('ai:done', (_e, p) => cb(p)),
    onError: (cb) => ipcRenderer.on('ai:error', (_e, p) => cb(p))
  },

  scan: {
    status: (payload) => call('scan:status', payload),
    clear: (docId) => call('scan:clear', docId),
    start: (payload) => ipcRenderer.send('scan:start', payload),
    cancel: (docId) => ipcRenderer.send('scan:cancel', docId),
    onProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on('scan:done', (_e, p) => cb(p))
  },

  // Electron 32 removed File.path; this is the supported replacement.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },

  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action))
});
