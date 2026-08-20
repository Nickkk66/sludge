'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const userDir = () => app.getPath('userData');
const libraryPath = () => path.join(userDir(), 'library.json');
const settingsPath = () => path.join(userDir(), 'settings.json');
const indexDir = () => path.join(userDir(), 'text-index');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  aiModel: null,
  aiEnabled: true,
  defaultColor: '#f6d34a',
  autoNote: true,
  zoom: 1,
  lastDocId: null,
  spread: 'single'
};

async function ensureDirs() {
  await fsp.mkdir(indexDir(), { recursive: true });
}

async function readJSON(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/* ---------- settings ---------- */

async function getSettings() {
  const s = await readJSON(settingsPath(), {});
  return { ...DEFAULT_SETTINGS, ...s };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await writeJSON(settingsPath(), next);
  return next;
}

/* ---------- doc identity ---------- */

// Fingerprint a file cheaply: size + hash of head and tail chunks.
// Stable for a given PDF even if it moves or is renamed.
async function fingerprint(filePath) {
  const stat = await fsp.stat(filePath);
  const size = stat.size;
  const chunk = Math.min(512 * 1024, size);
  const fd = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(chunk);
    await fd.read(head, 0, chunk, 0);
    const tail = Buffer.alloc(chunk);
    await fd.read(tail, 0, chunk, Math.max(0, size - chunk));
    const h = crypto.createHash('sha256');
    h.update(String(size));
    h.update(head);
    h.update(tail);
    return h.digest('hex').slice(0, 32);
  } finally {
    await fd.close();
  }
}

/* ---------- sidecar annotations ---------- */

function sidecarFor(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/\.pdf$/i, '');
  return path.join(dir, `${base}.notes.json`);
}

// Fallback location when the PDF sits somewhere unwritable (read-only volume,
// downloads quarantine, etc.). Keyed by docId so it survives renames.
function fallbackSidecar(docId) {
  return path.join(userDir(), 'sidecars', `${docId}.notes.json`);
}

function emptyDoc(docId, filePath) {
  return {
    version: 1,
    docId,
    file: { name: path.basename(filePath), path: filePath },
    annotations: [],
    lastPosition: null,
    updated: new Date().toISOString()
  };
}

async function loadAnnotations(filePath, docId) {
  const primary = sidecarFor(filePath);
  const fallback = fallbackSidecar(docId);
  for (const p of [primary, fallback]) {
    const data = await readJSON(p, null);
    if (data && Array.isArray(data.annotations)) {
      data.sidecarPath = p;
      return data;
    }
  }
  const doc = emptyDoc(docId, filePath);
  doc.sidecarPath = primary;
  return doc;
}

async function saveAnnotations(filePath, docId, doc) {
  const payload = {
    version: 1,
    docId,
    file: { name: path.basename(filePath), path: filePath },
    annotations: doc.annotations || [],
    lastPosition: doc.lastPosition || null,
    updated: new Date().toISOString()
  };
  const primary = sidecarFor(filePath);
  try {
    await writeJSON(primary, payload);
    return { ok: true, path: primary };
  } catch (err) {
    const fallback = fallbackSidecar(docId);
    await writeJSON(fallback, payload);
    return { ok: true, path: fallback, note: `Saved to app storage (${err.code || 'unwritable'})` };
  }
}

/* ---------- library ---------- */

async function getLibrary() {
  const lib = await readJSON(libraryPath(), { docs: [] });
  if (!Array.isArray(lib.docs)) lib.docs = [];
  // Drop entries whose file has vanished.
  lib.docs = lib.docs.filter((d) => d && d.path && fs.existsSync(d.path));
  return lib;
}

async function upsertLibraryDoc(entry) {
  const lib = await getLibrary();
  const i = lib.docs.findIndex((d) => d.docId === entry.docId);
  if (i >= 0) lib.docs[i] = { ...lib.docs[i], ...entry };
  else lib.docs.unshift(entry);
  lib.docs.sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''));
  await writeJSON(libraryPath(), lib);
  return lib;
}

async function removeLibraryDoc(docId) {
  const lib = await getLibrary();
  lib.docs = lib.docs.filter((d) => d.docId !== docId);
  await writeJSON(libraryPath(), lib);
  return lib;
}

/* ---------- extracted text cache (search + AI) ---------- */

const textIndexPath = (docId) => path.join(indexDir(), `${docId}.json`);

async function getTextIndex(docId) {
  return readJSON(textIndexPath(docId), null);
}

async function saveTextIndex(docId, pages) {
  await writeJSON(textIndexPath(docId), { docId, pages, built: new Date().toISOString() });
  return true;
}

module.exports = {
  ensureDirs,
  getSettings,
  saveSettings,
  fingerprint,
  sidecarFor,
  loadAnnotations,
  saveAnnotations,
  getLibrary,
  upsertLibraryDoc,
  removeLibraryDoc,
  getTextIndex,
  saveTextIndex
};
