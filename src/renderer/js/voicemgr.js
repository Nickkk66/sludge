import { $, el, toast, setChildren, fmtSize, confirmAction } from './util.js';
import { state, emit } from './state.js';
import { speech, setVoice } from './speech.js';

/**
 * The natural-voice picker.
 *
 * Every voice can be auditioned from a small hosted sample before committing
 * to its 60–120 MB download, because the only honest way to choose a voice is
 * to hear it. Downloads come from the voices' official homes (Hugging Face,
 * GitHub) and everything runs offline afterwards.
 */

let catalog = [];
let engineReady = false;
const downloading = new Map();
let previewAudio = null;
let previewingId = null;

async function refresh() {
  try {
    const s = await window.api.tts.status();
    catalog = s.voices;
    engineReady = s.engine;
  } catch {
    catalog = [];
  }
  render();
  emit('tts:changed');
}

/* ------------------------------------------------------------ preview */

function stopPreview() {
  if (previewAudio) {
    try { previewAudio.pause(); } catch { /* fine */ }
    previewAudio = null;
  }
  previewingId = null;
  render();
}

async function playPreview(id) {
  if (previewingId === id) return stopPreview();
  stopPreview();
  previewingId = id;
  render();
  try {
    const url = await window.api.tts.preview(id);
    if (previewingId !== id) return;
    previewAudio = new Audio(url);
    previewAudio.onended = stopPreview;
    previewAudio.onerror = () => { toast('Preview unavailable for this voice.'); stopPreview(); };
    await previewAudio.play();
  } catch (err) {
    toast(`Could not fetch the preview: ${err.message || err}`);
    stopPreview();
  }
}

/* ------------------------------------------------------------ rows */

function voiceRow(v) {
  const busy = downloading.get(v.id);
  const inUse = speech.voiceURI === `piper:${v.id}`;

  const actions = el('div', { class: 'pack-actions' });
  if (busy) {
    actions.append(el('button', { onclick: () => window.api.tts.cancel(v.id) }, 'Cancel'));
  } else if (v.installed) {
    actions.append(
      el('button', {
        class: inUse ? '' : 'primary',
        onclick: () => {
          setVoice(`piper:${v.id}`);
          toast(`Reading voice set to ${v.label.split(' — ')[0]}.`);
          render();
          emit('tts:changed');
        }
      }, inUse ? 'In use ✓' : 'Use'),
      el('button', {
        class: 'danger',
        onclick: async () => {
          const ok = await confirmAction({
            message: `Remove ${v.label.split(' — ')[0]}?`,
            detail: 'The voice can be downloaded again any time.',
            confirmLabel: 'Remove'
          });
          if (!ok) return;
          await window.api.tts.remove(v.id);
          if (inUse) setVoice(null);
          refresh();
        }
      }, 'Remove')
    );
  } else {
    actions.append(el('button', {
      class: 'primary',
      onclick: () => {
        downloading.set(v.id, { got: 0, total: 0 });
        window.api.tts.install(v.id);
        render();
      }
    }, `Download · ${v.mb} MB`));
  }

  const row = el('div', { class: `pack${inUse ? ' playing' : ''}` },
    el('button', {
      class: `vm-play${previewingId === v.id ? ' on' : ''}`,
      title: previewingId === v.id ? 'Stop the sample' : 'Hear a sample before downloading',
      onclick: () => playPreview(v.id),
      html: previewingId === v.id
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 5.5l11 6.5-11 6.5z"/></svg>'
    }),
    el('div', { class: 'pack-info' },
      el('b', {}, v.label),
      el('small', {}, `${v.hint} · ${v.quality === 'high' ? 'highest quality' : 'standard quality'}`)
    )
  );

  if (busy) {
    const pct = busy.total ? Math.min(100, (busy.got / busy.total) * 100) : 0;
    row.append(el('div', { class: 'pack-progress' },
      el('div', { class: 'pack-bar' }, el('i', { style: { width: `${pct}%` } })),
      el('small', {}, busy.stage === 'engine'
        ? `voice engine… ${Math.round(pct)}%`
        : `${fmtSize(busy.got)}${busy.total ? ` of ${fmtSize(busy.total)}` : ''}`)
    ));
  }
  row.append(actions);
  return row;
}

function render() {
  const box = $('#voiceMgrList');
  if (!box) return;
  if (!catalog.length) {
    setChildren(box, el('p', { class: 'empty' }, 'Could not load the voice list.'));
    return;
  }
  setChildren(box,
    el('p', { class: 'modal-intro' },
      'Neural voices that read like a person, not a robot. ',
      el('b', {}, 'Press ▶ to hear each one first'),
      ` — then download the one you like. ${engineReady ? '' : 'The first download also fetches the 25 MB voice engine. '}Runs offline afterwards.`),
    ...catalog.map(voiceRow)
  );
}

/* ------------------------------------------------------------ shell */

export function openVoiceManager() {
  $('#voiceMgrModal').classList.remove('hidden');
  refresh();
}

export function initVoiceManager() {
  $('#voiceMgrClose').addEventListener('click', () => {
    stopPreview();
    $('#voiceMgrModal').classList.add('hidden');
  });
  $('#voiceMgrModal').addEventListener('click', (e) => {
    if (e.target.id === 'voiceMgrModal') {
      stopPreview();
      $('#voiceMgrModal').classList.add('hidden');
    }
  });

  window.api.tts.onProgress((p) => {
    downloading.set(p.id, p);
    render();
  });
  window.api.tts.onDone(({ id, ok, error }) => {
    downloading.delete(id);
    if (ok) toast('Voice ready — hit Use to read with it.');
    else if (error && error !== 'Cancelled') toast(`Download failed: ${error}`);
    refresh();
  });
}

export const neuralVoices = () => catalog.filter((v) => v.installed);
export const refreshNeural = refresh;
