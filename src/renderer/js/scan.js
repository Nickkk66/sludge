import { $, el, escapeHtml, toast, setChildren } from './util.js';
import { state, on, emit } from './state.js';
import { describeModel } from './ai.js';

/**
 * Full-document scan.
 *
 * Retrieval alone answers narrow questions well — it finds the right paragraph.
 * It can't answer "what is this chapter arguing", because no single paragraph
 * holds that. This reads every section once and stores a summary of each, which
 * then rides along as higher-altitude evidence.
 *
 * It deliberately uses a larger model than chat does: a 3B model given a section
 * of a textbook starts answering the exercises printed inside it instead of
 * summarising them. That isn't a prompt that can be tuned around at that size.
 */

let status = null;
let dismissed = false;
let models = [];
let scanModel = null;
let progress = null;

const paramsOf = (name) => {
  const m = models.find((x) => x.name === name);
  if (!m) return 8;
  const g = String(m.params || m.name).match(/([\d.]+)\s*B\b/i);
  if (g) return parseFloat(g[1]);
  return m.size ? m.size / 6e8 : 8;
};

/** Biggest installed model — scan quality tracks size more than anything else. */
function pickScanModel(list) {
  if (!list.length) return null;
  return [...list].sort((a, b) => (b.size || 0) - (a.size || 0))[0].name;
}

const fmtDuration = (seconds) => {
  if (!seconds || seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} hr ${mins % 60} min`;
};

export function setModels(list) {
  models = list || [];
  if (!scanModel || !models.some((m) => m.name === scanModel)) {
    scanModel = state.settings.scanModel && models.some((m) => m.name === state.settings.scanModel)
      ? state.settings.scanModel
      : pickScanModel(models);
  }
}

/* ------------------------------------------------------------ status */

export async function refreshScanStatus() {
  const box = $('#scanOffer');
  if (!state.docId || !state.pdf) {
    box.hidden = true;
    return;
  }
  // The scan needs the extracted text, which finishes shortly after opening.
  if (!state.indexReady) {
    box.hidden = false;
    box.className = 'scan-offer';
    box.innerHTML = '<div class="so-status">Reading the document’s text first — the full scan becomes available in a moment.</div>';
    return;
  }

  try {
    status = await window.api.scan.status({
      docId: state.docId,
      pages: state.pageText,
      chapters: state.chapters || [],
      params: paramsOf(scanModel)
    });
  } catch {
    box.hidden = true;
    return;
  }
  render();
}

function render() {
  const box = $('#scanOffer');
  box.hidden = false;

  if (progress) return renderProgress();
  if (status && status.scanned) return renderDone();
  if (dismissed) return renderReminder();
  if (status && status.partial) return renderPartial();
  renderOffer();
}

function renderOffer() {
  const box = $('#scanOffer');
  box.className = 'scan-offer';
  const est = (status && status.estimate) || { blocks: 0, seconds: 0 };
  const small = paramsOf(scanModel) < 6;
  const half = Math.max(1, Math.ceil(est.blocks / 2));
  const halfSeconds = half * (est.secondsPerBlock || 9);

  setChildren(box,
    el('div', { class: 'so-head' },
      el('span', {
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5h11a1.5 1.5 0 011.5 1.5v11a1.5 1.5 0 01-1.5 1.5H4z"/><path d="M7.5 9h6M7.5 12.5h4"/><circle cx="18" cy="7" r="3"/></svg>'
      }),
      el('b', {}, 'Read the whole document first?')
    ),
    el('div', { class: 'so-body', html:
      `I'll read each section once and write a summary of it. After that, broad questions — ` +
      `<em>“what is this chapter arguing?”</em> — get real answers instead of whatever the ` +
      `nearest paragraph happened to say.<br><br>` +
      `<em>${est.blocks} sections across ${state.numPages} pages · runs in the background · done once</em>`
    }),
    el('div', { class: 'so-row' },
      el('select', {
        onchange: async (e) => {
          scanModel = e.target.value;
          state.settings = await window.api.settings.set({ scanModel });
          refreshScanStatus();
        }
      }, ...models.map((m) => el('option', { value: m.name, selected: m.name === scanModel }, describeModel(m))))
    ),
    el('div', { class: 'so-row', style: { marginTop: '8px' } },
      // Half first: a full pass is a long wait to commit to sight unseen, and
      // the second half can be run later without redoing the first.
      el('button', { class: 'primary', onclick: () => start(half) },
        `Read half · ${fmtDuration(halfSeconds)}`),
      el('button', { onclick: () => start(null) }, `All · ${fmtDuration(est.seconds)}`),
      el('button', { onclick: dismiss }, 'Not now')
    ),
    small
      ? el('div', { class: 'so-status', style: { marginTop: '8px' } },
          'Heads up: models under about 6B tend to copy the text back instead of summarising it. A bigger one gives a much better scan, even though it takes longer.')
      : null
  );
}

