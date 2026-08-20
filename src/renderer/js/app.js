import { $, $$, el, debounce, toast, fmtSize, escapeHtml } from './util.js';
import { state, on, emit, COLORS } from './state.js';
import {
  initViewer, loadDocument, buildTextIndex, goToPage, setZoom, stepZoom,
  applyTool, refreshAnnotations, restorePosition, getPosition, destroy, applyDeadZones
} from './viewer.js';
import { initAnnotationUi, clearPage, closeNoteEditor, hideSelectionPopup } from './annotations.js';
import { initNotesPanel, renderNotesPanel } from './notes.js';
import { initThumbs, buildThumbnails, highlightCurrentThumb } from './thumbs.js';
import { buildOutline, initOutline } from './outline.js';
import { initSearch, runSearch, clearSearch, stepResult } from './search.js';
import { showLibrary, hideLibrary, makeCover, renderRecent } from './library.js';
import { initAi, refreshAiStatus, resetAiThread } from './ai.js';
import { exportNotes } from './exporter.js';
import { initSpeech, speech, play as speechPlay, pause as speechPause, stop as speechStop,
         toggle as speechToggle, skip as speechSkip, setRate, setVoice, getVoices, getAllVoices,
         voicesAreBasic, refreshVoices, readingState, jumpToSentence, sentenceAtOffset,
         readFrom, offsetAtPoint, isReadingPage } from './speech.js';
import { describeVoice } from './voices.js';
import { initDocNotes, getMarkdown, setMarkdown, exportDocument } from './docnotes.js';
import { initFocus, restoreFocus, openPicker } from './focus.js';
import { initProfile, loadProfile, showOnboarding, renderGreeting, profile } from './profile.js';
import { initScan, refreshScanStatus, setModels } from './scan.js';
import { initQuestions } from './questions.js';
import { initZones, selectZone, clearSelection } from './zones.js';
import { initTabs, tabs, addTab, setActive, removeTab, syncActive, activeTab, findTabByPath, render as renderTabs } from './tabs.js';
import { BUILT_IN, applyLayout, captureLayout, customLayouts, saveCurrentAs, removeCustom,
         stepTeleprompterSize } from './layouts.js';

/* ------------------------------------------------------------ boot */

async function boot() {
  state.settings = await window.api.settings.get();
  state.theme = state.settings.theme || 'dark';
  state.color = state.settings.defaultColor || COLORS[2].hex;
  state.autoNote = state.settings.autoNote !== false;
  applyTheme(state.theme);
  applyInvert(state.settings.invert === true);

  initViewer();
  initAnnotationUi();
  initNotesPanel();
  initThumbs();
  initSearch();
  initOutline();
  initAi();
  initSpeech();
  initDocNotes();
  initFocus();
  initProfile();
  initScan();
  initQuestions();
  initZones();
  initTabs();
  wireTabs();
  wireLayouts();
  wireSpeechBar();
  wireTeleprompter();
  wireDocument();
  wireUpdates();
  loadProfile(state.settings);
  buildSwatches();
  wireChrome();
  wireKeyboard();
  wireDragDrop();

  $('#autoNote').checked = state.autoNote;
  await renderGreeting();
  await renderRecent();
  refreshAiStatus({ autostart: false });
  restoreFocus();

  // First launch: ask the few questions that make the AI's answers fit.
  if (!profile.onboarded) setTimeout(showOnboarding, 500);

  window.api.onOpenFile((path) => openDocument(path));
  window.api.onMenu(handleMenu);
  on('doc:request', (path) => openDocument(path));

  // Tell main we're listening, and take any file it queued for us.
  const queued = await window.api.ready().catch(() => null);
  if (queued) openDocument(queued);
}

/* ------------------------------------------------------------ document */

let saveTimer = null;
let currentDoc = null;

async function openDocument(filePath, { newTab = true } = {}) {
  // Already open? Just go to it rather than loading a second copy.
  const existing = findTabByPath(filePath);
  if (existing && existing.id !== (activeTab() || {}).id) {
    return activateTab(existing.id);
  }
  if (existing) {
    $('#welcome').hidden = true;
    return;
  }

  try {
    setSaveState('', 'Opening…');
    const doc = await window.api.openDoc(filePath);
    currentDoc = doc;

    // Park the outgoing document so returning to its tab restores it intact.
    if (newTab && activeTab()) {
      await saveNow();
      syncActive();
    }

    // Reset per-document state before the new file lands.
    state.annotations = doc.annotations || [];
    state.selectedAnnotation = null;
    state.pageText = [];
    state.indexReady = false;
    state.noteQuery = '';
    state.colorFilter.clear();
    state.tagFilter.clear();
    state.docId = doc.docId;
    state.filePath = doc.filePath;
    state.docName = doc.name;
    $('#noteFilter').value = '';
    clearSearch();
    resetAiThread();
    speechStop();
    setMarkdown((doc.document && doc.document.markdown) || '');

    $('#welcome').hidden = true;
    document.title = `${doc.name} — Sludge`;
    if (newTab) addTab(doc);
    else {
      const tab = activeTab();
      if (tab) Object.assign(tab, { filePath: doc.filePath, docId: doc.docId, docName: doc.name });
      renderTabs();
    }

    await loadDocument(doc.bytes);
    $('#pageTotal').textContent = String(state.numPages);

    // Restore the zoom the reader last used for this document, then their spot.
    const savedZoom = doc.lastPosition && doc.lastPosition.zoomMode;
    if (savedZoom) {
      state.zoomMode = savedZoom;
      $('#zoomSelect').value = savedZoom;
      setZoom(savedZoom);
    }

    buildThumbnails();
    buildOutline();
    renderNotesPanel();

    if (doc.lastPosition) {
      restorePosition(doc.lastPosition);
      if (doc.lastPosition.page > 1) toast(`Picked up where you left off — page ${doc.lastPosition.page}`);
    } else {
      goToPage(1, { smooth: false });
    }

    setSaveState('saved', 'Saved');
    updateSidecarHint(doc.sidecarPath);

    // Background work: cover art for the library, then the full text index.
    const cover = await makeCover();
    await window.api.library.upsert({
      docId: doc.docId,
      path: doc.filePath,
      name: doc.name,
      pages: state.numPages,
      noteCount: state.annotations.length,
      lastPage: doc.lastPosition ? doc.lastPosition.page : 1,
      lastOpened: new Date().toISOString(),
      thumb: cover
    });
    await window.api.settings.set({ lastDocId: doc.docId });

    buildTextIndex(doc.docId, (done, total) => {
      setSaveState('', `Reading document… ${Math.round((done / total) * 100)}%`);
      if (done >= total) setSaveState('saved', 'Saved');
    }).catch(() => {});
  } catch (err) {
    toast(`Could not open that PDF: ${err.message || err}`);
    setSaveState('', '—');
  }
}

