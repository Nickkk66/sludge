import { $, el } from './util.js';
import { state, on } from './state.js';
import { goToPage } from './viewer.js';

const drawn = new Set();
let observer = null;
const THUMB_W = 158;

export function buildThumbnails() {
  const box = $('#thumbs');
  box.replaceChildren();
  drawn.clear();
  if (observer) observer.disconnect();

  const frag = document.createDocumentFragment();
  for (let n = 1; n <= state.numPages; n++) {
    const item = el('div', {
      class: `thumb${n === state.currentPage ? ' current' : ''}`,
      'data-page': String(n),
      onclick: () => goToPage(n)
    },
      el('div', { class: 'tcanvas' }),
      el('span', { class: 'tnum' }, String(n))
    );
    frag.append(item);
  }
  box.append(frag);

  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) drawThumb(Number(e.target.dataset.page), e.target);
  }, { root: $('#leftPanel'), rootMargin: '250px 0px' });

  for (const node of box.children) observer.observe(node);
  markAnnotated();
}

async function drawThumb(n, node) {
  if (drawn.has(n) || !state.pdf) return;
  drawn.add(n);
  try {
    const page = await state.pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = THUMB_W / vp1.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    const holder = node.querySelector('.tcanvas');
    holder.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    holder.replaceChildren(canvas);
    markAnnotated(n);
  } catch {
    drawn.delete(n);
  }
}

/** Dot the thumbnails that carry annotations. */
export function markAnnotated(only) {
  const pages = new Set(state.annotations.map((a) => a.page));
  const nodes = only
    ? [$(`#thumbs .thumb[data-page="${only}"]`)].filter(Boolean)
    : [...$('#thumbs').children];
  for (const node of nodes) {
    const n = Number(node.dataset.page);
    const holder = node.querySelector('.tcanvas');
    const dot = holder.querySelector('.tdot');
    if (pages.has(n) && !dot) holder.append(el('i', { class: 'tdot' }));
    else if (!pages.has(n) && dot) dot.remove();
  }
}

export function highlightCurrentThumb(page) {
  const box = $('#thumbs');
  const prev = box.querySelector('.thumb.current');
  if (prev) prev.classList.remove('current');
  const node = box.querySelector(`.thumb[data-page="${page}"]`);
  if (!node) return;
  node.classList.add('current');
  const panel = $('#leftPanel .panel-view[data-view="thumbnails"]');
  const nb = node.getBoundingClientRect();
  const pb = panel.getBoundingClientRect();
  if (nb.top < pb.top || nb.bottom > pb.bottom) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function initThumbs() {
  on('annotations:changed', () => markAnnotated());
}
