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

  grid.replaceChildren(...lib.docs.map((d) => el('div', { class: 'lib-card', onclick: () => { modal.classList.add('hidden'); emit('doc:request', d.path); } },
    el('div', { class: 'lib-thumb' },
      d.thumb ? el('img', { src: d.thumb, alt: '' }) : el('span', { class: 'ph' }, '📄')),
    el('div', { class: 'lib-name' }, d.name),
    el('div', { class: 'lib-meta' },
      [d.pages ? `${d.pages} pages` : null,
       d.noteCount ? `${d.noteCount} notes` : null,
       d.lastPage ? `p. ${d.lastPage}` : null,
       fmtDate(d.lastOpened)].filter(Boolean).join(' · ')),
    el('button', {
      class: 'lib-remove',
      title: 'Remove from library (the PDF stays on disk)',
      onclick: async (e) => { e.stopPropagation(); await window.api.library.remove(d.docId); showLibrary(); }
    }, '✕')
  )));
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
      el('span', { class: 'ri-name' }, d.name),
      el('span', { class: 'ri-meta' }, [d.lastPage ? `p. ${d.lastPage}` : null, fmtDate(d.lastOpened)].filter(Boolean).join(' · '))
    ))
  );
}