function updateSidecarHint(path) {
  if (!path) return;
  const inAppStorage = path.includes('Application Support');
  if (inAppStorage) toast('Notes are saved in app storage — the PDF\'s folder is not writable.');
}

/** Return to the greeting without closing the document you have open. */
async function showStartScreen() {
  hideLibrary();
  $('#welcome').hidden = false;
  // Only offer "back" when there is something to go back to.
  $('#welcomeBack').hidden = !state.pdf;
  await renderGreeting();
  await renderRecent();
}

/**
 * Switch to another open document. The PDF has to be re-opened because the
 * viewer keeps one pdf.js instance, but everything else comes back from the
 * tab's snapshot, including the reading position.
 */
async function activateTab(id) {
  const current = activeTab();
  if (current) {
    await saveNow();
    syncActive({ position: getPosition() });
  }
  const tab = setActive(id);
  if (!tab) return;

  speechStop();
  clearSearch();
  destroy();

  const doc = await window.api.openDoc(tab.filePath);
  currentDoc = doc;
  state.annotations = doc.annotations || [];
  state.docId = doc.docId;
  state.filePath = doc.filePath;
  state.docName = doc.name;
  state.pageText = tab.pageText || [];
  state.indexReady = !!tab.indexReady;
  state.chapters = tab.chapters || [];
  setMarkdown((doc.document && doc.document.markdown) || '');
  resetAiThread();

  document.title = `${doc.name} — Sludge`;
  $('#welcome').hidden = true;

  await loadDocument(doc.bytes);
  $('#pageTotal').textContent = String(state.numPages);
  if (tab.zoomMode) { state.zoomMode = tab.zoomMode; $('#zoomSelect').value = tab.zoomMode; setZoom(tab.zoomMode); }

  buildThumbnails();
  buildOutline();
  renderNotesPanel();
  restorePosition(tab.position || doc.lastPosition || { page: 1, within: 0 });

  if (!state.indexReady) {
    buildTextIndex(doc.docId, (done, total) => {
      setSaveState('', `Reading document… ${Math.round((done / total) * 100)}%`);
      if (done >= total) setSaveState('saved', 'Saved');
    }).catch(() => {});
  }
  setSaveState('saved', 'Saved');
}

function wireTabs() {
  on('tab:activate', (id) => activateTab(id));
  on('tab:new', () => showStartScreen());
  on('tab:close', (id) => closeTab(id));
}

/** Close one tab, falling back to whatever is left. */
async function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const isActive = (activeTab() || {}).id === id;
  if (isActive) await saveNow();

  const { next } = removeTab(id);
  if (!isActive) return;

  if (next) {
    // removeTab already made `next` active, so restore it from disk.
    await activateTabFrom(next);
  } else {
    await closeDocument();
  }
}

async function activateTabFrom(tab) {
  speechStop();
  clearSearch();
  destroy();
  const doc = await window.api.openDoc(tab.filePath);
  currentDoc = doc;
  state.annotations = doc.annotations || [];
  state.docId = doc.docId;
  state.filePath = doc.filePath;
  state.docName = doc.name;
  state.pageText = tab.pageText || [];
  state.indexReady = !!tab.indexReady;
  state.chapters = tab.chapters || [];
  setMarkdown((doc.document && doc.document.markdown) || '');
  resetAiThread();
  document.title = `${doc.name} — Sludge`;
  await loadDocument(doc.bytes);
  $('#pageTotal').textContent = String(state.numPages);
  buildThumbnails();
  buildOutline();
  renderNotesPanel();
  restorePosition(tab.position || doc.lastPosition || { page: 1, within: 0 });
  setSaveState('saved', 'Saved');
}

async function closeDocument() {
  await saveNow();
  speechStop();
  setMarkdown('');
  destroy();
  currentDoc = null;
  state.docId = state.filePath = state.docName = null;
  state.annotations = [];
  state.numPages = 0;
  state.pageText = [];
  state.indexReady = false;
  $('#welcome').hidden = false;
  $('#welcomeBack').hidden = true;
  $('#pageTotal').textContent = '0';
  document.title = 'Sludge';
  clearSearch();
  resetAiThread();
  renderNotesPanel();
  $('#thumbs').replaceChildren();
  await renderRecent();
  await renderGreeting();
  setSaveState('', '—');
}

/* ------------------------------------------------------------ saving */

function setSaveState(cls, text) {
  const node = $('#saveState');
  node.className = `save-state ${cls}`;
  node.textContent = text;
}

const scheduleSave = debounce(() => saveNow(), 600);

async function saveNow() {
  if (!state.filePath || !state.docId) return;
  setSaveState('saving', 'Saving…');
  try {
    const pos = getPosition();
    await window.api.saveDoc(state.filePath, state.docId, {
      annotations: state.annotations,
      lastPosition: pos,
      document: { markdown: getMarkdown(), updated: new Date().toISOString() }
    });
    await window.api.library.upsert({
      docId: state.docId,
      path: state.filePath,
      name: state.docName,
      pages: state.numPages,
      noteCount: state.annotations.length,
      lastPage: pos.page,
      lastOpened: new Date().toISOString()
    });
    setSaveState('saved', 'Saved');
  } catch (err) {
    setSaveState('', 'Not saved');
    toast(`Could not save notes: ${err.message || err}`);
  }
}

