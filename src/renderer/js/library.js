import { $, el, fmtDate, fmtSize, toast } from './util.js';
import { state, emit } from './state.js';

export async function showLibrary() {
  const modal = $('#libraryModal');
  const grid = $('#libraryGrid');
  modal.classList.remove('hidden');

  const lib = await window.api.library.list();
  if (!lib.docs.length) {
    grid.replaceChildren(el('p', { class: 'empty' }, 'Your library is empty. Add a PDF and it will stay here, with your notes and your place in it.'));
    return;
  }

  grid.replaceChildren(...lib.docs.map(libraryCard));
}

function libraryCard(d) {
  const card = el('div', {
    class: 'lib-card',
    onclick: (e) => {
      if (e.target.closest('.lib-remove, .lib-edit, .lib-editor')) return;
      hideLibrary();
      emit('doc:request', d.path);
    }
  },
    el('div', { class: 'lib-thumb' },
      d.thumb ? el('img', { src: d.thumb, alt: '' }) : el('span', { class: 'ph' }, '📄')),
    el('div', { class: 'lib-name' }, d.title || d.name),
    d.desc ? el('div', { class: 'lib-desc' }, d.desc) : null,
    el('div', { class: 'lib-meta' },
      [d.pages ? `${d.pages} pages` : null,
       d.noteCount ? `${d.noteCount} notes` : null,
       d.lastPage ? `p. ${d.lastPage}` : null,
       fmtDate(d.lastOpened)].filter(Boolean).join(' · ')),
    el('button', {
      class: 'lib-edit',
      title: 'Rename / describe',
      html: '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10a2 2 0 000-2.8l-1.2-1.2a2 2 0 00-2.8 0L4 16z"/></svg>',
      onclick: (e) => { e.stopPropagation(); openCardEditor(card, d); }
    }),
    el('button', {
      class: 'lib-remove',
      title: 'Remove from library (the PDF stays on disk)',
      onclick: async (e) => { e.stopPropagation(); await window.api.library.remove(d.docId); showLibrary(); }
    }, '✕')
  );
  return card;
}

/** Rename and describe a document in place, without leaving the grid. */
function openCardEditor(card, d) {
  if (card.querySelector('.lib-editor')) return;
  const name = el('input', { value: d.title || d.name, placeholder: 'Name', maxlength: '120' });
  const desc = el('textarea', { rows: '2', placeholder: 'Short description (optional)', maxlength: '300' }, d.desc || '');

  const save = async () => {
    const title = name.value.trim();
    await window.api.library.upsert({
      docId: d.docId,
      path: d.path,
      // An empty name falls back to the file name rather than showing nothing.
      title: title && title !== d.name ? title : '',
      desc: desc.value.trim()
    });
    showLibrary();
  };

  const editor = el('div', { class: 'lib-editor', onclick: (e) => e.stopPropagation() },
    name, desc,
    el('div', { class: 'lib-editor-actions' },
      el('button', { onclick: () => editor.remove() }, 'Cancel'),
      el('button', { class: 'primary', onclick: save }, 'Save')
    )
  );
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); editor.remove(); }
  });
  card.append(editor);
  setTimeout(() => { name.focus(); name.select(); }, 20);
}

export function hideLibrary() {
  $('#libraryModal').classList.add('hidden');
}

/** Snapshot page 1 as a small cover image for the library grid. */
export async function makeCover() {
  if (!state.pdf) return null;
  try {
    const page = await state.pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 200 / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

export async function renderRecent() {
  const box = $('#welcomeRecent');
  const lib = await window.api.library.list();
  if (!lib.docs.length) return box.replaceChildren();
  box.replaceChildren(
    el('h4', {}, 'Recent'),
    ...lib.docs.slice(0, 5).map((d) => el('div', {
      class: 'recent-item',
      onclick: () => emit('doc:request', d.path)
    },
      el('span', { class: 'ri-name' }, d.title || d.name),
      el('span', { class: 'ri-meta' }, [d.lastPage ? `p. ${d.lastPage}` : null, fmtDate(d.lastOpened)].filter(Boolean).join(' · '))
    ))
  );
}
