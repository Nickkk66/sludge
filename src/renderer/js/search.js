import { $, el, escapeHtml, debounce } from './util.js';
import { state, emit, on, COLORS } from './state.js';
import { goToPage, scrollToSpot, refreshAnnotations, getPageEl, isRendered, renderPage } from './viewer.js';
import { flattenTextLayer } from './textmap.js';

const MAX_RESULTS = 400;

export function runSearch(query) {
  const q = query.trim();
  state.findQuery = q;
  state.findResults = [];
  state.findCurrent = -1;

  const meta = $('#searchMeta');
  const box = $('#searchResults');
  renderSearchColorFilter();

  if (q.length < 2) {
    box.replaceChildren();
    meta.textContent = state.indexReady ? '' : 'Reading the document…';
    refreshAnnotations();
    return;
  }
  if (!state.pageText.length) {
    meta.textContent = 'Still reading the document — try again in a moment.';
    return;
  }

  const needle = normalize(q);
  // Optional narrowing: only pages the reader has marked in these colours.
  const colorPages = state.searchColorFilter.size
    ? new Set(state.annotations.filter((a) => state.searchColorFilter.has(a.color)).map((a) => a.page))
    : null;

  const results = [];
  for (const p of state.pageText) {
    if (!p || !p.text) continue;
    if (colorPages && !colorPages.has(p.page)) continue;
    const flat = p.text.replace(/\s+/g, ' ');
    const hay = flat.toLowerCase();
    let from = 0;
    let occurrence = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      results.push({
        page: p.page,
        offset: at,
        occurrence: occurrence++,
        snippet: snippetAround(flat, at, needle.length)
      });
      from = at + needle.length;
      if (results.length >= MAX_RESULTS) break;
    }
    if (results.length >= MAX_RESULTS) break;
  }

  state.findResults = results;
  const pages = new Set(results.map((r) => r.page)).size;
  meta.textContent = results.length
    ? `${results.length}${results.length >= MAX_RESULTS ? '+' : ''} match${results.length === 1 ? '' : 'es'} on ${pages} page${pages === 1 ? '' : 's'}`
    : 'No matches.';

  box.replaceChildren(...results.map((r, i) => el('div', {
    class: 'sr-item',
    'data-i': String(i),
    onclick: () => goToResult(i)
  },
    el('div', { class: 'sr-page' }, `Page ${r.page}`),
    el('div', { class: 'sr-text', html: r.snippet })
  )));

  if (results.length) {
    // Jump to the match nearest where the reader already is, not to page 1 —
    // in an 800-page book the first hit is usually the index or contents.
    let start = results.findIndex((r) => r.page >= state.currentPage);
    if (start < 0) start = 0;
    goToResult(start);
  } else {
    refreshAnnotations();
  }
}

function snippetAround(text, at, len) {
  const before = text.slice(Math.max(0, at - 60), at);
  const hit = text.slice(at, at + len);
  const after = text.slice(at + len, at + len + 80);
  return `${at > 60 ? '…' : ''}${escapeHtml(before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(after)}…`;
}

export async function goToResult(i) {
  const r = state.findResults[i];
  if (!r) return;
  state.findCurrent = i;

  for (const node of $('#searchResults').children) node.classList.toggle('current', Number(node.dataset.i) === i);
  const active = $(`#searchResults .sr-item[data-i="${i}"]`);
  if (active) active.scrollIntoView({ block: 'nearest' });

  goToPage(r.page, { smooth: false });
  await renderPage(r.page);
  // The text layer needs a frame to settle before ranges measure correctly.
  await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 60)));
  computeHitsForPage(r.page);
  refreshAnnotations(r.page);
  if (r.rects && r.rects.length) scrollToSpot(r.page, r.rects[0].y);
}

/**
 * Resolve every match on one page to on-page rectangles. Called when a page
 * renders so all hits are visible, not just the one being stepped through.
 */
