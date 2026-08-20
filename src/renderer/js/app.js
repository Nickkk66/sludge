import { $, $$, el, debounce, toast, fmtSize, escapeHtml } from './util.js';
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
import { initSpeech, speech, play as speechPlay, pause as speechPause, stop as speechStop,
         toggle as speechToggle, skip as speechSkip, setRate, setVoice, getVoices, readingState } from './speech.js';
import { initDocNotes, getMarkdown, setMarkdown, togglePreview, exportDocument } from './docnotes.js';
import { initFocus, restoreFocus, openPicker } from './focus.js';
import { initProfile, loadProfile, showOnboarding, renderGreeting, profile } from './profile.js';
import { initScan, refreshScanStatus, setModels } from './scan.js';

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
  wireSpeechBar();
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
    speechStop();
    setMarkdown((doc.document && doc.document.markdown) || '');

    $('#welcome').hidden = true;
    $('#docTab').hidden = false;
    $('#tabName').textContent = doc.name;
    document.title = `${doc.name} — Sludge`;

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
  speechStop();
  setMarkdown('');
  destroy();
  currentDoc = null;
  state.docId = state.filePath = state.docName = null;
  state.annotations = [];
  state.numPages = 0;
  $('#docTab').hidden = true;
  $('#welcome').hidden = false;
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
  applyTool();
  if (tool !== 'select') hideSelectionPopup();
}

function openLeftPanel(view) {
  const main = $('#main');
  const already = $(`#rail .rail-btn[data-panel="${view}"]`).classList.contains('active');
  if (already && !main.classList.contains('left-collapsed')) {
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

const PANEL_TITLES = { thumbnails: 'Pages', outline: 'Chapters', search: 'Search', notes: 'Notes' };

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
  $('#leftPanelClose').addEventListener('click', () => {
    $('#main').classList.add('left-collapsed');
    syncRibbonState();
  });

  // The left Notes view mirrors the ribbon's note actions, so both routes work.
  $('#sideAllNotes').addEventListener('click', () => openRightPanel('notes'));
  $('#sideExport').addEventListener('click', exportNotes);

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

  $('#spVoice').addEventListener('change', (e) => setVoice(e.target.value));
  // Populate up front so the picker is ready the first time the bar appears.
  fillVoices();
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

function fillVoices() {
  const list = getVoices();
  const select = $('#spVoice');
  if (!list.length) {
    select.replaceChildren(el('option', {}, 'System default'));
    return;
  }
  select.replaceChildren(...list.map((v) => el('option', {
    value: v.voiceURI,
    selected: v.voiceURI === speech.voiceURI
  }, `${v.name} (${v.lang})`)));
}

/* ------------------------------------------------------------ document */

function wireDocument() {
  $('#btnDoc').addEventListener('click', () => toggleRightPanel('document'));
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
      case 'r': if (!e.metaKey) { $('#btnRead').click(); } break;
      case ' ':
        e.preventDefault();
        // Space controls read-aloud while it's running, and the hand tool otherwise.
        if (speech.playing || speech.paused) speechToggle();
        else setTool(state.tool === 'hand' ? 'select' : 'hand');
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
