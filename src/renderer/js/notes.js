import { $, el, escapeHtml } from './util.js';
import { state, emit, on, COLORS, filteredAnnotations, allTags, usedColors } from './state.js';
import { openNoteEditor, deleteAnnotation } from './annotations.js';
import { scrollToSpot, refreshAnnotations } from './viewer.js';

export function renderNotesPanel() {
  renderFilters();
  const list = $('#notesList');
  const notes = filteredAnnotations();

  $('#notesCount').textContent = notes.length === state.annotations.length
    ? `${notes.length} note${notes.length === 1 ? '' : 's'}`
    : `${notes.length} of ${state.annotations.length}`;

  if (!notes.length) {
    list.replaceChildren(el('p', { class: 'empty' },
      state.annotations.length
        ? 'No notes match these filters.'
        : 'Select text and highlight it, or drop a pin, and your notes will collect here.'));
    return;
  }

  list.replaceChildren(...notes.map(noteCard));
}

function noteCard(a) {
  const card = el('div', {
    class: `note-card${state.selectedAnnotation === a.id ? ' active' : ''}`,
    'data-id': a.id,
    style: { '--card-color': a.color },
    onclick: (e) => {
      if (e.target.closest('.nc-actions')) return;
      jumpTo(a);
    }
  });

  const head = el('div', { class: 'nc-head' },
    el('span', { class: 'nc-page' }, `Page ${a.page}`),
    el('span', { class: 'nc-kind' }, a.type === 'pin' ? 'pin' : 'highlight')
  );

  const actions = el('div', { class: 'nc-actions' },
    el('button', {
      title: 'Edit note',
      html: '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10a2 2 0 000-2.8l-1.2-1.2a2 2 0 00-2.8 0L4 16z"/></svg>',
      onclick: (e) => { e.stopPropagation(); jumpTo(a); setTimeout(() => openNoteEditor(a), 380); }
    }),
    el('button', {
      title: 'Copy',
      html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/></svg>',
      onclick: (e) => {
        e.stopPropagation();
        const parts = [];
        if (a.quote) parts.push(`"${a.quote}"`);
        if (a.note) parts.push(a.note);
        navigator.clipboard.writeText(`${parts.join('\n')}\n— p. ${a.page}`);
      }
    }),
    el('button', {
      title: 'Delete',
      html: '<svg viewBox="0 0 24 24"><path d="M6 7h12M9.5 7V5.5h5V7M7.5 7l.8 12.5h7.4L16.5 7"/></svg>',
      onclick: (e) => { e.stopPropagation(); deleteAnnotation(a.id); }
    })
  );
  head.append(actions);
  card.append(head);

  if (a.quote) card.append(el('div', { class: 'nc-quote' }, a.quote));
  card.append(a.note
    ? el('div', { class: 'nc-note' }, a.note)
    : el('div', { class: 'nc-note empty-note' }, a.quote ? 'No note yet — click to add one.' : 'Empty pin.'));

  if (a.tags && a.tags.length) {
    card.append(el('div', { class: 'nc-tags' },
      ...a.tags.map((t) => el('span', {
        class: 'nc-tag',
        onclick: (e) => { e.stopPropagation(); toggleTag(t); }
      }, `#${t}`))));
  }
  return card;
}

function jumpTo(a) {
  state.selectedAnnotation = a.id;
  const y = a.type === 'pin' ? a.y : (a.rects && a.rects[0] ? a.rects[0].y : 0);
  scrollToSpot(a.page, y);
  refreshAnnotations();
  renderNotesPanel();
}

/* ---------------- filters ---------------- */

function renderFilters() {
  const colorRow = $('#colorFilters');
  const used = new Map(usedColors());
  const colorChips = COLORS.filter((c) => used.has(c.hex)).map((c) => el('button', {
    class: `fchip${state.colorFilter.has(c.hex) ? ' on' : ''}`,
    onclick: () => {
      state.colorFilter.has(c.hex) ? state.colorFilter.delete(c.hex) : state.colorFilter.add(c.hex);
      renderNotesPanel();
    }
  }, el('i', { class: 'dot', style: { background: c.hex } }), String(used.get(c.hex))));
  colorRow.replaceChildren(...colorChips);

  const tagRow = $('#tagFilters');
  const tags = allTags();
  tagRow.replaceChildren(...tags.map(([tag, n]) => el('button', {
    class: `fchip${state.tagFilter.has(tag) ? ' on' : ''}`,
    onclick: () => toggleTag(tag)
  }, `#${tag}`, el('span', { style: { color: 'var(--fg-3)' } }, String(n)))));

  // Mirror the tag chips into the Notes ribbon so they're reachable up top too.
  const ribbonBar = $('#ribbonTagBar');
  if (ribbonBar) {
    ribbonBar.replaceChildren(...(tags.length
      ? tags.slice(0, 10).map(([tag]) => el('button', {
          class: `fchip${state.tagFilter.has(tag) ? ' on' : ''}`,
          onclick: () => { toggleTag(tag); emit('panel:open', 'notes'); }
        }, `#${tag}`))
      : [el('span', { class: 'ribbon-hint' }, 'Tag a note (exam, confused…) and the tags appear here.')]));
  }
}

function toggleTag(tag) {
  state.tagFilter.has(tag) ? state.tagFilter.delete(tag) : state.tagFilter.add(tag);
  renderNotesPanel();
}

export function initNotesPanel() {
  $('#noteFilter').addEventListener('input', (e) => {
    state.noteQuery = e.target.value;
    renderNotesPanel();
  });
  on('annotations:changed', () => renderNotesPanel());
  on('annotation:selected', () => renderNotesPanel());
}
