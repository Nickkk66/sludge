'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

/**
 * Focus-video packs.
 *
 * The app ships without any video — packs are downloaded on demand from a
 * release URL, so adding a new one later means publishing a file, not shipping
 * a new build. Files land in the user's app-data folder and are served to the
 * renderer through the custom `sludge-media://` protocol.
 */

const mediaDir = () => path.join(app.getPath('userData'), 'media');
const catalogPath = () => path.join(app.getPath('userData'), 'media-catalog.json');

// Where `download` looks for packs. Overridable so anyone can point the app at
// their own release without touching the code.
const DEFAULT_BASE =
  process.env.SLUDGE_MEDIA_BASE ||
  'https://github.com/Nickkk66/sludge/releases/download/media-v1';

const BUILT_IN = [
  {
    id: 'subway-surfers',
    name: 'Subway Surfers',
    description: 'Endless-runner gameplay. Busy, colourful, no thinking required.',
    file: 'subway-surfers.mp4',
    approxBytes: 185_000_000
  },
  {
    id: 'minecraft-parkour',
    name: 'Minecraft Parkour',
    description: 'Parkour runs. Calmer than Subway Surfers, still constant motion.',
    file: 'minecraft-parkour.mp4',
    approxBytes: 227_000_000
  }
];

async function ensureDir() {
  await fsp.mkdir(mediaDir(), { recursive: true });
}

async function readCatalog() {
  try {
    const raw = await fsp.readFile(catalogPath(), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.packs)) return data;
  } catch { /* fall through to the built-in list */ }
  return { base: DEFAULT_BASE, packs: BUILT_IN };
}

/** Packs with their install state, for the picker. */
async function list() {
  await ensureDir();
  const catalog = await readCatalog();
  const packs = [];
  for (const p of catalog.packs) {
    const file = path.join(mediaDir(), p.file);
    let size = 0;
    let installed = false;
    try {
      const st = await fsp.stat(file);
      size = st.size;
      // A partial download would play as a broken file; treat tiny files as absent.
      installed = size > 1_000_000;
    } catch { /* not installed */ }
    packs.push({ ...p, installed, size, url: `sludge-media://${encodeURIComponent(p.file)}` });
  }
  return { base: catalog.base || DEFAULT_BASE, packs };
}

async function remove(id) {
  const { packs } = await list();
  const pack = packs.find((p) => p.id === id);
  if (!pack) throw new Error('Unknown pack');
  await fsp.rm(path.join(mediaDir(), pack.file), { force: true });
  return true;
}

/**
 * Stream a pack to disk, reporting progress. Downloads to a .part file and
 * renames on success so an interrupted download never looks installed.
 */
async function download(id, onProgress, signal) {
  await ensureDir();
  const catalog = await readCatalog();
  const pack = catalog.packs.find((p) => p.id === id);
  if (!pack) throw new Error('Unknown pack');

  const base = (catalog.base || DEFAULT_BASE).replace(/\/+$/, '');
  const url = pack.url && /^https?:/i.test(pack.url) ? pack.url : `${base}/${pack.file}`;
  const dest = path.join(mediaDir(), pack.file);
  const tmp = `${dest}.part`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed (${res.status}) — ${url}`);

  const total = Number(res.headers.get('content-length')) || pack.approxBytes || 0;
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let lastPing = 0;

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
      const now = Date.now();
      if (onProgress && now - lastPing > 200) {
        lastPing = now;
        onProgress({ received, total });
      }
    }
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  await fsp.rename(tmp, dest);
  if (onProgress) onProgress({ received, total: total || received, done: true });
  return { id, file: pack.file, size: received };
}

/** Resolve a `sludge-media://` request to a real path inside the media dir. */
function resolve(name) {
  const safe = path.basename(decodeURIComponent(name));
  return path.join(mediaDir(), safe);
}

module.exports = { list, download, remove, resolve, mediaDir, ensureDir, DEFAULT_BASE };