function renderProgress() {
  const box = $('#scanOffer');
  box.className = 'scan-offer';
  const pct = progress.total ? (progress.done / progress.total) * 100 : 0;
  const where = progress.chapter
    ? `${progress.chapter} (pp. ${progress.from}–${progress.to})`
    : `pages ${progress.from}–${progress.to}`;

  setChildren(box,
    el('div', { class: 'so-head' }, el('b', {}, `Scanning — ${progress.done} of ${progress.total} sections`)),
    el('div', { class: 'so-bar' }, el('i', { style: { width: `${pct}%` } })),
    el('div', { class: 'so-status' },
      `${where}${progress.etaMs ? ` · about ${fmtDuration(progress.etaMs / 1000)} left` : ''}`),
    el('div', { class: 'so-row', style: { marginTop: '9px' } },
      el('button', { onclick: () => window.api.scan.cancel(state.docId) }, 'Stop'),
      el('span', { class: 'so-status' }, 'You can keep reading while this runs.')
    )
  );
}

function renderDone() {
  const box = $('#scanOffer');
  box.className = 'scan-offer done';
  setChildren(box, el('div', { class: 'scan-chip' },
    el('b', {}, '✓ Scanned'),
    el('span', {}, `${status.blocks} sections · ${status.builtWith || 'local model'}`),
    el('button', {
      onclick: async () => {
        await window.api.scan.clear(state.docId);
        status = null;
        refreshScanStatus();
      }
    }, 'rescan')
  ));
}

/** Half the book is read; offer to finish the rest. */
function renderPartial() {
  const box = $('#scanOffer');
  box.className = 'scan-offer';
  const left = status.remaining;
  const seconds = left * ((status.estimate && status.estimate.secondsPerBlock) || 9);

  setChildren(box,
    el('div', { class: 'so-head' },
      el('b', {}, `Read ${status.blocks} of ${status.estimate.blocks} sections`)),
    el('div', { class: 'so-body', html:
      `Questions about what I've read already get proper answers. The remaining ` +
      `<b>${left}</b> section${left === 1 ? '' : 's'} ${left === 1 ? 'is' : 'are'} still unread — ` +
      `finish when you get there.` }),
    el('div', { class: 'so-bar' },
      el('i', { style: { width: `${(status.blocks / Math.max(1, status.estimate.blocks)) * 100}%` } })),
    el('div', { class: 'so-row', style: { marginTop: '9px' } },
      el('button', { class: 'primary', onclick: () => start(null) }, `Finish · ${fmtDuration(seconds)}`),
      el('button', { onclick: dismiss }, 'Later')
    )
  );
}

/** Hide the offer but leave a way back to it. */
function dismiss() {
  dismissed = true;
  render();
}

/** A one-line way back after "Not now", so the offer is never gone for good. */
function renderReminder() {
  const box = $('#scanOffer');
  box.className = 'scan-offer done';
  const done = status && status.blocks;
  setChildren(box, el('div', { class: 'scan-chip' },
    el('span', {}, done ? `${done} of ${status.estimate.blocks} sections read` : 'Full document scan not run'),
    el('button', { onclick: () => { dismissed = false; render(); } },
      done ? 'continue' : 'scan the document')
  ));
}

/* ------------------------------------------------------------ run */

function start(limit) {
  if (!state.indexReady) return toast('Still reading the document — try again in a moment.');
  if (!scanModel) return toast('No local model available to scan with.');
  dismissed = false;
  progress = { done: (status && status.blocks) || 0, total: (status && status.estimate.blocks) || 0, from: 0, to: 0 };
  render();
  window.api.scan.start({
    docId: state.docId,
    model: scanModel,
    docName: state.docName,
    pages: state.pageText,
    chapters: state.chapters || [],
    limit: limit || null
  });
}

export function initScan() {
  window.api.scan.onProgress((p) => {
    if (p.docId !== state.docId) return;
    progress = p;
    renderProgress();
  });

  window.api.scan.onDone(async ({ docId, ok, error, complete, blocks }) => {
    progress = null;
    if (docId !== state.docId) return;
    if (!ok) {
      toast(`Scan stopped: ${error}`);
    } else if (complete) {
      toast(`Scan finished — ${blocks} sections. Answers should be sharper now.`);
    } else {
      toast(`Read ${blocks} sections. The rest is still there when you want it.`);
    }
    await refreshScanStatus();
  });

  // The offer only makes sense once the text is extracted.
  on('index:ready', () => refreshScanStatus());
  on('doc:loaded', () => { progress = null; status = null; dismissed = false; });
}
