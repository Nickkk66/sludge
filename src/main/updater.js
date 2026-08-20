'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { app, shell, dialog } = require('electron');

/**
 * Update checking, without an auto-updater.
 *
 * The app is unsigned and distributed straight from GitHub, so it can't install
 * updates itself. Instead it checks the releases feed on launch, points you at
 * the download, and — once you're running the newer build — offers to clear out
 * the older copy it can still find on disk.
 */

const REPO = process.env.SLUDGE_REPO || 'Nickkk66/sludge';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** Compare dotted versions. Returns 1 if a is newer than b. */
function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/i, '').split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate() {
  const current = app.getVersion();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Sludge/${current}` },
      signal: ctrl.signal
    });
    clearTimeout(timer);

    // No releases yet is the normal case early on, not a failure worth surfacing.
    if (res.status === 404) return { current, upToDate: true, noReleases: true };
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);

    const data = await res.json();
    const latest = String(data.tag_name || data.name || '').trim();
    if (!latest) return { current, upToDate: true };

    const newer = compareVersions(latest, current) > 0;
    return {
      current,
      latest: latest.replace(/^v/i, ''),
      upToDate: !newer,
      url: data.html_url || RELEASES_PAGE,
      notes: (data.body || '').slice(0, 600),
      publishedAt: data.published_at || null
    };
  } catch (err) {
    return { current, upToDate: true, error: String((err && err.message) || err) };
  }
}

function openReleasePage(url) {
  shell.openExternal(url || RELEASES_PAGE);
}

/* ------------------------------------------------------- old copies */

const SEARCH_DIRS = () => [
  '/Applications',
  path.join(os.homedir(), 'Applications'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Desktop')
];

async function bundleVersion(appPath) {
  try {
    const plist = await fsp.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Find copies of Sludge on disk that are older than the one running, ignoring
 * the bundle we were launched from.
 */
async function findOldCopies() {
  if (process.platform !== 'darwin') return [];
  const current = app.getVersion();
  const running = app.getPath('exe').split('/Contents/MacOS/')[0];
  const found = [];

  for (const dir of SEARCH_DIRS()) {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^Sludge.*\.app$/i.test(name)) continue;
      const full = path.join(dir, name);
      if (full === running) continue;
      const version = await bundleVersion(full);
      if (!version || compareVersions(version, current) >= 0) continue;
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch { /* size is cosmetic */ }
      found.push({ path: full, version, size });
    }
  }
  return found;
}

/**
 * Offer to move superseded copies to the Trash. Always asks, always trashes
 * rather than deleting — an app bundle is not something to remove silently.
 */
async function offerCleanup(win) {
  const old = await findOldCopies();
  if (!old.length) return { removed: 0 };

  const list = old.map((o) => `  •  ${o.path.replace(os.homedir(), '~')}  (v${o.version})`).join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Move to Trash', 'Keep them'],
    defaultId: 0,
    cancelId: 1,
    message: `You're now running Sludge ${app.getVersion()}.`,
    detail: `Found ${old.length === 1 ? 'an older copy' : `${old.length} older copies`} still on disk:\n\n${list}\n\nMove ${old.length === 1 ? 'it' : 'them'} to the Trash?`
  });
  if (response !== 0) return { removed: 0, declined: true };

  let removed = 0;
  const failed = [];
  for (const o of old) {
    try {
      await shell.trashItem(o.path);
      removed += 1;
    } catch (err) {
      failed.push(`${o.path}: ${err.message}`);
    }
  }
  return { removed, failed };
}

module.exports = { checkForUpdate, openReleasePage, findOldCopies, offerCleanup, compareVersions, RELEASES_PAGE };
