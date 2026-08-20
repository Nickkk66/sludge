import { $, $$, el, debounce, toast, fmtSize } from './util.js';
import { state, on, emit, COLORS } from './state.js';
import {
  initViewer, loadDocument, buildTextIndex, goToPage, setZoom, stepZoom,
  applyTool, refreshAnnotations, restorePosition, getPosition, destroy
} from './viewer.js';
import { initAnnotationUi, clearPage, closeNoteEditor, hideSelectionPopup } from './annotations.js';
import { initNotesPanel, renderNotesPanel } from './notes.js';
import { initThumbs, buildThumbnails, highlightCurrentThumb } from './thumbs.js';
import { buildOutline, initOutline } from './outline.js';
import { initSearch, runSearch, clearSearch, stepResult } from './search.js';
import { showLibrary, hideLibrary, makeCover, renderRecent } from './library.js';
import { initAi, refreshAiStatus, resetAiThread } from './ai.js';
import { exportNotes } from './exporter.js';

/* ------------------------------------------------------------ boot */

async function boot() {
  state.settings = await window.api.settings.get();
  state.theme = state.settings.theme || 'dark';
  state.color = state.settings.defaultColor || COLORS[2].hex;
  state.autoNote = state.settings.autoNote !== false;
  applyTheme(state.theme);

  initViewer();
  initAnnotationUi();
  initNotesPanel();
  initThumbs();
  initSearch();
  initOutline();
  initAi();
  buildSwatches();
  wireChrome();
  wireKeyboard();
  wireDragDrop();

  $('#autoNote').checked = state.autoNote;
  await renderRecent();
  refreshAiStatus({ autostart: false });

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

async function openDocument(filePath) {
  try {
    setSaveState('', 'Opening…');
    const doc = await window.api.openDoc(filePath);
    currentDoc = doc;

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

    $('#welcome').hidden = true;
    $('#docTab').hidden = false;
    $('#tabName').textContent = doc.name;
    document.title = `${doc.name} — Marginalia`;

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

async function closeDocument() {
  await saveNow();
  destroy();
  currentDoc = null;
  state.docId = state.filePath = state.docName = null;
  state.annotations = [];
  state.numPages = 0;
  $('#docTab').hidden = true;
  $('#welcome').hidden = false;
  $('#pageTotal').textContent = '0';
  document.title = 'Marginalia';
  clearSearch();
  resetAiThread();
  renderNotesPanel();
  $('#thumbs').replaceChildren();
  await renderRecent();
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
      lastPosition: pos
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
on('scroll:idle', () => scheduleSave());
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
  applyTool();
  if (tool !== 'select') hideSelectionPopup();
}

function openLeftPanel(view) {
  const main = $('#main');
  const already = $(`#rail .rail-btn[data-panel="${view}"]`).classList.contains('active');
  if (already && !main.classList.contains('left-collapsed')) {
    main.classList.add('left-collapsed');
    return;
  }
  main.classList.remove('left-collapsed');
  $$('#rail .rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === view));
  $$('#leftPanel .panel-view').forEach((p) => p.classList.toggle('active', p.dataset.view === view));
  $('#leftPanelTitle').textContent =
    { thumbnails: 'Thumbnails', outline: 'Chapters', search: 'Search', notes: 'Notes' }[view] || view;
  if (view === 'search') setTimeout(() => $('#searchInput').focus(), 40);
}

function openRightPanel(view) {
  const main = $('#main');
  $('#rightPanel').classList.remove('hidden');
  main.classList.add('right-open');
  $$('#rightPanel .rt').forEach((b) => b.classList.toggle('active', b.dataset.right === view));
  $$('#rightPanel .panel-view').forEach((p) => p.classList.toggle('active', p.dataset.view === view));
  if (view === 'ai') {
    refreshAiStatus();
    setTimeout(() => $('#aiInput').focus(), 60);
  }
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
  ['#btnOpen', '#welcomeOpen', '#tabAdd', '#libraryAdd'].forEach((sel) =>
    $(sel).addEventListener('click', async () => { hideLibrary(); await open(); }));

  ['#btnLibrary', '#btnLibraryTop', '#welcomeLibrary'].forEach((sel) =>
    $(sel).addEventListener('click', showLibrary));
  $('#libraryClose').addEventListener('click', hideLibrary);
  $('#libraryModal').addEventListener('click', (e) => { if (e.target.id === 'libraryModal') hideLibrary(); });

  $('#tabClose').addEventListener('click', closeDocument);

  $('#btnThumbs').addEventListener('click', () => openLeftPanel('thumbnails'));
  $('#btnOutline').addEventListener('click', () => openLeftPanel('outline'));
  ['#btnFind', '#btnFindTop'].forEach((s) => $(s).addEventListener('click', () => openLeftPanel('search')));
  $$('#rail .rail-btn').forEach((b) => b.addEventListener('click', () => openLeftPanel(b.dataset.panel)));
  $('#leftPanelClose').addEventListener('click', () => $('#main').classList.add('left-collapsed'));

  ['#btnNotesPanel', '#btnNotesPanel2'].forEach((s) => $(s).addEventListener('click', () => toggleRightPanel('notes')));
  ['#btnAsk', '#btnAsk2', '#btnAiTop'].forEach((s) => $(s).addEventListener('click', () => toggleRightPanel('ai')));
  $$('#rightPanel .rt').forEach((b) => b.addEventListener('click', () => openRightPanel(b.dataset.right)));
  $('#rightPanelClose').addEventListener('click', closeRightPanel);

  ['#btnExport', '#btnExport2'].forEach((s) => $(s).addEventListener('click', exportNotes));
  $('#btnClearPage').addEventListener('click', () => state.pdf && clearPage(state.currentPage));
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

  on('page:changed', (page) => {
    $('#pageInput').value = String(page);
    highlightCurrentThumb(page);
  });
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

/* ------------------------------------------------------------ keyboard */

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

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
      case ' ': if (!e.metaKey) setTool('hand'); break;
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
    settings: () => { $$('.rtab').find((t) => t.dataset.ribbon === 'ai').click(); },
    'panel:thumbnails': () => openLeftPanel('thumbnails'),
    'panel:outline': () => openLeftPanel('outline'),
    'panel:notes': () => toggleRightPanel('notes'),
    'panel:ai': () => toggleRightPanel('ai'),
    'zoom:in': () => stepZoom(1),
    'zoom:out': () => stepZoom(-1),
    'zoom:fit': () => setZoom('fit'),
    theme: () => $('#themeToggle').click(),
    'tool:highlight': () => setTool('highlight'),
    'tool:pin': () => setTool('pin'),
    'tool:select': () => setTool('select')
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
