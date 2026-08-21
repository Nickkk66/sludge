import * as pdfjs from '../../../vendor/pdfjs/pdf.mjs';
import { $, throttle } from './util.js';
import { state, emit } from './state.js';
import { paintAnnotations } from './annotations.js';

pdfjs.GlobalWorkerOptions.workerSrc = '../../vendor/pdfjs/pdf.worker.mjs';

const PAGE_GAP = 14;
const VIEWER_PAD = 40;
// How far outside the viewport we keep pages rendered. Two screens of buffer
// keeps scrolling smooth without holding an 800-page book in memory.
const RENDER_MARGIN = '150% 0px';
const MAX_RENDERED = 12;

const pageEls = new Map();      // pageNum -> element
const rendered = new Map();     // pageNum -> { canvas, textLayer, task, order }
let baseViewport = null;        // page-1 viewport at scale 1, used for placeholders
let observer = null;
let renderOrder = 0;
let restoring = false;

export const viewerEl = () => $('#viewer');
export const pagesEl = () => $('#pages');

/* ------------------------------------------------------------ load */

export async function loadDocument(bytes) {
  destroy();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: '../../vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '../../vendor/pdfjs/standard_fonts/'
  });
  const pdf = await task.promise;
  state.pdf = pdf;
  state.numPages = pdf.numPages;

  const first = await pdf.getPage(1);
  baseViewport = first.getViewport({ scale: 1 });

  state.outline = await pdf.getOutline().catch(() => null);

  buildPlaceholders();
  computeScale();
  layout();
  observePages();
  emit('doc:loaded', { numPages: pdf.numPages });
  return pdf;
}

export function destroy() {
  if (observer) { observer.disconnect(); observer = null; }
  for (const [, r] of rendered) if (r.task) r.task.cancel();
  rendered.clear();
  pageEls.clear();
  pagesEl().innerHTML = '';
  if (state.pdf) { state.pdf.destroy(); state.pdf = null; }
  baseViewport = null;
}

function buildPlaceholders() {
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= state.numPages; n++) {
    const div = document.createElement('div');
    div.className = 'page placeholder';
    div.dataset.page = String(n);
    div.id = `page-${n}`;
    frag.append(div);
    pageEls.set(n, div);
  }
  pagesEl().append(frag);
}

/* ------------------------------------------------------------ scale */

export function computeScale() {
  if (!baseViewport) return;
  const wrap = viewerEl();
  const availW = wrap.clientWidth - VIEWER_PAD - 12;   // 12 ≈ scrollbar
  const availH = wrap.clientHeight - PAGE_GAP * 2;
  const mode = state.zoomMode;
  if (mode === 'fit') state.scale = availW / baseViewport.width;
  else if (mode === 'page') state.scale = Math.min(availW / baseViewport.width, availH / baseViewport.height);
  else state.scale = parseFloat(mode) || 1;
  state.scale = Math.max(0.15, Math.min(5, state.scale));
}

export function setZoom(mode) {
  const anchor = state.currentPage;
  state.zoomMode = String(mode);
  computeScale();
  layout();
  rerenderAll();
  goToPage(anchor, { smooth: false });
  emit('zoom:changed', state.zoomMode);
}

export function stepZoom(dir) {
  const steps = [0.5, 0.65, 0.75, 0.9, 1, 1.15, 1.35, 1.5, 1.75, 2, 2.5, 3];
  const cur = state.scale;
  const next = dir > 0
    ? steps.find((s) => s > cur + 0.01)
    : [...steps].reverse().find((s) => s < cur - 0.01);
  if (next) setZoom(String(next));
}

/** Size every placeholder so the scroll height is right before anything renders. */
function layout() {
  if (!baseViewport) return;
  const w = Math.round(baseViewport.width * state.scale);
  const h = Math.round(baseViewport.height * state.scale);
  for (const [n, div] of pageEls) {
    const r = rendered.get(n);
    if (r && r.viewport) {
      div.style.width = `${Math.round(r.viewport.width)}px`;
      div.style.height = `${Math.round(r.viewport.height)}px`;
    } else {
      div.style.width = `${w}px`;
      div.style.height = `${h}px`;
    }
  }
}