on('annotations:changed', () => {
  refreshAnnotations();
  renderNotesPanel();
  scheduleSave();
});

// A dead zone changes what the AI and search can see, so the cached page text
// is rebuilt for the pages involved.
const syncDeadZones = debounce(async () => {
  if (!state.docId || !state.indexReady) return;
  const byPage = new Map();
  for (const a of state.annotations) {
    if (a.type !== 'deadzone') continue;
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  // Pages that just lost their last zone need rebuilding too.
  for (const page of touchedDeadZonePages) if (!byPage.has(page)) byPage.set(page, []);
  if (!byPage.size) return;
  const changed = await applyDeadZones(state.docId, byPage);
  if (changed) toast('Dead zones applied — the AI and search now skip those areas.');
}, 700);

const touchedDeadZonePages = new Set();
on('deadzones:changed', ({ page }) => {
  touchedDeadZonePages.add(page);
  syncDeadZones();
});
on('scroll:idle', () => scheduleSave());
on('document:changed', () => scheduleSave());
window.addEventListener('beforeunload', () => { if (state.filePath) saveNow(); });

/* ------------------------------------------------------------ chrome */

function buildSwatches() {
  const bar = $('#swatches');
  bar.replaceChildren(...COLORS.map((c) => el('button', {
    class: `swatch${c.hex === state.color ? ' active' : ''}`,
    style: { background: c.hex },
    title: c.name,
    onclick: async () => {
      state.color = c.hex;
      $$('#swatches .swatch').forEach((n) => n.classList.remove('active'));
      $$('#swatches .swatch').find((n) => n.title === c.name).classList.add('active');
      document.documentElement.style.setProperty('--swatch', c.hex);
      state.settings = await window.api.settings.set({ defaultColor: c.hex });
    }
  })));
  document.documentElement.style.setProperty('--swatch', state.color);
}

function setTool(tool) {
  state.tool = tool;
  $$('.rb[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#colorbar').hidden = !(tool === 'highlight' || tool === 'pin');
  $('#spDeadZone').classList.toggle('active', tool === 'deadzone');
  if (tool === 'deadzone') toast('Drag a box over anything that should be skipped. Click a zone to select it, Backspace to delete.');
  else clearSelection();
  applyTool();
  if (tool !== 'select') hideSelectionPopup();
}

function openLeftPanel(view, { force = false } = {}) {
  const main = $('#main');
  const already = $(`#rail .rail-btn[data-panel="${view}"]`).classList.contains('active');
  if (!force && already && !main.classList.contains('left-collapsed')) {
    main.classList.add('left-collapsed');
    syncRibbonState();
    return;
  }
  main.classList.remove('left-collapsed');
  $$('#rail .rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === view));
  $$('#leftPanel .panel-view').forEach((p) => p.classList.toggle('active', p.dataset.view === view));
  $('#leftPanelTitle').textContent = PANEL_TITLES[view] || view;
  if (view === 'search') setTimeout(() => $('#searchInput').focus(), 40);
  if (view === 'notes') renderSideNotesSummary();
  syncRibbonState();
}

const PANEL_TITLES = { thumbnails: 'Pages', outline: 'Chapters', search: 'Search', notes: 'Notes', zones: 'Dead zones' };

/** Show which panels are open, so the ribbon reflects the actual state. */
function syncRibbonState() {
  const leftOpen = !$('#main').classList.contains('left-collapsed');
  const leftView = ($$('#rail .rail-btn').find((b) => b.classList.contains('active')) || {}).dataset;
  const left = leftOpen && leftView ? leftView.panel : null;

  const rightOpen = $('#main').classList.contains('right-open');
  const rightTab = $$('#rightPanel .rt').find((b) => b.classList.contains('active'));
  const right = rightOpen && rightTab ? rightTab.dataset.right : null;

  const set = (sel, on) => $$(sel).forEach((b) => b && b.classList.toggle('active', on));
  set('#btnThumbs', left === 'thumbnails');
  set('#btnOutline', left === 'outline');
  set('#btnFind', left === 'search');
  set('#btnNotesPanel, #btnNotesPanel2', right === 'notes');
  set('#btnAsk, #btnAsk2', right === 'ai');
  set('#btnDoc', right === 'document');
  set('#btnQuestions', right === 'questions');
}

function renderSideNotesSummary() {
  const box = $('#sideNotesSummary');
  if (!box) return;
  const n = state.annotations.length;
  if (!n) {
    box.innerHTML = 'No notes yet. Highlight some text or drop a pin and they collect here.';
    return;
  }
  const pages = new Set(state.annotations.map((a) => a.page)).size;
  const tagged = state.annotations.filter((a) => (a.tags || []).length).length;
  box.innerHTML = `<b>${n}</b> note${n === 1 ? '' : 's'} across <b>${pages}</b> page${pages === 1 ? '' : 's'}` +
    (tagged ? `, <b>${tagged}</b> tagged.` : '.');
}

function openRightPanel(view) {
  const main = $('#main');
  $('#rightPanel').classList.remove('hidden');
  main.classList.add('right-open');
  $$('#rightPanel .rt').forEach((b) => b.classList.toggle('active', b.dataset.right === view));
  $$('#rightPanel .panel-view').forEach((p) => p.classList.toggle('active', p.dataset.view === view));
  if (view === 'ai') {
    refreshAiStatus();
    refreshScanStatus();
    setTimeout(() => $('#aiInput').focus(), 60);
  }
  if (view === 'document') setTimeout(() => $('#docEditor').focus(), 60);
  syncRibbonState();
}

const toggleRightPanel = (view) => {
  const main = $('#main');
  const open = main.classList.contains('right-open');
  const showing = $(`#rightPanel .rt[data-right="${view}"]`).classList.contains('active');
  if (open && showing) closeRightPanel();
  else openRightPanel(view);
};

function closeRightPanel() {
  $('#main').classList.remove('right-open');
  $('#rightPanel').classList.add('hidden');
  syncRibbonState();
}

function applyInvert(on) {
  state.invert = !!on;
  $('#viewerWrap').classList.toggle('invert-pdf', state.invert);
  window.api.settings.set({ invert: state.invert }).catch(() => {});
}

function showThemeMenu(x, y) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const menu = el('div', { class: 'ctx-menu' },
    el('button', {
      class: `ctx-item${state.invert ? ' on' : ''}`,
      onclick: () => { applyInvert(!state.invert); menu.remove(); toast(state.invert ? 'PDF colours inverted' : 'PDF colours normal'); }
    }, el('span', { class: 'ctx-check' }, state.invert ? '✓' : ''), 'Invert PDF colours'),
    el('button', {
      class: 'ctx-item',
      onclick: () => { $('#themeToggle').click(); menu.remove(); }
    }, el('span', { class: 'ctx-check' }, ''), state.theme === 'dark' ? 'Switch to day theme' : 'Switch to night theme')
  );
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w + 20))}px`;
  menu.style.top = `${Math.max(8, y - h - 8)}px`;
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $('#themeLabel').textContent = theme === 'dark' ? 'Day' : 'Night';
  window.api.setTheme(theme).catch(() => {});
}

function wireChrome() {
  // ribbon tabs
  $$('.rtab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.rtab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.ribbon-page').forEach((p) => p.classList.toggle('active', p.dataset.page === tab.dataset.ribbon));
    if (tab.dataset.ribbon === 'ai') refreshAiStatus();
  }));

  $$('.rb[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  setTool('select');

  const open = async () => {
    const path = await window.api.pickPdf();
    if (path) openDocument(path);
  };
  ['#btnOpen', '#welcomeOpen', '#libraryAdd'].forEach((sel) =>
    $(sel).addEventListener('click', async () => { hideLibrary(); await open(); }));

  $('#welcomeBack').addEventListener('click', () => { $('#welcome').hidden = true; });
  ['#btnLibrary', '#btnLibraryTop', '#welcomeLibrary'].forEach((sel) =>
    $(sel).addEventListener('click', showLibrary));
  $('#libraryClose').addEventListener('click', hideLibrary);
  $('#libraryModal').addEventListener('click', (e) => { if (e.target.id === 'libraryModal') hideLibrary(); });



  $('#btnThumbs').addEventListener('click', () => openLeftPanel('thumbnails'));
  $('#btnOutline').addEventListener('click', () => openLeftPanel('outline'));
  ['#btnFind', '#btnFindTop'].forEach((s) => $(s).addEventListener('click', () => openLeftPanel('search')));
  $$('#rail .rail-btn').forEach((b) => b.addEventListener('click', () => openLeftPanel(b.dataset.panel)));
  $('#leftPanelClose').addEventListener('click', () => {
    $('#main').classList.add('left-collapsed');
    syncRibbonState();
  });

  // The left Notes view mirrors the ribbon's note actions, so both routes work.
  $('#sideAllNotes').addEventListener('click', () => openRightPanel('notes'));
  $('#spDeadZone').addEventListener('click', () => {
    setTool(state.tool === 'deadzone' ? 'select' : 'deadzone');
    $('#spDeadZone').classList.toggle('active', state.tool === 'deadzone');
    if (state.tool === 'deadzone') openLeftPanel('zones', { force: true });
  });
  on('zone:select', (id) => selectZone(id));
  $('#sideExport').addEventListener('click', exportNotes);

  ['#btnNotesPanel', '#btnNotesPanel2'].forEach((s) => $(s).addEventListener('click', () => toggleRightPanel('notes')));
  ['#btnAsk', '#btnAsk2', '#btnAiTop'].forEach((s) => $(s).addEventListener('click', () => toggleRightPanel('ai')));
  $$('#rightPanel .rt').forEach((b) => b.addEventListener('click', () => openRightPanel(b.dataset.right)));
  $('#rightPanelClose').addEventListener('click', closeRightPanel);

  ['#btnExport', '#btnExport2'].forEach((s) => $(s).addEventListener('click', exportNotes));
  $('#btnClearPage').addEventListener('click', () => state.pdf && clearPage(state.currentPage));
  $('#btnClearZones').addEventListener('click', () => {
    const zones = state.annotations.filter((a) => a.type === 'deadzone');
    if (!zones.length) return toast('No dead zones to clear.');
    const pages = [...new Set(zones.map((z) => z.page))];
    state.annotations = state.annotations.filter((a) => a.type !== 'deadzone');
    emit('annotations:changed', { removed: zones });
    for (const page of pages) emit('deadzones:changed', { page });
    toast(`Cleared ${zones.length} dead zone${zones.length === 1 ? '' : 's'}.`);
  });
  $('#btnRevealSidecar').addEventListener('click', async () => {
    if (!state.filePath) return toast('Open a PDF first.');
    const p = await window.api.revealSidecar(state.filePath, state.docId);
    toast(`Notes file: ${p.split('/').pop()}`);
  });

  $('#colorbarClose').addEventListener('click', () => setTool('select'));
  $('#autoNote').addEventListener('change', async (e) => {
    state.autoNote = e.target.checked;
    state.settings = await window.api.settings.set({ autoNote: e.target.checked });
  });

  // page navigation
  $('#pagePrev').addEventListener('click', () => goToPage(state.currentPage - 1));
  $('#pageNext').addEventListener('click', () => goToPage(state.currentPage + 1));
  $('#pageFirst').addEventListener('click', () => goToPage(1));
  $('#pageLast').addEventListener('click', () => goToPage(state.numPages));
  $('#pageInput').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (n) goToPage(n);
    else e.target.value = String(state.currentPage);
  });

  // zoom
  $('#zoomSelect').addEventListener('change', (e) => setZoom(e.target.value));
  $('#zoomIn').addEventListener('click', () => stepZoom(1));
  $('#zoomOut').addEventListener('click', () => stepZoom(-1));
  $('#themeToggle').addEventListener('click', async () => {
    const next = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    state.settings = await window.api.settings.set({ theme: next });
  });

  // Right-click offers inverting the page itself — dark app chrome doesn't help
  // when the PDF is still a white rectangle.
  $('#themeToggle').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showThemeMenu(e.clientX, e.clientY);
  });

  on('page:changed', (page) => {
    $('#pageInput').value = String(page);
    highlightCurrentThumb(page);
  });
  on('annotations:changed', () => renderSideNotesSummary());
  syncRibbonState();
  on('zoom:changed', (mode) => {
    const sel = $('#zoomSelect');
    if (![...sel.options].some((o) => o.value === mode)) {
      const pct = `${Math.round(parseFloat(mode) * 100)}%`;
      const custom = [...sel.options].find((o) => o.dataset.custom);
      if (custom) { custom.value = mode; custom.textContent = pct; }
      else sel.append(el('option', { value: mode, 'data-custom': 'true' }, pct));
    }
    sel.value = mode;
    window.api.settings.set({ zoom: mode }).catch(() => {});
  });
  on('panel:open', (view) => openRightPanel(view));
  on('panel:right', (view) => openRightPanel(view));
}

/* ------------------------------------------------------------ setups */

/** The panel operations a layout needs, kept in one place. */
const layoutHooks = () => ({
  openLeft: (view) => openLeftPanel(view, { force: true }),
  collapseLeft: () => { $('#main').classList.add('left-collapsed'); syncRibbonState(); },
  openRight: (view) => openRightPanel(view),
  closeRight: () => closeRightPanel(),
  setWide: (on) => {
    $('#main').classList.toggle('right-wide', on);
    $('#btnDocSnap').classList.toggle('active', on);
  },
  setSpot: (spot) => setTeleprompterSpot(spot)
});

async function useLayout(entry) {
  await applyLayout(entry.layout, layoutHooks());
  state.settings = await window.api.settings.set({ lastLayout: entry.id });
  toast(`Setup: ${entry.name}`);
}

function wireLayouts() {
  $('#btnLayouts').addEventListener('click', (e) => openLayoutMenu(e.currentTarget));
  $('#tpBigger').addEventListener('click', () => stepTeleprompterSize(1));
  $('#tpSmaller').addEventListener('click', () => stepTeleprompterSize(-1));

  const size = state.settings.teleprompterSize;
  if (size) document.documentElement.style.setProperty('--tp-size', `${size}px`);
}

function openLayoutMenu(anchor) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());

  const rows = [];
  rows.push(el('div', { class: 'ctx-head' }, 'Setups'));

  for (const entry of BUILT_IN) {
    rows.push(el('button', {
      class: 'ctx-item layout-item',
      onclick: () => { menu.remove(); useLayout(entry); }
    },
      el('span', {},
        el('b', {}, entry.name),
        el('small', {}, entry.hint))
    ));
  }

  const mine = customLayouts();
  if (mine.length) {
    rows.push(el('div', { class: 'ctx-head' }, 'Yours'));
    for (const entry of mine) {
      rows.push(el('div', { class: 'layout-row' },
        el('button', {
          class: 'ctx-item layout-item grow',
          onclick: () => { menu.remove(); useLayout(entry); }
        }, el('span', {}, el('b', {}, entry.name), el('small', {}, 'saved setup'))),
        el('button', {
          class: 'layout-del',
          title: 'Delete this setup',
          onclick: async (ev) => {
            ev.stopPropagation();
            await removeCustom(entry.id);
            menu.remove();
            openLayoutMenu(anchor);
          }
        }, '✕')
      ));
    }
  }

  rows.push(el('div', { class: 'ctx-sep' }));
  rows.push(el('button', {
    class: 'ctx-item',
    onclick: () => { menu.remove(); promptSaveLayout(); }
  }, el('span', { class: 'ctx-check' }, '＋'), 'Save this arrangement…'));

  const menu = el('div', { class: 'ctx-menu layout-menu' }, ...rows);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  menu.style.top = `${r.bottom + 6}px`;

  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

/** Name the current arrangement so it can be recalled later. */
function promptSaveLayout() {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const input = el('input', { placeholder: 'Name this setup', maxlength: '40' });
  const commit = async () => {
    const entry = await saveCurrentAs(input.value);
    box.remove();
    if (entry) toast(`Saved “${entry.name}”`);
  };
  const box = el('div', { class: 'ctx-menu layout-save' },
    el('div', { class: 'ctx-head' }, 'Save the current arrangement'),
    input,
    el('div', { class: 'layout-save-actions' },
      el('button', { onclick: () => box.remove() }, 'Cancel'),
      el('button', { class: 'primary', onclick: commit }, 'Save')
    )
  );
  document.body.append(box);
  const r = $('#btnLayouts').getBoundingClientRect();
  box.style.left = `${Math.max(8, r.right - box.offsetWidth)}px`;
  box.style.top = `${r.bottom + 6}px`;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); box.remove(); }
  });
  setTimeout(() => input.focus(), 30);
}

/* ------------------------------------------------------------ updates */

function wireUpdates() {
  const banner = $('#updateBanner');
  let releaseUrl = null;

  const show = (info) => {
    releaseUrl = info.url;
    $('#ubText').innerHTML =
      `<b>Sludge ${escapeHtml(info.latest)}</b> is out — you're on ${escapeHtml(info.current)}.`;
    banner.classList.remove('hidden');
  };

  $('#ubGo').addEventListener('click', () => {
    window.api.update.open(releaseUrl);
    banner.classList.add('hidden');
    toast('Opened the release page. Install it, then reopen Sludge — it will offer to bin the old copy.');
  });
  $('#ubClose').addEventListener('click', () => banner.classList.add('hidden'));

  window.api.update.onAvailable(show);
  window.api.update.onCleaned(({ removed }) => {
    if (removed) toast(`Moved ${removed} older cop${removed === 1 ? 'y' : 'ies'} of Sludge to the Trash.`);
  });
}

