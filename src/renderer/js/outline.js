import { $, el } from './util.js';
import { state, on } from './state.js';
import { goToPage } from './viewer.js';
import { parseToc } from './toc.js';

let builtFor = null;

export async function buildOutline() {
  const box = $('#outline');
  const items = state.outline;

  if (items && items.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'Reading chapters…'));
    const rows = [];
    await flatten(items, 0, rows);
    box.replaceChildren(...rows.map(({ title, depth, dest }) => el('button', {
      class: `ol-item d${Math.min(depth, 2)}`,
      onclick: async () => {
        const page = await resolvePage(dest);
        if (page) goToPage(page);
      }
    }, el('span', { class: 'ol-title' }, title))));
    builtFor = state.docId;
    return;
  }

  // No embedded outline. Plenty of scanned or exported textbooks have none, so
  // fall back to headings found in the page text once the index is ready.
  if (!state.indexReady) {
    box.replaceChildren(el('p', { class: 'empty' }, 'No built-in chapter list. Looking for chapter headings in the text…'));
    return;
  }
  renderDerived(box);
}

function renderDerived(box) {
  // Reading the book's own contents pages beats guessing from headings, so try
  // that first and only fall back to the heading scan.
  let rows = parseToc(state.pageText);
  let source = 'contents';
  if (rows.length < 4) {
    rows = deriveChapters(state.pageText);
    source = 'headings';
  }

  if (!rows.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'This PDF has no chapter list, and none could be recovered from the text.'));
    return;
  }

  state.chapters = rows;
  box.replaceChildren(
    el('p', { class: 'ol-note' }, source === 'contents'
      ? 'Read from this book\u2019s contents pages — the PDF has no built-in chapter list.'
      : 'Found from headings in the text — the PDF has no built-in chapter list.'),
    ...rows.map((r) => el('button', {
      class: `ol-item d${r.depth}`,
      'data-page': String(r.page),
      onclick: () => goToPage(r.page)
    },
      el('span', { class: 'ol-title' }, r.title),
      el('span', { class: 'ol-page' }, `p. ${r.page}`)
    ))
  );
  builtFor = state.docId;
  highlightCurrentChapter(state.currentPage);
}

/** Mark the chapter containing the current page. */
export function highlightCurrentChapter(page) {
  const items = [...document.querySelectorAll('#outline .ol-item')];
  if (!items.length) return;
  let current = null;
  for (const item of items) {
    if (Number(item.dataset.page) <= page) current = item;
    else break;
  }
  for (const item of items) item.classList.toggle('current', item === current);
}

/**
 * Pull chapter-ish headings out of extracted page text. Deliberately
 * conservative: it only accepts lines that look like a real heading, and it
 * drops anything that repeats across many pages (those are running headers).
 */
export function deriveChapters(pages) {
  // "Section"/"Topic" are deliberately absent — inside a history textbook they
  // match constitutional text far more often than they match a chapter.
  const HEADING = /^\s*(chapter|unit|period|part|appendix)\s+(\d{1,2}|[ivx]{1,5})\b[:.\u2014\-\s]*(.{0,70})$/i;
  const NAMED = /^\s*(introduction|preface|foreword|glossary|index|bibliography|acknowledg(?:e)?ments)\s*$/i;
  // A trailing page number means this line came from a table of contents.
  const TOC_LINE = /\s\d{1,4}\s*$/;

  const found = [];
  for (const p of pages) {
    if (!p || !p.text) continue;
    const lines = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // A real chapter opener leads the page; anything deeper is body text.
    const head = lines.slice(0, 2);
    for (const line of head) {
      if (line.length > 90 || TOC_LINE.test(line)) continue;
      const m = line.match(HEADING);
      if (m) {
        const rest = (m[3] || '').replace(/\s+/g, ' ').trim();
        // A heading followed by a full sentence is prose, not a title.
        if (/[.;]\s/.test(rest)) break;
        const label = `${cap(m[1])} ${m[2].toUpperCase()}`;
        found.push({
          page: p.page,
          key: `${m[1].toLowerCase()}-${m[2].toLowerCase()}`,
          title: rest ? `${label}: ${rest}` : label,
          depth: depthFor(m[1]),
          density: lines.length
        });
        break;
      }
      const n = line.match(NAMED);
      if (n) {
        found.push({ page: p.page, key: n[1].toLowerCase(), title: cap(n[1]), depth: 1, density: lines.length });
        break;
      }
    }
  }

  // Contents pages stack many headings within a few pages; the real chapter
  // openers are spread through the book. Drop the dense cluster.
  const filtered = found.filter((f) => {
    const near = found.filter((o) => Math.abs(o.page - f.page) <= 3).length;
    return near <= 3;
  });

  // A heading repeated page after page is a running header, not a chapter
  // start — keep only its first appearance.
  const firstByKey = new Map();
  for (const f of filtered) if (!firstByKey.has(f.key)) firstByKey.set(f.key, f);

  return [...firstByKey.values()]
    .sort((a, b) => a.page - b.page)
    .filter((r, i, arr) => i === 0 || r.page !== arr[i - 1].page);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const depthFor = (word) => (/^(unit|period|part)$/i.test(word) ? 0 : 1);

async function flatten(items, depth, out) {
  for (const item of items) {
    out.push({ title: item.title || '(untitled)', depth, dest: item.dest });
    if (item.items && item.items.length && depth < 3) await flatten(item.items, depth + 1, out);
  }
}

// Destinations resolve lazily — an 800-page outline would otherwise stall the
// panel resolving hundreds of page references up front.
async function resolvePage(dest) {
  if (!dest || !state.pdf) return null;
  try {
    const explicit = typeof dest === 'string' ? await state.pdf.getDestination(dest) : dest;
    if (!explicit) return null;
    const index = await state.pdf.getPageIndex(explicit[0]);
    return index + 1;
  } catch {
    return null;
  }
}

export function initOutline() {
  // The derived list needs the text index, which finishes after the first paint.
  on('index:ready', () => {
    if (builtFor === state.docId) return;
    if (state.outline && state.outline.length) return;
    renderDerived($('#outline'));
  });
  on('page:changed', (page) => highlightCurrentChapter(page));
}