/* ------------------------------------------------------------ render */

function observePages() {
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const n = Number(entry.target.dataset.page);
      if (entry.isIntersecting) renderPage(n);
    }
    evictFarPages();
  }, { root: viewerEl(), rootMargin: RENDER_MARGIN, threshold: 0 });

  for (const [, div] of pageEls) observer.observe(div);
}

export async function renderPage(n, force = false) {
  const div = pageEls.get(n);
  if (!div || !state.pdf) return;
  const existing = rendered.get(n);
  if (existing && !force) {
    existing.order = ++renderOrder;
    if (Math.abs(existing.scale - state.scale) < 0.001) return;
  }
  if (existing && existing.task) existing.task.cancel();

  const scale = state.scale;
  const entry = { order: ++renderOrder, scale, task: null };
  rendered.set(n, entry);

  let page;
  try {
    page = await state.pdf.getPage(n);
  } catch { return; }
  if (rendered.get(n) !== entry || Math.abs(scale - state.scale) > 0.001) return;

  const viewport = page.getViewport({ scale });
  entry.viewport = viewport;
  div.style.width = `${Math.round(viewport.width)}px`;
  div.style.height = `${Math.round(viewport.height)}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  const ctx = canvas.getContext('2d', { alpha: false });

  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
  });
  entry.task = task;

  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  }
  if (rendered.get(n) !== entry) return;

  // Swap in the finished canvas and rebuild the overlay layers.
  div.replaceChildren(canvas);
  div.classList.remove('placeholder');
  entry.canvas = canvas;

  const textDiv = document.createElement('div');
  textDiv.className = 'textLayer';
  div.append(textDiv);
  entry.textEl = textDiv;

  const annoDiv = document.createElement('div');
  annoDiv.className = 'annoLayer';
  div.append(annoDiv);
  entry.annoEl = annoDiv;

  try {
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: false }),
      container: textDiv,
      viewport
    });
    await textLayer.render();
    entry.textLayer = textLayer;
    } catch { /* a page without extractable text still renders fine */ }

  applyToolToLayer(textDiv);
  paintAnnotations(n, annoDiv);
  emit('page:rendered', n);
}

/**
 * Text selection on the PDF is built by hand rather than left to the browser.
 *
 * pdf.js absolutely-positions each text run and sizes it to its glyphs, so the
 * space between lines and past the ends of lines belongs to the container. The
 * browser's native drag-selection, on reaching that space, extends to the end
 * of the container in DOM order — the entire page. Correcting it after the
 * fact fights the browser's own drag state machine: a recorded real drag
 * showed the guard firing 427 times and still losing at release.
 *
 * So the native drag never starts (the mousedown's default action is
 * cancelled) and the selection is driven from pointer positions directly.
 * Every position maps to the nearest character, which leaves nowhere off-text
 * for the focus to escape to. Double- and triple-click word and paragraph
 * selection, and shift-click extension, stay native.
 */
function initCustomSelection() {
  const pages = pagesEl();
  let dragging = false;
  let anchor = null;

  /** The character position for a point: exact when on text, nearest otherwise. */
  const caretAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const hitSpan = el && el.closest && el.closest('.textLayer span');
    if (hitSpan && document.caretRangeFromPoint) {
      const c = document.caretRangeFromPoint(x, y);
      if (c && c.startContainer.nodeType === Node.TEXT_NODE) {
        return { node: c.startContainer, offset: c.startOffset };
      }
    }

    // Off every character. Find the nearest text run on any rendered page,
    // weighting the line far above the column so the gap between lines maps
    // to one of its neighbours, not to a line further down with a longer reach.
    let best = null;
    let bestScore = Infinity;
    for (const span of pages.querySelectorAll('.textLayer span')) {
      if (!span.firstChild) continue;
      const r = span.getBoundingClientRect();
      if (!r.height) continue;
      const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
      const score = dy * 1000 + dx;
      if (score < bestScore) {
        bestScore = score;
        best = { span, rect: r };
      }
    }
    if (!best) return null;

    const text = best.span.firstChild;
    // Past either end of the run, the position is that end — probing inside
    // the outermost glyph lands before it and leaves a drag a character short.
    if (x >= best.rect.right) return { node: text, offset: text.length };
    if (x <= best.rect.left) return { node: text, offset: 0 };
    if (document.caretRangeFromPoint) {
      const c = document.caretRangeFromPoint(x, best.rect.top + best.rect.height / 2);
      if (c && c.startContainer.nodeType === Node.TEXT_NODE) {
        return { node: c.startContainer, offset: c.startOffset };
      }
    }
    return { node: text, offset: text.length };
  };

  /** Native selection kept the viewport moving on long drags; so do we. */
  const autoScroll = (e) => {
    const wrap = viewerEl();
    const r = wrap.getBoundingClientRect();
    const margin = 36;
    if (e.clientY < r.top + margin) wrap.scrollTop -= Math.min(24, r.top + margin - e.clientY);
    else if (e.clientY > r.bottom - margin) wrap.scrollTop += Math.min(24, e.clientY - (r.bottom - margin));
  };

  pages.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.shiftKey || e.detail > 1) return;
    if (state.tool !== 'select' && state.tool !== 'highlight') return;
    if (e.target.closest('.hl, .pin, .deadzone')) return;
    if (!e.target.closest('.textLayer')) return;

    // Cancelling the default action is what keeps the native drag-selection
    // from ever starting; mouseup and click still fire, so the selection
    // popup and click-to-read are unaffected.
    e.preventDefault();
    dragging = true;
    anchor = caretAt(e.clientX, e.clientY);
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging || !anchor) return;
    autoScroll(e);
    const focus = caretAt(e.clientX, e.clientY);
    if (!focus) return;
    const sel = window.getSelection();
    if (!sel) return;
    try {
      sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } catch { /* a node was evicted mid-drag; the next move recovers */ }
  });

  const release = () => {
    dragging = false;
    anchor = null;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
}

function evictFarPages() {
  if (rendered.size <= MAX_RENDERED) return;
  const keep = new Set();
  for (let n = state.currentPage - 3; n <= state.currentPage + 3; n++) keep.add(n);
  const candidates = [...rendered.entries()]
    .filter(([n]) => !keep.has(n))
    .sort((a, b) => a[1].order - b[1].order);
  let over = rendered.size - MAX_RENDERED;
  for (const [n, r] of candidates) {
    if (over-- <= 0) break;
    if (r.task) r.task.cancel();
    const div = pageEls.get(n);
    if (div) {
      div.replaceChildren();
      div.classList.add('placeholder');
    }
    rendered.delete(n);
  }
}

export function rerenderAll() {
  for (const n of [...rendered.keys()]) renderPage(n, true);
}

/** Repaint one page's annotation overlay (or all currently rendered pages). */
export function refreshAnnotations(page) {
  const targets = page ? [page] : [...rendered.keys()];
  for (const n of targets) {
    const r = rendered.get(n);
    if (r && r.annoEl) paintAnnotations(n, r.annoEl);
  }
}

export const getAnnoLayer = (n) => {
  const r = rendered.get(n);
  return r ? r.annoEl : null;
};

export const isRendered = (n) => rendered.has(n) && !!rendered.get(n).canvas;

/* ------------------------------------------------------------ navigation */

export function goToPage(n, { smooth = true, position = 'start' } = {}) {
  const page = Math.max(1, Math.min(state.numPages, Math.round(n)));
  const div = pageEls.get(page);
  if (!div) return;
  restoring = true;
  const top = div.offsetTop - PAGE_GAP;
  viewerEl().scrollTo({ top: position === 'center'
    ? top - (viewerEl().clientHeight - div.offsetHeight) / 2
    : top, behavior: smooth ? 'smooth' : 'auto' });
  state.currentPage = page;
  emit('page:changed', page);
  setTimeout(() => { restoring = false; }, smooth ? 420 : 60);
  renderPage(page);
}

/** Scroll so a normalized y-position on a page sits near the top of the view. */
export function scrollToSpot(page, y = 0) {
  const div = pageEls.get(page);
  if (!div) return;
  const offset = div.offsetTop + div.offsetHeight * y - viewerEl().clientHeight * 0.28;
  viewerEl().scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  state.currentPage = page;
  emit('page:changed', page);
}

function currentPageFromScroll() {
  const wrap = viewerEl();
  const mid = wrap.scrollTop + wrap.clientHeight * 0.35;
  let best = 1;
  for (const [n, div] of pageEls) {
    if (div.offsetTop <= mid) best = n;
    else break;
  }
  return best;
}

export function getPosition() {
  const wrap = viewerEl();
  const page = currentPageFromScroll();
  const div = pageEls.get(page);
  const within = div ? (wrap.scrollTop - div.offsetTop) / Math.max(1, div.offsetHeight) : 0;
  return { page, within: Number(within.toFixed(4)), zoomMode: state.zoomMode };
}

export function restorePosition(pos) {
  if (!pos || !pos.page) return;
  const div = pageEls.get(Math.min(pos.page, state.numPages));
  if (!div) return;
  const top = div.offsetTop + div.offsetHeight * (pos.within || 0);
  viewerEl().scrollTop = Math.max(0, top);
  state.currentPage = pos.page;
  emit('page:changed', pos.page);
  renderPage(pos.page);
}

const onScroll = throttle(() => {
  const page = currentPageFromScroll();
  if (page !== state.currentPage) {
    state.currentPage = page;
    emit('page:changed', page);
  }
  if (!restoring) emit('scroll:idle', getPosition());
}, 120);

/* ------------------------------------------------------------ tools */

export function applyTool() {
  const wrap = $('#viewerWrap');
  wrap.classList.remove('tool-select', 'tool-hand', 'tool-highlight', 'tool-pin');
  wrap.classList.add(`tool-${state.tool}`);
  for (const [, r] of rendered) if (r.textEl) applyToolToLayer(r.textEl);
}

function applyToolToLayer(textEl) {
  // The text layer must stop swallowing pointer events when panning or pinning.
  textEl.classList.toggle('no-select', state.tool === 'hand' || state.tool === 'pin');
}

/**
 * Re-read one page's text, dropping anything inside a dead zone, and patch it
 * into the cached index. Retrieval, search and the scan all read from that
 * cache, so masking it here hides the region from every one of them at once.
 */
export async function reextractPage(pageNum, zones = []) {
  if (!state.pdf) return null;
  try {
    const page = await state.pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const kept = content.items.filter((item) => {
      if (!zones.length) return true;
      const tr = item.transform || [];
      // Item origin is the text baseline in PDF space, y measured from the bottom.
      const x = (tr[4] || 0) / viewport.width;
      const yFromTop = 1 - ((tr[5] || 0) / viewport.height);
      const cx = x + ((item.width || 0) / viewport.width) / 2;
      const cy = yFromTop - ((item.height || 0) / viewport.height) / 2;
      return !zones.some((z) => cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h);
    });

    const text = kept.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
    return text.replace(/[ \t]+/g, ' ').trim();
  } catch {
    return null;
  }
}

/** Rebuild the cached text for every page that has dead zones on it. */
export async function applyDeadZones(docId, zonesByPage) {
  if (!state.pageText.length) return false;
  let changed = false;
  for (const [page, zones] of zonesByPage) {
    const fresh = await reextractPage(page, zones);
    if (fresh === null) continue;
    const entry = state.pageText.find((p) => p && p.page === page);
    if (!entry) continue;
    if (entry.text !== fresh) {
      entry.text = fresh;
      changed = true;
    }
  }
  if (changed) await window.api.index.save(docId, state.pageText).catch(() => {});
  return changed;
}

/* ------------------------------------------------------------ text extraction */

/**
 * Extract every page's text in idle-time batches and cache it. Powers both
 * in-document search and the local AI, and never blocks the first paint.
 */
export async function buildTextIndex(docId, onProgress) {
  const cached = await window.api.index.get(docId).catch(() => null);
  if (cached && cached.pages && cached.pages.length === state.numPages) {
    state.pageText = cached.pages;
    state.indexReady = true;
    emit('index:ready', { cached: true });
    return cached.pages;
  }

  const pages = [];
  const pdf = state.pdf;
  const total = state.numPages;
  const BATCH = 8;

  for (let n = 1; n <= total; n += BATCH) {
    const batch = [];
    for (let i = n; i < Math.min(n + BATCH, total + 1); i++) batch.push(i);
    await Promise.all(batch.map(async (p) => {
      try {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('');
        pages[p - 1] = { page: p, text: cleanExtractedText(text) };
      } catch {
        pages[p - 1] = { page: p, text: '' };
      }
    }));
    state.pageText = pages.filter(Boolean);
    if (onProgress) onProgress(Math.min(n + BATCH - 1, total), total);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (state.pdf !== pdf) return [];   // document changed under us
  }

  state.pageText = pages;
  state.indexReady = true;
  await window.api.index.save(docId, pages).catch(() => {});
  emit('index:ready', { cached: false });
  return pages;
}

/**
 * Tidy text pulled out of a PDF so a voice reads it as written.
 *
 * Typeset books hyphenate across line breaks and use ligatures and typographic
 * quotes; read aloud verbatim those become "sepa— ration" and mispronounced
 * words. This is applied to the cached text the reader, the search and the AI
 * all work from.
 */
export function cleanExtractedText(raw) {
  return String(raw || '')
    // A hyphen at end of line is a broken word, not punctuation.
    .replace(/([A-Za-z])[-\u2010\u2011]\n([a-z])/g, '$1$2')
    // Ligatures the voice would otherwise stumble over.
    .replace(/\uFB00/g, 'ff').replace(/\uFB01/g, 'fi').replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi').replace(/\uFB04/g, 'ffl').replace(/\uFB05/g, 'st')
    // Typographic punctuation.
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u2013\u2014]/g, '\u2014')
    // Soft hyphens and zero-width characters are invisible but not silent.
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/* ------------------------------------------------------------ wiring */

export function initViewer() {
  viewerEl().addEventListener('scroll', onScroll, { passive: true });
  initCustomSelection();

  window.addEventListener('resize', throttle(() => {
    if (!state.pdf) return;
    if (state.zoomMode === 'fit' || state.zoomMode === 'page') {
      const anchor = getPosition();
      computeScale();
      layout();
      rerenderAll();
      restorePosition(anchor);
    }
  }, 180));

  // Hand tool drag-to-pan.
  let dragging = false;
  let startX = 0, startY = 0, startL = 0, startT = 0;
  viewerEl().addEventListener('mousedown', (e) => {
    if (state.tool !== 'hand') return;
    dragging = true;
    $('#viewerWrap').classList.add('dragging');
    startX = e.clientX; startY = e.clientY;
    startL = viewerEl().scrollLeft; startT = viewerEl().scrollTop;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    viewerEl().scrollLeft = startL - (e.clientX - startX);
    viewerEl().scrollTop = startT - (e.clientY - startY);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    $('#viewerWrap').classList.remove('dragging');
  });

  // ⌘/ctrl + wheel zooms, like every other reader.
  viewerEl().addEventListener('wheel', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !state.pdf) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

export const getPageEl = (n) => pageEls.get(n);
export const getBaseViewport = () => baseViewport;