/* ------------------------------------------------------------ read aloud */

function wireSpeechBar() {
  const bar = $('#speechbar');

  // Click anywhere on the page to move the voice there.
  on('reader:clickTo', async ({ page, x, y }) => {
    if (!speech.playing && !speech.paused) return;
    if (!isReadingPage(page)) {
      await readFrom(page, null, { play: speech.playing });
      return;
    }
    const offset = offsetAtPoint(page, x, y);
    if (offset !== null) jumpToSentenceWord(offset);
  });

  // "Read here" on a text selection.
  on('reader:readFrom', async ({ page, node, offset }) => {
    bar.hidden = false;
    fillVoices();
    if (!isReadingPage(page)) {
      await readFrom(page, null, { play: true });
    }
    const { offsetOfNode } = await import('./speech.js');
    const at = offsetOfNode(node, offset);
    if (at !== null) jumpToSentenceWord(at);
    if (!speech.playing) speechToggle();
  });

  const openBar = () => {
    bar.hidden = false;
    fillVoices();
  };

  $('#btnRead').addEventListener('click', () => {
    if (!state.pdf) return toast('Open a PDF first.');
    openBar();
    speechToggle();
  });

  $('#spPlay').addEventListener('click', () => speechToggle());
  $('#spPrev').addEventListener('click', () => speechSkip(-1));
  $('#spNext').addEventListener('click', () => speechSkip(1));
  $('#spStop').addEventListener('click', () => speechStop());
  $('#speechbarClose').addEventListener('click', () => { speechStop(); bar.hidden = true; });

  const rate = $('#spRate');
  rate.value = String(speech.rate);
  $('#spRateLabel').textContent = `${Number(speech.rate).toFixed(2).replace(/0$/, '')}×`;
  rate.addEventListener('input', () => {
    $('#spRateLabel').textContent = `${Number(rate.value).toFixed(2).replace(/0$/, '')}×`;
  });
  rate.addEventListener('change', () => setRate(rate.value));

  $('#spVoice').addEventListener('change', (e) => {
    if (e.target.value === '__all__') {
      showAllVoices = true;
      fillVoices();
      return;
    }
    if (e.target.value === '__few__') {
      showAllVoices = false;
      fillVoices();
      return;
    }
    setVoice(e.target.value);
  });
  // Populate up front so the picker is ready the first time the bar appears.
  fillVoices();

  $('#spVoiceWarn').addEventListener('click', openVoiceGuide);
  $('#voiceClose').addEventListener('click', () => $('#voiceModal').classList.add('hidden'));
  $('#voiceModal').addEventListener('click', (e) => {
    if (e.target.id === 'voiceModal') $('#voiceModal').classList.add('hidden');
  });
  $('#voiceOpenSettings').addEventListener('click', () => window.api.openVoiceSettings());
  $('#voiceRecheck').addEventListener('click', () => {
    // Re-read the system list rather than the cached one.
    refreshVoices();
    fillVoices();
    if (!voicesAreBasic()) {
      toast('Better voices found.');
      $('#voiceModal').classList.add('hidden');
      return;
    }
    // Chromium sometimes keeps the voice list it saw at startup, so a restart
    // is the reliable way to pick up a voice that finished downloading.
    $('#voiceRestart').hidden = false;
    toast('Still the old list — if the download finished, restart Sludge to pick it up.');
  });

  $('#voiceRestart').addEventListener('click', () => window.api.restart());

  $('#spShowText').addEventListener('change', async (e) => {
    teleprompterOn = e.target.checked;
    $('#teleprompter').hidden = !(teleprompterOn && (speech.playing || speech.paused));
    state.settings = await window.api.settings.set({ teleprompter: teleprompterOn });
  });
  $('#tpClose').addEventListener('click', () => {
    $('#spShowText').checked = false;
    $('#spShowText').dispatchEvent(new Event('change'));
  });
  $('#spFollow').addEventListener('change', (e) => { speech.followScroll = e.target.checked; });

  on('speech:voices', fillVoices);
  on('speech:changed', () => {
    if (speech.playing || speech.paused) {
      if (bar.hidden) fillVoices();
      bar.hidden = false;
    }
    $('#spPlay').innerHTML = speech.playing
      ? '<svg viewBox="0 0 24 24"><path d="M8 5.5h3v13H8zM13 5.5h3v13h-3z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>';
    $('#spPlay').classList.toggle('on', speech.playing);
    $('#btnRead').classList.toggle('active', speech.playing || speech.paused);
    const st = readingState();
    $('#spNow').textContent = st.text ? `p. ${st.page} · ${st.text.slice(0, 90)}` : '';
  });
}