export function computeHitsForPage(page) {
  if (!state.findQuery || !state.findResults.length) return;
  const pageEl = getPageEl(page);
  if (!pageEl || !pageEl.querySelector('.textLayer')) return;
  let changed = false;
  for (const r of state.findResults) {
    if (r.page !== page || r.rects) continue;
    const rects = locateInTextLayer(page, state.findQuery, r.occurrence);
    if (rects && rects.length) { r.rects = rects; changed = true; }
  }
  return changed;
}

export function stepResult(delta) {
  if (!state.findResults.length) return;
  const next = (state.findCurrent + delta + state.findResults.length) % state.findResults.length;
  goToResult(next);
}

/**
 * Find the nth occurrence of `query` inside a rendered page's text layer and
 * return its rectangles, normalized to the page box.
 */
function locateInTextLayer(page, query, occurrence) {
  const pageEl = getPageEl(page);
  if (!pageEl) return null;
  const layer = pageEl.querySelector('.textLayer');
  if (!layer) return null;

  const mapped = flattenTextLayer(layer);
  if (!mapped) return null;

  // The cached index collapses runs of whitespace; compare on the same footing.
  // The text layer breaks lines into separate spans, so match against a
  // whitespace-collapsed copy and map positions back through `map`.
  const { flat, map } = mapped;
  const hay = flat.toLowerCase();
  const needle = normalize(query);
  let at = -1;
  let from = 0;
  for (let k = 0; k <= occurrence; k++) {
    at = hay.indexOf(needle, from);
    if (at < 0) return null;
    from = at + needle.length;
  }

  const range = document.createRange();
  const startPos = map[at];
  const endPos = map[at + needle.length - 1];
  if (!startPos || !endPos) return null;
  range.setStart(startPos.node, startPos.offset);
  // The map points at the last matched character; the range ends just past it.
  range.setEnd(endPos.node, Math.min(endPos.offset + 1, (endPos.node.nodeValue || '').length));

  const pb = pageEl.getBoundingClientRect();
  const rects = [];
  for (const dr of range.getClientRects()) {
    if (dr.width < 0.5 || dr.height < 0.5) continue;
    rects.push({
      x: (dr.left - pb.left) / pb.width,
      y: (dr.top - pb.top) / pb.height,
      w: dr.width / pb.width,
      h: dr.height / pb.height
    });
  }
  return rects;
}

const normalize = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** Colour chips that narrow results to pages the reader has highlighted. */
function renderSearchColorFilter() {
  const row = $('#searchColors');
  if (!row) return;
  const used = new Map();
  for (const a of state.annotations) used.set(a.color, (used.get(a.color) || 0) + 1);
  const chips = COLORS.filter((c) => used.has(c.hex));
  if (!chips.length) {
    row.replaceChildren();
    return;
  }
  row.replaceChildren(
    el('span', { class: 'sc-label' }, 'only pages I highlighted:'),
    ...chips.map((c) => el('button', {
      class: `fchip${state.searchColorFilter.has(c.hex) ? ' on' : ''}`,
      title: `${c.name} highlights`,
      onclick: () => {
        state.searchColorFilter.has(c.hex)
          ? state.searchColorFilter.delete(c.hex)
          : state.searchColorFilter.add(c.hex);
        runSearch($('#searchInput').value);
      }
    }, el('i', { class: 'dot', style: { background: c.hex } }), String(used.get(c.hex)))),
    state.searchColorFilter.size
      ? el('button', {
          class: 'sc-clear',
          onclick: () => { state.searchColorFilter.clear(); runSearch($('#searchInput').value); }
        }, 'clear')
      : null
  );
}

export function clearSearch() {
  state.findQuery = '';
  state.findResults = [];
  state.findCurrent = -1;
  $('#searchInput').value = '';
  $('#searchMeta').textContent = '';
  $('#searchResults').replaceChildren();
  refreshAnnotations();
}

export function initSearch() {
  // A page that renders after a search still needs its matches drawn.
  on('page:rendered', (page) => {
    if (computeHitsForPage(page)) refreshAnnotations(page);
  });
  const input = $('#searchInput');
  input.addEventListener('input', debounce((e) => runSearch(e.target.value), 260));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepResult(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
  });
}
