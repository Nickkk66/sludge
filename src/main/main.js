'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const store = require('./store');
const ollama = require('./ollama');
const { retrieve } = require('./retrieval');
const media = require('./media');
const updater = require('./updater');
const digest = require('./digest');
const buildMenu = require('./menu');

// Without this the dock tile, the menu bar and the About panel all say
// "Electron" when the app is run unpackaged.
app.setName('Sludge');

let win = null;
let rendererReady = false;
const activeDownloads = new Map();

// Video files live outside the app bundle, so they get their own scheme rather
// than loosening the renderer's file access. Streaming lets a 200 MB video
// start playing without being read into memory.
protocol.registerSchemesAsPrivileged([
  { scheme: 'sludge-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);
// A PDF path passed on the command line (or handed over by Finder) opens once
// the window is ready.
let pendingOpenPath = process.argv.slice(1).find((a) => /\.pdf$/i.test(a)) || null;
const activeStreams = new Map();

function createWindow() {
  win = new BrowserWindow({
    title: 'Sludge',
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

  protocol.handle('sludge-media', (request) => {
    const name = request.url.replace(/^sludge-media:\/\//, '').split('?')[0];
    return net.fetch(pathToFileURL(media.resolve(name)).toString());
  });

  createWindow();
  Menu.setApplicationMenu(buildMenu(() => win));
  if (process.platform === 'darwin' && app.dock) {
    // In a packaged build macOS uses the bundle icon; this covers `npm start`.
    const icon = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    if (fs.existsSync(icon)) app.dock.setIcon(icon);
  }
  runStartupChecks();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * On launch: notice a newer release, and — if this run is a version bump —
 * offer to clear out the copy that was superseded.
 */
async function runStartupChecks() {
  const settings = await store.getSettings();
  const current = app.getVersion();

  if (settings.lastRunVersion && updater.compareVersions(current, settings.lastRunVersion) > 0) {
    // Give the window a moment to paint before putting a dialog over it.
    setTimeout(async () => {
      const result = await updater.offerCleanup(win).catch(() => null);
      if (result && result.removed && win && !win.webContents.isDestroyed()) {
        win.webContents.send('update:cleaned', result);
      }
    }, 1400);
  }
  await store.saveSettings({ lastRunVersion: current });

  if (settings.checkUpdates === false) return;
  const info = await updater.checkForUpdate();
  if (!info.upToDate && win && !win.webContents.isDestroyed()) {
    win.webContents.send('update:available', info);
  }
}

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

/* -------------------------------------------------------- question sheets */

const { execFile } = require('child_process');

/** Convert a Word/RTF/Pages-exported file to plain text using macOS's own tool. */
function textutilToText(filePath) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

handle('questions:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open a question sheet',
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'markdown', 'rtf', 'doc', 'docx', 'pdf'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

handle('questions:read', async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);

  if (ext === '.pdf') {
    // Hand the bytes back; the renderer already has pdf.js loaded to read them.
    const bytes = await fsp.readFile(filePath);
    return { name, kind: 'pdf', bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }

  if (['.doc', '.docx', '.rtf'].includes(ext)) {
    try {
      return { name, kind: 'text', text: await textutilToText(filePath) };
    } catch (err) {
      throw new Error(`Could not read ${name}: ${err.message}`);
    }
  }

  return { name, kind: 'text', text: await fsp.readFile(filePath, 'utf8') };
});

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

/* -------------------------------------------------------- updates */

handle('update:check', async () => updater.checkForUpdate());
handle('update:open', async (url) => { updater.openReleasePage(url); return true; });
handle('update:oldCopies', async () => updater.findOldCopies());
handle('update:cleanup', async () => updater.offerCleanup(win));
handle('app:version', async () => app.getVersion());

// Deep-link into the pane where macOS hides its better voices.
handle('voices:openSettings', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent');
  return true;
});

// A downloaded system voice sometimes only appears to Chromium after a restart.
handle('app:restart', async () => {
  app.relaunch();
  app.exit(0);
  return true;
});

handle('theme:set', async (theme) => {
  nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
  return theme;
});

/* ---------------------------------------------------------------- AI IPC */

handle('ai:status', async (autostart) => ollama.status({ autostart: autostart !== false }));

handle('ai:warm', async (model) => ollama.warm(model));

handle('ai:rewrite', async (payload) => ollama.rewrite(payload));

handle('ai:retrieve', async ({ query, docId, annotations, currentPage }) => {
  const index = await store.getTextIndex(docId);
  const pages = (index && index.pages) || [];
  const scan = await digest.load(docId);
  return retrieve({ query, pages, annotations: annotations || [], digest: scan, currentPage });
});

/* -------------------------------------------------------- full scan */

handle('scan:status', async ({ docId, pages, chapters, params }) => {
  const existing = await digest.load(docId);
  const est = digest.estimate(pages || [], chapters || [], params);
  return {
    scanned: !!(existing && existing.complete),
    partial: !!(existing && !existing.complete && existing.blocks.length),
    blocks: existing ? existing.blocks.length : 0,
    builtWith: existing ? existing.model : null,
    built: existing ? existing.built : null,
    running: digest.isRunning(docId),
    estimate: est
  };
});

handle('scan:clear', async (docId) => digest.remove(docId));

ipcMain.on('scan:start', async (event, { docId, model, docName, pages, chapters }) => {
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, { docId, ...payload });
  };
  try {
    const result = await digest.build(
      { docId, model, docName, pages: pages || [], chapters: chapters || [] },
      (p) => send('scan:progress', p)
    );
    send('scan:done', { ok: true, complete: result.complete, blocks: result.blocks.length });
  } catch (err) {
    send('scan:done', { ok: false, error: String((err && err.message) || err) });
  }
});

ipcMain.on('scan:cancel', (_e, docId) => digest.cancel(docId));

// Streaming answers use send/on rather than handle so tokens arrive live.
// Greetings and "what can you do" are not questions about the document.
// Running retrieval on them fed the model six random pages and produced
// confident nonsense, so they get answered directly.
const CHITCHAT = /^\s*(hi|hey|hello|yo|sup|hiya|howdy|good (morning|afternoon|evening)|thanks?|thank you|ty|ok(ay)?|cool|nice|test|ping)\b[\s!.?]*$/i;
const CAPABILITY = /^\s*(what can you do|what do you do|who are you|what are you|help|how do (i|you) (use|work)|what is this)\b[\s!.?]*$/i;

function smallTalkReply(query, docName, noteCount, readerName) {
  const hi = readerName ? `Hey ${readerName}` : 'Hey';
  if (CAPABILITY.test(query)) {
    return `I read **${docName || 'this PDF'}** and your own highlights and notes, and answer from both.\n\n` +
      `Try asking:\n` +
      `- "Summarize the chapter around page 112."\n` +
      `- "What do my notes say about taxation?"\n` +
      `- "Make five exam questions from this section."\n\n` +
      `I cite the book as [p. 112] and always say when something came from your notes. ` +
      `You currently have **${noteCount}** note${noteCount === 1 ? '' : 's'} in this document.`;
  }
  return `${hi} — ask me something about **${docName || 'this PDF'}** or about your notes and I'll dig through both. ` +
    `I only answer from what's actually in the document, so be as specific as you like.`;
}

ipcMain.on('ai:ask', async (event, { streamId, query, docId, docName, model, annotations, history, profile, readerName, currentPage }) => {
  const reply = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, { streamId, ...payload });
  };
  try {
    if (CHITCHAT.test(query) || CAPABILITY.test(query)) {
      reply('ai:done', { text: smallTalkReply(query, docName, (annotations || []).length, readerName), smallTalk: true });
      return;
    }
    const index = await store.getTextIndex(docId);
    const pages = (index && index.pages) || [];
    const scan = await digest.load(docId);
    const evidence = retrieve({ query, pages, annotations: annotations || [], digest: scan, currentPage });
    reply('ai:evidence', { evidence });

    if (!evidence.pages.length && !evidence.notes.length && !(evidence.overview || []).length) {
      reply('ai:done', {
        text: "I couldn't find anything in this document or your notes that matches that. Try naming a term, person, or event the way the book would phrase it.",
        empty: true
      });
      return;
    }

    const { promise, controller } = ollama.chat(
      { model, query, evidence, docName, history, profile },
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
