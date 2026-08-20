import { $, el, escapeHtml, debounce } from './util.js';
import { state, emit } from './state.js';
import { goToPage, scrollToSpot, refreshAnnotations, getPageEl, isRendered, renderPage } from './viewer.js';

const MAX_RESULTS = 400;

export function runSearch(query) {
  const q = query.trim();
  state.findQuery = q;
  state.findResults = [];
  state.findCurrent = -1;

  const meta = $('#searchMeta');
  const box = $('#searchResults');

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
  const results = [];
  for (const p of state.pageText) {
    if (!p || !p.text) continue;
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

  if (results.length) goToResult(0);
  else refreshAnnotations();
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
  const rects = locateInTextLayer(r.page, state.findQuery, r.occurrence);
  if (rects && rects.length) {
    r.rects = rects;
    refreshAnnotations(r.page);
    scrollToSpot(r.page, rects[0].y);
  } else {
    refreshAnnotations(r.page);
  }
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

  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  if (!nodes.length) return null;

  // The cached index collapses runs of whitespace; compare on the same footing.
  // The text layer breaks lines into separate spans, so match against a
  // whitespace-collapsed copy and map positions back through `map`.
  const { flat, map } = flatten(nodes);
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

/**
 * Collapse the text layer into one whitespace-normalized string, keeping a
 * position map back to the original (node, offset) so a match can become a Range.
 * Span boundaries count as a space, which is how the page reads.
 */
function flatten(nodes) {
  let flat = '';
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const value = node.nodeValue || '';
    for (let j = 0; j < value.length; j++) {
      const ch = value[j];
      if (/\s/.test(ch)) { pendingSpace = flat.length > 0; continue; }
      if (pendingSpace) { flat += ' '; map.push({ node, offset: j }); pendingSpace = false; }
      flat += ch;
      map.push({ node, offset: j });
    }
    // Separate spans read as separate words.
    if (i < nodes.length - 1 && flat.length) pendingSpace = true;
  }
  map.push({ node: nodes[nodes.length - 1], offset: (nodes[nodes.length - 1].nodeValue || '').length });
  return { flat, map };
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
  const input = $('#searchInput');
  input.addEventListener('input', debounce((e) => runSearch(e.target.value), 260));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepResult(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
  });
}
