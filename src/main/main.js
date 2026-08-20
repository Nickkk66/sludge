'use strict';
const path = require('path');
const fsp = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const store = require('./store');
const ollama = require('./ollama');
const { retrieve } = require('./retrieval');
const media = require('./media');
const buildMenu = require('./menu');

let win = null;
let rendererReady = false;
const activeDownloads = new Map();

// Video files live outside the app bundle, so they get their own scheme rather
// than loosening the renderer's file access. Streaming lets a 200 MB video
// start playing without being read into memory.
protocol.registerSchemesAsPrivileged([
  { scheme: 'marginalia-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);
// A PDF path passed on the command line (or handed over by Finder) opens once
// the window is ready.
let pendingOpenPath = process.argv.slice(1).find((a) => /\.pdf$/i.test(a)) || null;
const activeStreams = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#1b1d22',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 24 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
    // Mirror renderer console into the terminal so a headless run is debuggable.
    win.webContents.on('console-message', (...args) => {
      // Electron 34 passes a details object; older builds pass positional args.
      const d = args[0] && typeof args[0] === 'object' && 'message' in args[0]
        ? args[0]
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      console.log(`[renderer:${d.level}] ${d.message}  (${String(d.sourceId || '').split('/').pop()}:${d.lineNumber})`);
    });
    win.webContents.on('render-process-gone', (_e, details) => console.log('[renderer gone]', details));
    win.webContents.on('preload-error', (_e, p, err) => console.log('[preload error]', p, err));
  }

  // Keep the app self-contained: external links go to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  // Before the renderer signals readiness it has no listener yet, so hold the
  // path and let it pull on boot instead of firing into the void.
  if (rendererReady && win) win.webContents.send('open-file', filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(async () => {
  await store.ensureDirs();
  await media.ensureDir();

  protocol.handle('marginalia-media', (request) => {
    const name = request.url.replace(/^marginalia-media:\/\//, '').split('?')[0];
    return net.fetch(pathToFileURL(media.resolve(name)).toString());
  });

  createWindow();
  Menu.setApplicationMenu(buildMenu(() => win));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ IPC */

const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// The renderer pulls any file queued before it was listening.
handle('app:ready', async () => {
  rendererReady = true;
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p;
});

handle('dialog:openPdf', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

handle('doc:open', async (filePath) => {
  const bytes = await fsp.readFile(filePath);
  const docId = await store.fingerprint(filePath);
  const sidecar = await store.loadAnnotations(filePath, docId);
  return {
    docId,
    filePath,
    name: path.basename(filePath),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    annotations: sidecar.annotations,
    lastPosition: sidecar.lastPosition,
    document: sidecar.document || { markdown: '', updated: null },
    sidecarPath: sidecar.sidecarPath
  };
});

handle('doc:save', async (filePath, docId, payload) => store.saveAnnotations(filePath, docId, payload));

handle('doc:revealSidecar', async (filePath, docId) => {
  const sidecar = await store.loadAnnotations(filePath, docId);
  shell.showItemInFolder(sidecar.sidecarPath);
  return sidecar.sidecarPath;
});

handle('library:list', async () => store.getLibrary());
handle('library:upsert', async (entry) => store.upsertLibraryDoc(entry));
handle('library:remove', async (docId) => store.removeLibraryDoc(docId));

handle('settings:get', async () => store.getSettings());
handle('settings:set', async (patch) => store.saveSettings(patch));

handle('index:get', async (docId) => store.getTextIndex(docId));
handle('index:save', async (docId, pages) => store.saveTextIndex(docId, pages));

handle('export:save', async (defaultName, content) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export notes',
    defaultPath: defaultName,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });
  if (res.canceled || !res.filePath) return null;
  await fsp.writeFile(res.filePath, content, 'utf8');
  return res.filePath;
});

/* -------------------------------------------------------- focus video */

handle('media:list', async () => media.list());
handle('media:remove', async (id) => media.remove(id));
handle('media:reveal', async () => {
  shell.showItemInFolder(media.mediaDir());
  return media.mediaDir();
});

ipcMain.on('media:download', async (event, { id }) => {
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, { id, ...payload });
  };
  if (activeDownloads.has(id)) return;
  const ctrl = new AbortController();
  activeDownloads.set(id, ctrl);
  try {
    await media.download(id, (p) => send('media:progress', p), ctrl.signal);
    send('media:done', { ok: true });
  } catch (err) {
    const msg = String((err && err.message) || err);
    send('media:done', { ok: false, error: /abort/i.test(msg) ? 'Cancelled' : msg });
  } finally {
    activeDownloads.delete(id);
  }
});

ipcMain.on('media:cancel', (_e, id) => {
  const ctrl = activeDownloads.get(id);
  if (ctrl) ctrl.abort();
});

handle('theme:set', async (theme) => {
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
  return theme;
});

/* ---------------------------------------------------------------- AI IPC */

handle('ai:status', async (autostart) => ollama.status({ autostart: autostart !== false }));

handle('ai:warm', async (model) => ollama.warm(model));

handle('ai:rewrite', async (payload) => ollama.rewrite(payload));

handle('ai:retrieve', async ({ query, docId, annotations }) => {
  const index = await store.getTextIndex(docId);
  const pages = (index && index.pages) || [];
  return retrieve({ query, pages, annotations: annotations || [] });
});

// Streaming answers use send/on rather than handle so tokens arrive live.
// Greetings and "what can you do" are not questions about the document.
// Running retrieval on them fed the model six random pages and produced
// confident nonsense, so they get answered directly.
const CHITCHAT = /^\s*(hi|hey|hello|yo|sup|hiya|howdy|good (morning|afternoon|evening)|thanks?|thank you|ty|ok(ay)?|cool|nice|test|ping)\b[\s!.?]*$/i;
const CAPABILITY = /^\s*(what can you do|what do you do|who are you|what are you|help|how do (i|you) (use|work)|what is this)\b[\s!.?]*$/i;

function smallTalkReply(query, docName, noteCount) {
  if (CAPABILITY.test(query)) {
    return `I read **${docName || 'this PDF'}** and your own highlights and notes, and answer from both.\n\n` +
      `Try asking:\n` +
      `- "Summarize the chapter around page 112."\n` +
      `- "What do my notes say about taxation?"\n` +
      `- "Make five exam questions from this section."\n\n` +
      `I cite the book as [p. 112] and always say when something came from your notes. ` +
      `You currently have **${noteCount}** note${noteCount === 1 ? '' : 's'} in this document.`;
  }
  return `Hey — ask me something about **${docName || 'this PDF'}** or about your notes and I'll dig through both. ` +
    `I only answer from what's actually in the document, so be as specific as you like.`;
}

ipcMain.on('ai:ask', async (event, { streamId, query, docId, docName, model, annotations, history }) => {
  const reply = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, { streamId, ...payload });
  };
  try {
    if (CHITCHAT.test(query) || CAPABILITY.test(query)) {
      reply('ai:done', { text: smallTalkReply(query, docName, (annotations || []).length), smallTalk: true });
      return;
    }
    const index = await store.getTextIndex(docId);
    const pages = (index && index.pages) || [];
    const evidence = retrieve({ query, pages, annotations: annotations || [] });
    reply('ai:evidence', { evidence });

    if (!evidence.pages.length && !evidence.notes.length) {
      reply('ai:done', {
        text: "I couldn't find anything in this document or your notes that matches that. Try naming a term, person, or event the way the book would phrase it.",
        empty: true
      });
      return;
    }

    const { promise, controller } = ollama.chat(
      { model, query, evidence, docName, history },
      (token) => reply('ai:token', { token })
    );
    activeStreams.set(streamId, controller);
    const text = await promise;
    reply('ai:done', { text, evidence });
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/abort/i.test(msg)) reply('ai:done', { text: '', aborted: true });
    else reply('ai:error', { error: msg });
  } finally {
    activeStreams.delete(streamId);
  }
});

ipcMain.on('ai:stop', (_e, streamId) => {
  const ctrl = activeStreams.get(streamId);
  if (ctrl) ctrl.abort();
});
