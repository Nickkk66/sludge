import { $, $$, el, toast, setChildren } from './util.js';
import { state, emit, on } from './state.js';
import { speech } from './speech.js';
import { showStrip, hideStrip, setDock, installedPacks, currentPack } from './focus.js';

/**
 * Setups.
 *
 * Reading a textbook, writing notes and watching something in the corner each
 * want a different window. Rearranging four panels by hand every time is enough
 * friction that people stop doing it, so a setup captures the whole arrangement
 * — video edge and size, caption panel and text size, which side panel is open
 * and how wide — and puts it back in one click.
 */

const TP_SIZES = [15, 17, 19, 23, 28, 34, 40];

export const BUILT_IN = [
  {
    id: 'brainrot',
    name: 'Full brainrot',
    hint: 'Video left · big captions centre · document right',
    layout: {
      video: { on: true, dock: 'left', width: 420 },
      teleprompter: { on: true, spot: 'centre', size: 34 },
      right: { open: true, view: 'document', wide: true },
      left: { open: false, view: 'thumbnails' }
    }
  },
  {
    id: 'video-only',
    name: 'Just the video',
    hint: 'Video along the bottom, everything else out of the way',
    layout: {
      video: { on: true, dock: 'bottom', height: 320 },
      teleprompter: { on: false, spot: 'bottom', size: 19 },
      right: { open: false, view: 'notes', wide: false },
      left: { open: false, view: 'thumbnails' }
    }
  },
  {
    id: 'read',
    name: 'Read to me',
    hint: 'No video · big captions · notes on the right',
    layout: {
      video: { on: false, dock: 'bottom', height: 320 },
      teleprompter: { on: true, spot: 'bottom', size: 28 },
      right: { open: true, view: 'notes', wide: false },
      left: { open: false, view: 'thumbnails' }
    }
  },
  {
    id: 'plain',
    name: 'Just the PDF',
    hint: 'Pages on the left, nothing else',
    layout: {
      video: { on: false, dock: 'bottom', height: 320 },
      teleprompter: { on: false, spot: 'bottom', size: 19 },
      right: { open: false, view: 'notes', wide: false },
      left: { open: true, view: 'thumbnails' }
    }
  }
];

/* ------------------------------------------------------------ capture */

const readVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export function captureLayout() {
  const main = $('#main');
  const rightTab = $$('#rightPanel .rt').find((b) => b.classList.contains('active'));
  const railBtn = $$('#rail .rail-btn').find((b) => b.classList.contains('active'));
  const strip = $('#videostrip');
  const dock = ['bottom', 'top', 'left', 'right'].find((d) => document.body.classList.contains(`video-${d}`)) || 'bottom';

  return {
    video: {
      on: !strip.hidden,
      dock,
      width: readVar('--video-w', 380),
      height: readVar('--video-h', 320)
    },
    teleprompter: {
      on: $('#spShowText').checked,
      spot: $('#teleprompter').dataset.spot || 'bottom',
      size: readVar('--tp-size', 19)
    },
    right: {
      open: main.classList.contains('right-open'),
      view: rightTab ? rightTab.dataset.right : 'notes',
      wide: main.classList.contains('right-wide')
    },
    left: {
      open: !main.classList.contains('left-collapsed'),
      view: railBtn ? railBtn.dataset.panel : 'thumbnails'
    }
  };
}

/* ------------------------------------------------------------ apply */

export async function applyLayout(layout, hooks) {
  if (!layout) return;
  const root = document.documentElement;

  // Video
  if (layout.video) {
    if (layout.video.width) root.style.setProperty('--video-w', `${layout.video.width}px`);
    if (layout.video.height) root.style.setProperty('--video-h', `${layout.video.height}px`);
    if (layout.video.on) {
      const packs = await installedPacks();
      const pack = currentPack() || packs[0];
      if (pack) {
        showStrip(pack);
        setDock(layout.video.dock || 'bottom');
      } else {
        toast('No video pack installed yet — grab one from the focus button.');
      }
    } else {
      hideStrip();
    }
  }

  // Captions
  if (layout.teleprompter) {
    const size = layout.teleprompter.size || 19;
    root.style.setProperty('--tp-size', `${size}px`);
    const check = $('#spShowText');
    if (check.checked !== !!layout.teleprompter.on) {
      check.checked = !!layout.teleprompter.on;
      check.dispatchEvent(new Event('change'));
    }
    if (hooks && hooks.setSpot) hooks.setSpot(layout.teleprompter.spot || 'bottom');
    // Only show the panel when something is actually being read.
    $('#teleprompter').hidden = !(layout.teleprompter.on && (speech.playing || speech.paused));
  }

  // Panels
  if (hooks) {
    if (layout.left) {
      if (layout.left.open) hooks.openLeft(layout.left.view || 'thumbnails');
      else hooks.collapseLeft();
    }
    if (layout.right) {
      if (layout.right.open) hooks.openRight(layout.right.view || 'notes');
      else hooks.closeRight();
      hooks.setWide(!!layout.right.wide);
    }
  }

  await window.api.settings.set({
    focusDock: layout.video ? layout.video.dock : undefined,
    teleprompterSpot: layout.teleprompter ? layout.teleprompter.spot : undefined,
    teleprompterSize: layout.teleprompter ? layout.teleprompter.size : undefined
  }).catch(() => {});
}

/* ------------------------------------------------------------ storage */

export const customLayouts = () => (state.settings.customLayouts || []);

async function saveCustom(list) {
  state.settings = await window.api.settings.set({ customLayouts: list });
}

export async function saveCurrentAs(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const list = customLayouts().filter((s) => s.name.toLowerCase() !== clean.toLowerCase());
  const entry = { id: `custom-${Date.now().toString(36)}`, name: clean, layout: captureLayout() };
  list.push(entry);
  await saveCustom(list);
  return entry;
}

export async function removeCustom(id) {
  await saveCustom(customLayouts().filter((s) => s.id !== id));
}

/* ------------------------------------------------------------ text size */

export function stepTeleprompterSize(dir) {
  const current = readVar('--tp-size', 19);
  const at = TP_SIZES.reduce((best, s, i) => (Math.abs(s - current) < Math.abs(TP_SIZES[best] - current) ? i : best), 0);
  const next = TP_SIZES[Math.max(0, Math.min(TP_SIZES.length - 1, at + dir))];
  document.documentElement.style.setProperty('--tp-size', `${next}px`);
  window.api.settings.set({ teleprompterSize: next }).catch(() => {});
  emit('teleprompter:resized', next);
  return next;
}
