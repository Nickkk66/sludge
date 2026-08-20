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
const downloading = new Map();

const video = () => $('#focusVideo');

/* ------------------------------------------------------------ strip */

export function showStrip(pack) {
  current = pack;
  const strip = $('#videostrip');
  const v = video();
  strip.hidden = false;
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

export function hideStrip() {
  const v = video();
  v.pause();
  $('#videostrip').hidden = true;
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

  // Drag the top edge to resize the strip.
  let dragging = false;
  let startY = 0;
  let startH = 0;
  $('#vsGrip').addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = $('#videostrip').offsetHeight;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.max(90, Math.min(window.innerHeight * 0.6, startH - (e.clientY - startY)));
    document.documentElement.style.setProperty('--video-h', `${Math.round(h)}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    const h = $('#videostrip').offsetHeight;
    window.api.settings.set({ focusHeight: h }).catch(() => {});
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

/** Restore the strip if it was on when the app last closed. */
export async function restoreFocus() {
  const h = state.settings.focusHeight;
  if (h) document.documentElement.style.setProperty('--video-h', `${h}px`);
  if (!state.settings.focusOn) return;
  const data = await window.api.media.list().catch(() => null);
  if (!data) return;
  packs = data.packs;
  const pack = packs.find((p) => p.id === state.settings.focusPack && p.installed);
  if (pack) showStrip(pack);
}