let showAllVoices = false;
let teleprompterOn = true;

function fillVoices() {
  const select = $('#spVoice');
  const curated = getVoices();
  const basic = voicesAreBasic();
  $('#spVoiceWarn').hidden = !basic;

  if (showAllVoices) {
    const all = getAllVoices();
    select.replaceChildren(
      ...all.map((v) => el('option', {
        value: v.voiceURI,
        selected: v.voiceURI === speech.voiceURI
      }, `${v.name} (${v.lang})`)),
      el('option', { value: '__few__' }, '← Back to the four main voices')
    );
    return;
  }

  if (!curated.length) {
    select.replaceChildren(el('option', {}, 'System default'));
    return;
  }

  // Four choices — US and UK, male and female — rather than 180 system voices.
  select.replaceChildren(
    ...curated.map((c) => el('option', {
      value: c.voice.voiceURI,
      selected: c.voice.voiceURI === speech.voiceURI
    }, describeVoice(c))),
    el('option', { value: '__all__' }, 'Show every English voice…')
  );

  // Without a saved choice, start on the best one available.
  if (!speech.voiceURI && curated.length) {
    const best = [...curated].sort((a, b) => b.tier.rank - a.tier.rank)[0];
    select.value = best.voice.voiceURI;
  }
}

function openVoiceGuide() {
  $('#voiceModal').classList.remove('hidden');
}

