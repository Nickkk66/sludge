import { $, el, toast, fmtSize } from './util.js';
import { state } from './state.js';

/**
 * The focus-video strip: a silent, looping gameplay clip along the bottom.
 *
 * Video packs are add-ons rather than part of the app — the picker downloads
 * them on demand, so the build stays small and new packs need only a published
 * file, not a new release of the app.
 */

let packs = [];
let current = null;
let dock = 'bottom';
const downloading = new Map();

const DOCKS = ['bottom', 'top', 'left', 'right'];
const isVertical = () => dock === 'left' || dock === 'right';

const video = () => $('#focusVideo');

/* ------------------------------------------------------------ strip */

export function showStrip(pack) {
  current = pack;
  const strip = $('#videostrip');
  const v = video();
  strip.hidden = false;
  document.body.classList.add('video-on');
  setDock(dock);
  $('#vsName').textContent = pack.name;
  if (v.dataset.pack !== pack.id) {
    v.dataset.pack = pack.id;
    v.src = pack.url;
  }
  v.muted = true;                     // the read-aloud voice owns the audio
  v.play().catch(() => {});
  syncPlayIcon();
  window.api.settings.set({ focusPack: pack.id, focusOn: true }).catch(() => {});
}

/**
 * Move the strip to an edge. Docked to a side it becomes a tall portrait crop —
 * the runner stays centred, so you see far more of the action than a short
 * letterbox along the bottom.
 */
export function setDock(next) {
  if (!DOCKS.includes(next)) return;
  dock = next;
  for (const d of DOCKS) document.body.classList.toggle(`video-${d}`, d === next);
  for (const btn of document.querySelectorAll('.vs-dock')) {
    btn.classList.toggle('on', btn.dataset.dock === next);
  }
  window.api.settings.set({ focusDock: next }).catch(() => {});
}

export function hideStrip() {
  const v = video();
  v.pause();
  $('#videostrip').hidden = true;
  document.body.classList.remove('video-on');
  window.api.settings.set({ focusOn: false }).catch(() => {});
}

function syncPlayIcon() {
  const paused = video().paused;
  $('#vsPlay').innerHTML = paused
    ? '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5.5h3v13H8zM13 5.5h3v13h-3z"/></svg>';
}

/** Cycle to the next installed pack. */
function swapPack() {
  const installed = packs.filter((p) => p.installed);
  if (installed.length < 2) return toast('Only one video pack is installed.');
  const at = installed.findIndex((p) => current && p.id === current.id);
  showStrip(installed[(at + 1) % installed.length]);
}

/* ------------------------------------------------------------ picker */

export async function openPicker() {
  $('#focusModal').classList.remove('hidden');
  await renderPacks();
}

export function closePicker() {
  $('#focusModal').classList.add('hidden');
}

async function renderPacks() {
  const data = await window.api.media.list();
  packs = data.packs;
  const box = $('#focusPacks');
  box.replaceChildren(...packs.map(packRow));
  if (!packs.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'No video packs are configured.'));
  }
}

function packRow(p) {
  const row = el('div', {
    class: `pack${current && current.id === p.id && !$('#videostrip').hidden ? ' playing' : ''}`,
    'data-id': p.id
  },
    el('div', { class: 'pack-info' },
      el('b', {}, p.name),
      el('small', {}, p.installed
        ? `${p.description}  ·  ${fmtSize(p.size)} installed`
        : `${p.description}  ·  about ${fmtSize(p.approxBytes)} to download`)
    )
  );

  const actions = el('div', { class: 'pack-actions' });
  if (downloading.has(p.id)) {
    row.append(progressBlock(p.id));
    actions.append(el('button', { onclick: () => window.api.media.cancel(p.id) }, 'Cancel'));
  } else if (p.installed) {
    actions.append(
      el('button', {
        class: 'primary',
        onclick: () => { showStrip(p); closePicker(); }
      }, 'Play'),
      el('button', {
        class: 'danger',
        title: 'Delete the downloaded file',
        onclick: async () => {
          await window.api.media.remove(p.id);
          if (current && current.id === p.id) hideStrip();
          renderPacks();
        }
      }, 'Remove')
    );
  } else {
    actions.append(el('button', {
      class: 'primary',
      onclick: () => startDownload(p.id)
    }, 'Download'));
  }
  row.append(actions);
  return row;
}

