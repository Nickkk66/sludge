import { uid } from './util.js';

export const COLORS = [
  { name: 'Red',    hex: '#ff6b6b' },
  { name: 'Orange', hex: '#ff9f43' },
  { name: 'Yellow', hex: '#f6d34a' },
  { name: 'Green',  hex: '#5fd08a' },
  { name: 'Blue',   hex: '#5aa9f5' },
  { name: 'Purple', hex: '#b98cf0' }
];

const listeners = new Map();

export const state = {
  // document
  pdf: null,
  docId: null,
  filePath: null,
  docName: null,
  numPages: 0,
  outline: null,
  chapters: [],

  // view
  tool: 'select',           // select | hand | highlight | pin
  color: '#f6d34a',
  autoNote: true,
  zoomMode: '1',            // 'fit' | 'page' | numeric string
  scale: 1,
  currentPage: 1,
  theme: 'dark',
  invert: false,

  // data
  annotations: [],
  selectedAnnotation: null,
  pageText: [],             // [{ page, text }]
  indexReady: false,

  // filters
  noteQuery: '',
  colorFilter: new Set(),
  tagFilter: new Set(),

  // search
  findQuery: '',
  findResults: [],
  findCurrent: -1,
  searchColorFilter: new Set(),

  // ai
  aiModel: null,
  aiRunning: false,
  aiHistory: [],

  settings: {}
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) fn(payload);
}

/* ---------------- annotation helpers ---------------- */

export function makeHighlight({ page, rects, quote, color, note = '', tags = [] }) {
  return {
    id: uid(),
    type: 'highlight',
    page,
    rects,
    quote,
    color: color || state.color,
    note,
    tags,
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };
}

export function makePin({ page, x, y, color, note = '', tags = [] }) {
  return {
    id: uid(),
    type: 'pin',
    page,
    x,
    y,
    quote: '',
    color: color || state.color,
    note,
    tags,
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };
}

export function makeDeadZone({ page, x, y, w, h }) {
  return {
    id: uid(),
    type: 'deadzone',
    page,
    x,
    y,
    w,
    h,
    note: '',
    tags: [],
    color: '#6b7280',
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };
}

export const annotationsOnPage = (page) => state.annotations.filter((a) => a.page === page);

/** Regions on a page the reader has marked as "skip this". */
export const deadZonesOnPage = (page) =>
  state.annotations.filter((a) => a.type === 'deadzone' && a.page === page);

export const hasDeadZones = () => state.annotations.some((a) => a.type === 'deadzone');

export function allTags() {
  const counts = new Map();
  for (const a of state.annotations.filter((x) => x.type !== 'deadzone')) {
    for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function usedColors() {
  const counts = new Map();
  for (const a of state.annotations.filter((x) => x.type !== 'deadzone')) {
    counts.set(a.color, (counts.get(a.color) || 0) + 1);
  }
  return [...counts.entries()];
}

/**
 * Parse the notes filter box. Beyond plain text it understands:
 *   #exam      a tag (prefix match, so #ex finds #exam)
 *   p112       a page
 *   13-14      a page range
 *   1776       a page OR any note mentioning it
 * Several terms combine with AND.
 */
export function parseNoteQuery(raw) {
  const tokens = String(raw || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const q = { tags: [], pages: [], ranges: [], loose: [], text: [] };
  for (const t of tokens) {
    let m;
    if (t.startsWith('#')) {
      if (t.length > 1) q.tags.push(t.slice(1));
    } else if ((m = t.match(/^p?\.?(\d+)\s*[-–—]\s*p?\.?(\d+)$/))) {
      q.ranges.push([Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2])]);
    } else if ((m = t.match(/^(?:p|pg|page)\.?(\d+)$/))) {
      q.pages.push(+m[1]);
    } else if (/^\d+$/.test(t)) {
      // A bare number is ambiguous — treat it as a page or as text.
      q.loose.push(+t);
    } else {
      q.text.push(t);
    }
  }
  return q;
}

function matchesQuery(a, q) {
  const hay = `${a.note || ''} ${a.quote || ''} ${(a.tags || []).join(' ')}`.toLowerCase();
  const tags = (a.tags || []).map((t) => t.toLowerCase());

  for (const t of q.tags) if (!tags.some((x) => x.startsWith(t))) return false;
  for (const w of q.text) if (!hay.includes(w)) return false;

  const wantsPage = q.pages.length || q.ranges.length;
  if (wantsPage) {
    const hit = q.pages.includes(a.page) || q.ranges.some(([lo, hi]) => a.page >= lo && a.page <= hi);
    if (!hit) return false;
  }
  for (const n of q.loose) {
    if (a.page !== n && !hay.includes(String(n))) return false;
  }
  return true;
}

/** Notes passing the current filter set, ordered by page then vertical position. */
export function filteredAnnotations() {
  const q = parseNoteQuery(state.noteQuery);
  const empty = !q.tags.length && !q.text.length && !q.pages.length && !q.ranges.length && !q.loose.length;
  return state.annotations
    .filter((a) => {
      if (a.type === 'deadzone') return false;
      if (state.colorFilter.size && !state.colorFilter.has(a.color)) return false;
      if (state.tagFilter.size && !(a.tags || []).some((t) => state.tagFilter.has(t))) return false;
      return empty ? true : matchesQuery(a, q);
    })
    .sort((a, b) => a.page - b.page || topOf(a) - topOf(b));
}

const topOf = (a) => (a.type === 'pin' ? a.y : (a.rects && a.rects[0] ? a.rects[0].y : 0));
