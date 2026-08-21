'use strict';
const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { app } = require('electron');
const { execFile } = require('child_process');

/**
 * OCR for scanned PDFs, through Apple's on-device Vision framework.
 *
 * Plenty of textbooks are pure page images with no text layer at all — nothing
 * for selection, search, read-aloud or the AI to hold on to. The renderer
 * sends a rendered page image here; a small bundled helper returns recognized
 * lines with their positions, and the result is cached per document so a page
 * is only ever recognized once.
 */

function helperPath() {
  const base = app.getAppPath();
  // Executables cannot run from inside the asar archive.
  const root = base.includes('app.asar') ? base.replace('app.asar', 'app.asar.unpacked') : base;
  return path.join(root, 'assets', 'bin', 'sludge-ocr');
}

const cacheDir = () => path.join(app.getPath('userData'), 'ocr');
const cachePath = (docId) => path.join(cacheDir(), `${docId}.json`);

async function loadCache(docId) {
  try {
    return JSON.parse(await fsp.readFile(cachePath(docId), 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(docId, cache) {
  await fsp.mkdir(cacheDir(), { recursive: true });
  const tmp = `${cachePath(docId)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fsp.rename(tmp, cachePath(docId));
}

/** Recognize one page image; returns [{t, x, y, w, h, c}] in top-left fractions. */
function recognize(imagePath) {
  return new Promise((resolve, reject) => {
    execFile(helperPath(), [imagePath], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`OCR failed: ${err.message}`));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('OCR returned malformed output')); }
      });
  });
}

async function ocrPage({ docId, page, png }) {
  const cache = await loadCache(docId);
  if (cache[page]) return cache[page];

  const tmp = path.join(os.tmpdir(), `sludge-ocr-${process.pid}-${page}.png`);
  await fsp.writeFile(tmp, Buffer.from(png));
  try {
    // Low-confidence fragments are speckle and margin noise, not words.
    const lines = (await recognize(tmp)).filter((l) => l.c > 0.3 && l.t.trim());
    cache[page] = lines;
    await saveCache(docId, cache);
    return lines;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

module.exports = { ocrPage, loadCache, helperPath };