/* ---------------- teleprompter ---------------- */

/** Move the voice to the sentence containing a page-level character offset. */
function jumpToSentenceWord(offset) {
  const i = sentenceAtOffset(offset);
  if (i >= 0) jumpToSentence(i);
}

const fmtClock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${m}:${sec}`;
};

/** Render the sentence as individual words so one can be lit at a time. */
function renderTeleprompterLine(text) {
  const line = $('#tpLine');
  const parts = [];
  const re = /\S+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(document.createTextNode(text.slice(last, m.index)));
    parts.push(el('span', { class: 'w', 'data-at': String(m.index), 'data-end': String(m.index + m[0].length) }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
  const scroll = el('div', { class: 'tp-scroll' }, ...parts);
  line.replaceChildren(scroll);
  tpOffset = 0;
  centreTeleprompter(null);
}

/**
 * Slide the sentence so the word being spoken sits on the panel's centre line.
 * Adjusts relative to the current offset, which avoids having to reason about
 * how flexbox has already positioned the block.
 */
let tpOffset = 0;

function centreTeleprompter(word) {
  const line = $('#tpLine');
  const scroll = line.querySelector('.tp-scroll');
  if (!scroll) return;

  if (!word) {
    tpOffset = 0;
    scroll.style.transform = '';
    return;
  }

  const lineBox = line.getBoundingClientRect();
  const wordBox = word.getBoundingClientRect();
  if (!lineBox.height || !wordBox.height) return;

  const lineCentre = lineBox.top + lineBox.height / 2;
  const wordCentre = wordBox.top + wordBox.height / 2;
  const delta = lineCentre - wordCentre;
  if (Math.abs(delta) < 1) return;

  tpOffset += delta;
  scroll.style.transform = `translateY(${Math.round(tpOffset)}px)`;
}

function markTeleprompterWord(start, end) {
  let current = null;
  for (const w of $$('#tpLine .w')) {
    const at = Number(w.dataset.at);
    const wEnd = Number(w.dataset.end);
    const now = at < end && wEnd > start;
    w.classList.toggle('now', now);
    w.classList.toggle('said', wEnd <= start);
    if (now && !current) current = w;
  }
  if (current) centreTeleprompter(current);
}

/* The six places it can land. Bottom is home. */
const TP_SPOTS = ['centre', 'bottom', 'bottom-left', 'bottom-right', 'top', 'top-left', 'top-right'];

function setTeleprompterSpot(spot) {
  const next = TP_SPOTS.includes(spot) ? spot : 'bottom';
  const tp = $('#teleprompter');
  tp.dataset.spot = next;
  // Clear any inline offsets left over from a drag.
  tp.style.left = tp.style.top = tp.style.right = tp.style.bottom = '';
  window.api.settings.set({ teleprompterSpot: next }).catch(() => {});
}

/** Where a spot would put the panel, used for the drag preview and snapping. */
function spotRect(spot, w, h) {
  const pad = 20;
  const bottomY = window.innerHeight - h - 46;
  const topY = 210;
  const midX = (window.innerWidth - w) / 2;
  const rightX = window.innerWidth - w - pad;
  const map = {
    centre: [midX, Math.max(120, (window.innerHeight - h) / 2)],
    bottom: [midX, bottomY],
    'bottom-left': [pad, bottomY],
    'bottom-right': [rightX, bottomY],
    top: [midX, topY],
    'top-left': [pad, topY],
    'top-right': [rightX, topY]
  };
  const [x, y] = map[spot] || map.bottom;
  return { x, y, w, h };
}

function nearestSpot(x, y, w, h) {
  let best = 'bottom';
  let bestDist = Infinity;
  for (const spot of TP_SPOTS) {
    const r = spotRect(spot, w, h);
    const dx = r.x - x;
    const dy = r.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = spot; }
  }
  return best;
}

function wireTeleprompterDrag() {
  const tp = $('#teleprompter');
  const ghost = $('#tpGhost');
  let dragging = false;
  let grabX = 0;
  let grabY = 0;
  let target = 'bottom';

  $('#tpGrip').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const r = tp.getBoundingClientRect();
    dragging = true;
    grabX = e.clientX - r.left;
    grabY = e.clientY - r.top;
    tp.classList.add('dragging');
    tp.dataset.spot = 'free';
    tp.style.left = `${r.left}px`;
    tp.style.top = `${r.top}px`;
    tp.style.right = tp.style.bottom = 'auto';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = tp.offsetWidth;
    const h = tp.offsetHeight;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - grabX));
    const y = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - grabY));
    tp.style.left = `${x}px`;
    tp.style.top = `${y}px`;

    target = nearestSpot(x, y, w, h);
    const r = spotRect(target, w, h);
    ghost.hidden = false;
    ghost.style.left = `${r.x}px`;
    ghost.style.top = `${r.y}px`;
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    tp.classList.remove('dragging');
    ghost.hidden = true;
    setTeleprompterSpot(target);
  });

  // Double-clicking the grip sends it home.
  $('#tpGrip').addEventListener('dblclick', () => setTeleprompterSpot('bottom'));
}

/** Drag along the caption progress bar to scrub through the page's sentences. */
function wireCaptionScrub() {
  const bar = $('#tpProgress');
  if (!bar) return;
  let scrubbing = false;

  const seek = (clientX) => {
    const st = readingState();
    if (!st.total) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const target = Math.min(st.total - 1, Math.floor(ratio * st.total));
    $('#tpBar').style.width = `${ratio * 100}%`;
    return target;
  };

  bar.addEventListener('mousedown', (e) => {
    scrubbing = true;
    bar.classList.add('scrubbing');
    seek(e.clientX);
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!scrubbing) return;
    const target = seek(e.clientX);
    if (target !== undefined) $('#tpMeta').textContent = `jump to sentence ${target + 1}`;
  });
  window.addEventListener('mouseup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    bar.classList.remove('scrubbing');
    const target = seek(e.clientX);
    if (target !== undefined) jumpToSentence(target);
  });
}

function wireTeleprompter() {
  wireCaptionScrub();

  // Clicking a word in the captions moves the voice to it.
  $('#tpLine').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (!w) return;
    const st = readingState();
    const at = Number(w.dataset.at);
    // Offsets in the panel are within the sentence; convert to page offsets.
    const sentenceStart = st.startOffset || 0;
    jumpToSentenceWord(sentenceStart + at);
  });

  teleprompterOn = state.settings.teleprompter !== false;
  $('#spShowText').checked = teleprompterOn;
  setTeleprompterSpot(state.settings.teleprompterSpot || 'bottom');
  wireTeleprompterDrag();

  on('speech:sentence', ({ text, index, total, page, remainingMs }) => {
    if (!teleprompterOn) return;
    $('#teleprompter').hidden = false;
    renderTeleprompterLine(text);
    $('#tpMeta').textContent = `p. ${page} · sentence ${index + 1} of ${total}`;
    $('#tpBar').style.width = `${total ? ((index) / total) * 100 : 0}%`;
    $('#tpLeft').textContent = `${fmtClock(remainingMs)} left on this page`;
  });

  on('speech:word', ({ wordStart, wordEnd, remainingMs }) => {
    if (!teleprompterOn) return;
    markTeleprompterWord(wordStart, wordEnd);
    $('#tpLeft').textContent = `${fmtClock(remainingMs)} left on this page`;
  });

  on('speech:changed', () => {
    const active = speech.playing || speech.paused;
    $('#teleprompter').hidden = !(teleprompterOn && active);
  });
}

/* ------------------------------------------------------------ document */

function wireDocument() {
  $('#btnDoc').addEventListener('click', () => toggleRightPanel('document'));
  $('#btnQuestions').addEventListener('click', () => toggleRightPanel('questions'));
  $('#btnDocSnap').addEventListener('click', toggleSplit);
  $('#rightSnap').addEventListener('click', toggleSplit);
}

/** Widen the side panel to half the window, for writing while reading. */
function toggleSplit() {
  const main = $('#main');
  if (!main.classList.contains('right-open')) openRightPanel('document');
  const on = main.classList.toggle('right-wide');
  $('#btnDocSnap').classList.toggle('active', on);
  window.api.settings.set({ splitView: on }).catch(() => {});
}

/* ------------------------------------------------------------ keyboard */

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
      || document.activeElement.isContentEditable;

    // Space pauses the voice from anywhere except a text field — it's the one
    // control worth having always to hand while listening.
    if (e.code === 'Space' && !typing && (speech.playing || speech.paused)) {
      e.preventDefault();
      speechToggle();
      return;
    }

    if (e.key === 'Escape') {
      hideSelectionPopup();
      closeNoteEditor();
      if (!$('#libraryModal').classList.contains('hidden')) hideLibrary();
      return;
    }
    if (typing) return;
    if (!state.pdf) return;

    switch (e.key) {
      case 'ArrowRight': case 'PageDown': e.preventDefault(); goToPage(state.currentPage + 1); break;
      case 'ArrowLeft':  case 'PageUp':   e.preventDefault(); goToPage(state.currentPage - 1); break;
      case 'Home': if (e.metaKey) { e.preventDefault(); goToPage(1); } break;
      case 'End':  if (e.metaKey) { e.preventDefault(); goToPage(state.numPages); } break;
      case 'g': case 'G': if (state.findResults.length) { e.preventDefault(); stepResult(e.shiftKey ? -1 : 1); } break;
      case 'v': setTool('select'); break;
      case 'h': if (!e.metaKey) setTool('highlight'); break;
      case 'p': if (!e.metaKey) setTool('pin'); break;
      case 'd': if (!e.metaKey) setTool('deadzone'); break;
      case 'r': if (!e.metaKey) { $('#btnRead').click(); } break;
      case ' ':
        e.preventDefault();
        setTool(state.tool === 'hand' ? 'select' : 'hand');
        break;
      default: break;
    }
  });
}

function handleMenu(action) {
  const map = {
    open: async () => { const p = await window.api.pickPdf(); if (p) openDocument(p); },
    library: showLibrary,
    export: exportNotes,
    reveal: () => $('#btnRevealSidecar').click(),
    find: () => openLeftPanel('search'),
    settings: showOnboarding,
    checkUpdates: async () => {
      const info = await window.api.update.check();
      if (info.upToDate) toast(`You're on the latest build (${info.current}).`);
      else {
        $('#ubText').innerHTML = `<b>Sludge ${escapeHtml(info.latest)}</b> is out — you're on ${escapeHtml(info.current)}.`;
        $('#updateBanner').classList.remove('hidden');
      }
    },
    'panel:thumbnails': () => openLeftPanel('thumbnails'),
    'panel:outline': () => openLeftPanel('outline'),
    'panel:notes': () => toggleRightPanel('notes'),
    'panel:ai': () => toggleRightPanel('ai'),
    'zoom:in': () => stepZoom(1),
    'zoom:out': () => stepZoom(-1),
    'zoom:fit': () => setZoom('fit'),
    theme: () => $('#themeToggle').click(),
    read: () => $('#btnRead').click(),
    document: () => toggleRightPanel('document'),
    split: toggleSplit,
    focus: openPicker,
    'tool:highlight': () => setTool('highlight'),
    'tool:pin': () => setTool('pin'),
    'tool:select': () => setTool('select'),
    'tool:deadzone': () => setTool('deadzone')
  };
  const fn = map[action];
  if (fn) fn();
}

/* ------------------------------------------------------------ drag & drop */

function wireDragDrop() {
  const dz = $('#dropzone');
  let depth = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++depth === 1) dz.hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--depth <= 0) { depth = 0; dz.hidden = true; }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dz.hidden = true;
    const file = [...(e.dataTransfer.files || [])].find((f) => /\.pdf$/i.test(f.name));
    if (!file) return toast('That is not a PDF.');
    const path = window.api.pathForFile ? window.api.pathForFile(file) : file.path;
    if (path) openDocument(path);
    else toast('Could not read that file path — use Open PDF instead.');
  });
}

boot();
