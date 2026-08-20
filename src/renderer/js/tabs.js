import { $, el, toast, setChildren, confirmAction } from './util.js';
import { state, emit, on } from './state.js';

/**
 * Open documents.
 *
 * Everything that belongs to a document — its annotations, its extracted text,
 * where you were on the page, the note document, the AI thread — used to be
 * global, so opening a second PDF wiped the first. A tab owns that state and
 * hands it back when you return to it.
 */

export const tabs = [];
let activeId = null;

const DOC_KEYS = [
  'pdf', 'docId', 'filePath', 'docName', 'numPages', 'outline', 'chapters',
  'annotations', 'selectedAnnotation', 'pageText', 'indexReady',
  'currentPage', 'scale', 'zoomMode', 'aiHistory'
];

/** Snapshot the document-scoped slice of app state. */
function capture(extra = {}) {
  const snap = {};
  for (const k of DOC_KEYS) snap[k] = state[k];
  return { ...snap, ...extra };
}

function restore(snap) {
  for (const k of DOC_KEYS) state[k] = snap[k];
}

export const activeTab = () => tabs.find((t) => t.id === activeId) || null;
export const tabCount = () => tabs.length;
export const findTabByPath = (filePath) => tabs.find((t) => t.filePath === filePath);
export const findTabByDocId = (docId) => tabs.find((t) => t.docId === docId);

/**
 * Store the live state onto the active tab. Called before switching away and
 * before saving, so a tab is never stale.
 */
export function syncActive(extra = {}) {
  const tab = activeTab();
  if (!tab) return null;
  Object.assign(tab, capture(extra));
  return tab;
}

export function addTab(doc, extra = {}) {
  const tab = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    filePath: doc.filePath,
    docId: doc.docId,
    docName: doc.name,
    ...extra
  };
  tabs.push(tab);
  activeId = tab.id;
  render();
  return tab;
}

export function setActive(id, { onSwitch } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.id === activeId) return null;
  syncActive();
  activeId = id;
  restore(tab);
  render();
  if (onSwitch) onSwitch(tab);
  return tab;
}

export function removeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const [gone] = tabs.splice(i, 1);
  if (activeId === gone.id) {
    const next = tabs[i] || tabs[i - 1] || null;
    activeId = next ? next.id : null;
  }
  render();
  return { removed: gone, next: activeTab() };
}

export function clearAll() {
  tabs.length = 0;
  activeId = null;
  render();
}

/* ------------------------------------------------------------ rendering */

const shortName = (name) => String(name || 'Untitled').replace(/\.pdf$/i, '');

export function render() {
  const strip = $('#tabstrip');
  if (!strip) return;

  const nodes = tabs.map((tab) => el('div', {
    class: `doc-tab${tab.id === activeId ? ' current' : ''}`,
    'data-id': tab.id,
    title: tab.filePath || tab.docName,
    onclick: (e) => {
      if (e.target.closest('.tab-close')) return;
      emit('tab:activate', tab.id);
    }
  },
    el('span', { class: 'dot' }),
    el('span', { class: 'tab-name' }, shortName(tab.docName)),
    el('button', {
      class: 'tab-close',
      title: 'Close this document',
      onclick: (e) => { e.stopPropagation(); emit('tab:close', tab.id); }
    }, '✕')
  ));

  setChildren(strip, ...nodes, el('button', {
    class: 'tab-add',
    id: 'tabAdd',
    title: 'Open another PDF in a new tab',
    onclick: () => emit('tab:new')
  }, '＋'));
}

export function initTabs() {
  render();
}
