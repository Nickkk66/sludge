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

  // view
  tool: 'select',           // select | hand | highlight | pin
  color: '#f6d34a',
  autoNote: true,
  zoomMode: '1',            // 'fit' | 'page' | numeric string
  scale: 1,
  currentPage: 1,
  theme: 'dark',

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

export const annotationsOnPage = (page) => state.annotations.filter((a) => a.page === page);

export function allTags() {
  const counts = new Map();
  for (const a of state.annotations) {
    for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function usedColors() {
  const counts = new Map();
  for (const a of state.annotations) counts.set(a.color, (counts.get(a.color) || 0) + 1);
  return [...counts.entries()];
}

/** Notes passing the current filter set, ordered by page then vertical position. */
export function filteredAnnotations() {
  const q = state.noteQuery.trim().toLowerCase();
  return state.annotations
    .filter((a) => {
      if (state.colorFilter.size && !state.colorFilter.has(a.color)) return false;
      if (state.tagFilter.size && !(a.tags || []).some((t) => state.tagFilter.has(t))) return false;
      if (!q) return true;
      const hay = `${a.note || ''} ${a.quote || ''} ${(a.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => a.page - b.page || topOf(a) - topOf(b));
}

const topOf = (a) => (a.type === 'pin' ? a.y : (a.rects && a.rects[0] ? a.rects[0].y : 0));