function progressBlock(id) {
  const bar = el('i');
  const label = el('small', {}, 'starting…');
  downloading.set(id, { bar, label });
  return el('div', { class: 'pack-progress' }, el('div', { class: 'pack-bar' }, bar), label);
}

function startDownload(id) {
  downloading.set(id, {});
  window.api.media.download(id);
  renderPacks();
}

/* ------------------------------------------------------------ wiring */

export function initFocus() {
  $('#btnFocus').addEventListener('click', openPicker);
  $('#focusClose').addEventListener('click', closePicker);
  $('#focusModal').addEventListener('click', (e) => { if (e.target.id === 'focusModal') closePicker(); });
  $('#focusOff').addEventListener('click', () => { hideStrip(); closePicker(); });
  $('#focusReveal').addEventListener('click', () => window.api.media.reveal());

  $('#vsClose').addEventListener('click', hideStrip);
  $('#vsSwap').addEventListener('click', swapPack);
  $('#vsPlay').addEventListener('click', () => {
    const v = video();
    v.paused ? v.play().catch(() => {}) : v.pause();
    syncPlayIcon();
  });
  video().addEventListener('play', syncPlayIcon);
  video().addEventListener('pause', syncPlayIcon);
  video().addEventListener('error', () => {
    if (!video().src) return;
    toast('That video file could not be played — try removing and downloading it again.');
  });

  for (const btn of document.querySelectorAll('.vs-dock')) {
    btn.addEventListener('click', () => setDock(btn.dataset.dock));
  }

  // Drag the inner edge to resize, in whichever axis the dock implies.
  let dragging = false;
  let start = 0;
  let startSize = 0;
  $('#vsGrip').addEventListener('mousedown', (e) => {
    dragging = true;
    const strip = $('#videostrip');
    if (isVertical()) { start = e.clientX; startSize = strip.offsetWidth; }
    else { start = e.clientY; startSize = strip.offsetHeight; }
    document.body.classList.add('resizing-video');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (isVertical()) {
      // Dragging away from the docked edge makes it bigger.
      const delta = dock === 'left' ? (e.clientX - start) : (start - e.clientX);
      const w = clamp(startSize + delta, 120, window.innerWidth * 0.7);
      document.documentElement.style.setProperty('--video-w', `${Math.round(w)}px`);
    } else {
      const delta = dock === 'top' ? (e.clientY - start) : (start - e.clientY);
      const h = clamp(startSize + delta, 90, window.innerHeight * 0.75);
      document.documentElement.style.setProperty('--video-h', `${Math.round(h)}px`);
    }
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing-video');
    const strip = $('#videostrip');
    window.api.settings.set(isVertical()
      ? { focusWidth: strip.offsetWidth }
      : { focusHeight: strip.offsetHeight }).catch(() => {});
  });

  window.api.media.onProgress(({ id, received, total }) => {
    const entry = downloading.get(id);
    if (!entry || !entry.bar) return;
    const pct = total ? Math.min(100, (received / total) * 100) : 0;
    entry.bar.style.width = `${pct}%`;
    entry.label.textContent = total
      ? `${fmtSize(received)} of ${fmtSize(total)}  ·  ${Math.round(pct)}%`
      : fmtSize(received);
  });

  window.api.media.onDone(async ({ id, ok, error }) => {
    downloading.delete(id);
    await renderPacks();
    if (ok) toast('Video pack ready.');
    else if (error && error !== 'Cancelled') toast(`Download failed: ${error}`);
  });
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Packs that are actually downloaded, for anything that needs to start one. */
export async function installedPacks() {
  const data = await window.api.media.list().catch(() => null);
  if (!data) return [];
  packs = data.packs;
  return packs.filter((p) => p.installed);
}

export const currentPack = () => current;

/**
 * Restore where the strip lives and how big it is, but never start it playing.
 * Launching an app should not put video and sound in front of you unasked —
 * turning it on is a deliberate act each session.
 */
export async function restoreFocus() {
  const h = state.settings.focusHeight;
  const w = state.settings.focusWidth;
  if (h) document.documentElement.style.setProperty('--video-h', `${h}px`);
  if (w) document.documentElement.style.setProperty('--video-w', `${w}px`);
  dock = DOCKS.includes(state.settings.focusDock) ? state.settings.focusDock : 'bottom';
  setDock(dock);
  // Deliberately not restoring `focusOn`.
  await window.api.settings.set({ focusOn: false }).catch(() => {});
}

