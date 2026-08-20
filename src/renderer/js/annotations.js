import { $, el, escapeHtml, mergeLineRects, toast } from './util.js';
import { state, emit, COLORS, makeHighlight, makePin, annotationsOnPage } from './state.js';

let popupEl = null;
let editorTarget = null;   // annotation currently open in the editor

/* ------------------------------------------------------------ painting */

export function paintAnnotations(pageNum, layer) {
  layer.replaceChildren();
  for (const a of annotationsOnPage(pageNum)) {
    if (a.type === 'highlight') {
      const rects = a.rects || [];
      rects.forEach((r, i) => {
        // The "has a note" dot belongs on the last line only, so a multi-line
        // highlight doesn't sprout a dot per line.
        const marker = a.note && i === rects.length - 1 ? ' has-note' : '';
        const box = el('div', {
          class: `hl${marker}`,
          'data-id': a.id,
          style: {
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.w * 100}%`,
            height: `${r.h * 100}%`,
            background: a.color
          },
          title: a.note || 'Highlight — click to add a note'
        });
        layer.append(box);
      });
    } else if (a.type === 'pin') {
      const pin = el('div', {
        class: 'pin',
        'data-id': a.id,
        style: { left: `${a.x * 100}%`, top: `${a.y * 100}%` },
        title: a.note || 'Pinned note',
        html: `<svg viewBox="0 0 24 24"><path d="M12 22s7-6.4 7-11.3A7 7 0 005 10.7C5 15.6 12 22 12 22z" fill="${a.color}"/><circle cx="12" cy="10.6" r="2.4" fill="rgba(0,0,0,.35)" stroke="none"/></svg>`
      });
      layer.append(pin);
    }
  }

  // Search hits are drawn on the same layer so they scale with the page.
  if (state.findResults.length) {
    for (let i = 0; i < state.findResults.length; i++) {
      const hit = state.findResults[i];
      if (hit.page !== pageNum || !hit.rects) continue;
      for (const r of hit.rects) {
        layer.append(el('div', {
          class: `find-hit${i === state.findCurrent ? ' current' : ''}`,
          style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }
        }));
      }
    }
  }
}

/** Every rect belonging to one annotation, across the rendered pages. */
const partsOf = (id) => [...document.querySelectorAll(`.annoLayer [data-id="${id}"]`)];

/** Pulse an annotation so a jump lands somewhere visible, then settles. */
export function flashAnnotation(id) {
  const parts = partsOf(id);
  for (const node of parts) {
    node.classList.remove('flash');
    // Restart the animation even if it is already running.
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  }
}

export function setAnnotationHover(id, on) {
  for (const node of partsOf(id)) node.classList.toggle('hover', on);
}

/* ------------------------------------------------------------ selection → rects */

/** Map the live text selection onto normalized per-page rectangles. */
export function selectionToPageRects() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

  const range = sel.getRangeAt(0);
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const byPage = new Map();
  for (const domRect of range.getClientRects()) {
    if (domRect.width < 0.5 || domRect.height < 0.5) continue;
    const pageEl = pageElementAt(domRect);
    if (!pageEl) continue;
    const pageNum = Number(pageEl.dataset.page);
    const pb = pageEl.getBoundingClientRect();
    const rect = {
      x: (domRect.left - pb.left) / pb.width,
      y: (domRect.top - pb.top) / pb.height,
      w: domRect.width / pb.width,
      h: domRect.height / pb.height
    };
    if (rect.w <= 0 || rect.h <= 0) continue;
    if (!byPage.has(pageNum)) byPage.set(pageNum, []);
    byPage.get(pageNum).push(rect);
  }
  if (!byPage.size) return null;

  return { text, pages: [...byPage.entries()].map(([page, rects]) => ({ page, rects: mergeLineRects(rects) })) };
}

function pageElementAt(domRect) {
  const node = document.elementFromPoint(domRect.left + domRect.width / 2, domRect.top + domRect.height / 2);
  return node ? node.closest('.page') : null;
}

/* ------------------------------------------------------------ create */

export function highlightSelection(color = state.color, { openEditor = null } = {}) {
  const picked = selectionToPageRects();
  if (!picked) return null;

  const created = [];
  for (const { page, rects } of picked.pages) {
    // A multi-page selection becomes one highlight per page, each keeping the
    // slice of text that actually sits on that page's rectangles.
    const quote = picked.pages.length === 1 ? picked.text : picked.text;
    const anno = makeHighlight({ page, rects, quote, color });
    state.annotations.push(anno);
    created.push(anno);
  }

  window.getSelection().removeAllRanges();
  hideSelectionPopup();
  emit('annotations:changed', { added: created });

  const wantEditor = openEditor === null ? state.autoNote : openEditor;
  if (created.length && wantEditor) openNoteEditor(created[0]);
  return created[0] || null;
}

export function addPin(pageNum, x, y) {
  const anno = makePin({ page: pageNum, x, y });
  state.annotations.push(anno);
  emit('annotations:changed', { added: [anno] });
  openNoteEditor(anno);
  return anno;
}

/* ------------------------------------------------------------ mutate */

export function updateAnnotation(id, patch) {
  const a = state.annotations.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch, { updated: new Date().toISOString() });
  emit('annotations:changed', { updated: [a] });
  return a;
}

export function deleteAnnotation(id) {
  const i = state.annotations.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [gone] = state.annotations.splice(i, 1);
  if (state.selectedAnnotation === id) state.selectedAnnotation = null;
  emit('annotations:changed', { removed: [gone] });
}

export function clearPage(pageNum) {
  const before = state.annotations.length;
  state.annotations = state.annotations.filter((a) => a.page !== pageNum);
  const removed = before - state.annotations.length;
  if (removed) {
    emit('annotations:changed', { removed: [] });
    toast(`Removed ${removed} annotation${removed === 1 ? '' : 's'} from page ${pageNum}`);
  } else {
    toast(`Nothing to clear on page ${pageNum}`);
  }
}

/* ------------------------------------------------------------ selection popup */

export function showSelectionPopup() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelectionPopup();
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return hideSelectionPopup();
  if (!range.startContainer.parentElement || !range.startContainer.parentElement.closest('.textLayer')) {
    return hideSelectionPopup();
  }

  if (!popupEl) {
    popupEl = el('div', { id: 'selPopup' });
    for (const c of COLORS) {
      popupEl.append(el('button', {
        class: 'sp-swatch',
        style: { background: c.hex },
        title: `Highlight ${c.name.toLowerCase()}`,
        onclick: () => highlightSelection(c.hex, { openEditor: false })
      }));
    }
    popupEl.append(el('div', { class: 'sp-div' }));
    popupEl.append(el('button', {
      class: 'sp-btn',
      title: 'Highlight and write a note',
      html: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></svg><span>Note</span>',
      onclick: () => highlightSelection(state.color, { openEditor: true })
    }));
    popupEl.append(el('button', {
      class: 'sp-btn',
      title: 'Copy text',
      html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
      onclick: () => {
        navigator.clipboard.writeText(window.getSelection().toString());
        toast('Copied');
        hideSelectionPopup();
      }
    }));
    popupEl.append(el('button', {
      class: 'sp-btn',
      title: 'Ask the AI about this passage',
      html: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5 10.2 10.8 5.5 9l4.7-1.3z"/></svg><span>Ask</span>',
      onclick: () => {
        const text = window.getSelection().toString().replace(/\s+/g, ' ').trim();
        emit('ai:askAbout', text);
        hideSelectionPopup();
      }
    }));
    $('#viewerWrap').append(popupEl);
  }

  const wrap = $('#viewerWrap').getBoundingClientRect();
  popupEl.hidden = false;
  const px = rect.left - wrap.left + rect.width / 2;
  const py = rect.top - wrap.top;
  popupEl.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const pw = popupEl.offsetWidth;
    const ph = popupEl.offsetHeight;
    popupEl.style.left = `${Math.max(8, Math.min(wrap.width - pw - 8, px - pw / 2))}px`;
    popupEl.style.top = `${py > ph + 12 ? py - ph - 8 : rect.bottom - wrap.top + 8}px`;
    popupEl.style.visibility = 'visible';
  });
}

export function hideSelectionPopup() {
  if (popupEl) popupEl.hidden = true;
}

/* ------------------------------------------------------------ note editor */

export function openNoteEditor(anno, anchorEl) {
  editorTarget = anno;
  const editor = $('#noteEditor');
  const quote = $('#neQuote');
  const text = $('#neText');
  const tags = $('#neTags');
  const colors = $('#neColors');

  quote.hidden = !anno.quote;
  quote.textContent = anno.quote || '';
  text.value = anno.note || '';
  tags.value = (anno.tags || []).join(', ');

  colors.replaceChildren(...COLORS.map((c) => el('button', {
    class: `swatch${c.hex === anno.color ? ' active' : ''}`,
    style: { background: c.hex },
    title: c.name,
    onclick: (e) => {
      anno.color = c.hex;
      [...colors.children].forEach((n) => n.classList.remove('active'));
      e.currentTarget.classList.add('active');
    }
  })));

  editor.classList.remove('hidden');
  positionEditor(editor, anno, anchorEl);
  setTimeout(() => text.focus(), 30);
}

function positionEditor(editor, anno, anchorEl) {
  const target = anchorEl || document.querySelector(`.annoLayer [data-id="${anno.id}"]`);
  const wrapRect = document.body.getBoundingClientRect();
  let left = wrapRect.width / 2 - 160;
  let top = 160;
  if (target) {
    const r = target.getBoundingClientRect();
    left = r.left;
    top = r.bottom + 8;
  }
  const w = 320;
  const h = editor.offsetHeight || 230;
  editor.style.left = `${Math.max(10, Math.min(window.innerWidth - w - 10, left))}px`;
  editor.style.top = `${Math.max(10, Math.min(window.innerHeight - h - 44, top))}px`;
}

export function closeNoteEditor() {
  $('#noteEditor').classList.add('hidden');
  editorTarget = null;
}

export function initAnnotationUi() {
  $('#neSave').addEventListener('click', () => {
    if (!editorTarget) return;
    const tags = $('#neTags').value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
    updateAnnotation(editorTarget.id, {
      note: $('#neText').value.trim(),
      tags,
      color: editorTarget.color
    });
    closeNoteEditor();
  });

  $('#neCancel').addEventListener('click', () => {
    // A pin with no note was only ever created to hold one — drop it.
    if (editorTarget && editorTarget.type === 'pin' && !editorTarget.note) deleteAnnotation(editorTarget.id);
    closeNoteEditor();
  });

  $('#neDelete').addEventListener('click', () => {
    if (editorTarget) deleteAnnotation(editorTarget.id);
    closeNoteEditor();
  });

  $('#neText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#neSave').click(); }
    if (e.key === 'Escape') { e.preventDefault(); $('#neCancel').click(); }
  });

  // Hovering any rect of a highlight lights up the whole highlight.
  const pages = $('#pages');
  let hovered = null;
  pages.addEventListener('mouseover', (e) => {
    const hit = e.target.closest('.hl, .pin');
    const id = hit ? hit.dataset.id : null;
    if (id === hovered) return;
    if (hovered) setAnnotationHover(hovered, false);
    hovered = id;
    if (id) setAnnotationHover(id, true);
  });
  pages.addEventListener('mouseleave', () => {
    if (hovered) setAnnotationHover(hovered, false);
    hovered = null;
  });

  // Clicks on the page: open an existing annotation, or drop a pin.
  $('#pages').addEventListener('mousedown', (e) => {
    const hit = e.target.closest('.hl, .pin');
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      const anno = state.annotations.find((a) => a.id === hit.dataset.id);
      if (anno) {
        state.selectedAnnotation = anno.id;
        emit('annotation:selected', anno);
        openNoteEditor(anno, hit);
      }
      return;
    }
    if (state.tool === 'pin') {
      const pageEl = e.target.closest('.page');
      if (!pageEl) return;
      e.preventDefault();
      const r = pageEl.getBoundingClientRect();
      addPin(Number(pageEl.dataset.page), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    }
  });

  // Selection popup follows the mouse-up that ends a drag-select.
  $('#pages').addEventListener('mouseup', () => {
    if (state.tool === 'hand' || state.tool === 'pin') return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        if (state.tool === 'highlight') highlightSelection(state.color);
        else showSelectionPopup();
      } else {
        hideSelectionPopup();
      }
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (popupEl && !popupEl.contains(e.target) && !e.target.closest('.textLayer')) hideSelectionPopup();
    const editor = $('#noteEditor');
    if (!editor.classList.contains('hidden') &&
        !editor.contains(e.target) &&
        !e.target.closest('.hl, .pin, .note-card')) {
      $('#neSave').click();
    }
  });
}

export const currentEditorTarget = () => editorTarget;
