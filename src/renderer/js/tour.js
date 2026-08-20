import { $, el, toast } from './util.js';
import { state, emit } from './state.js';

/**
 * The first-run walkthrough.
 *
 * Sludge has an unusual amount of machinery for a PDF reader — read-aloud,
 * dead zones, a document, a local model, a video strip — and none of it is
 * guessable from the icons. This points at each in turn, in the order someone
 * would actually meet them.
 */

const STEPS = [
  {
    title: 'This is your reading pile',
    body: 'Every PDF you open gets a tab. They keep their own notes, chapters and place in the book, so opening a second one never costs you your spot in the first.',
    target: '#tabstrip',
    place: 'below'
  },
  {
    title: 'Highlight and annotate',
    body: 'Select text to highlight it and attach a note. Pin Note drops a marker anywhere — margins, diagrams, maps. Everything saves to a plain file next to the PDF.',
    target: '.rb[data-tool="highlight"]',
    place: 'below'
  },
  {
    title: 'It reads to you',
    body: 'Read Aloud speaks the page, highlighting each word as it goes and turning pages for you. Click anywhere on the page — or on the caption panel — to move the voice there. Space pauses.',
    target: '#btnRead',
    place: 'below'
  },
  {
    title: 'Areas to skip',
    body: 'Figures, captions and answer keys derail both the voice and the AI. Mark them as dead zones and they get skipped entirely.',
    target: '.rb[data-tool="deadzone"]',
    place: 'below',
    before: () => document.querySelectorAll('.rtab')[1].click(),
    after: () => document.querySelectorAll('.rtab')[0].click()
  },
  {
    title: 'Chapters, even without an outline',
    body: 'Most scanned textbooks have no built-in chapter list. Sludge reads the book’s own contents pages and works out where each chapter actually starts.',
    target: '#btnOutline',
    place: 'below'
  },
  {
    title: 'Ask about what you’re reading',
    body: 'The local model searches the pages and your own notes, then answers with citations — and always tells you which came from your notes. Nothing leaves this machine.',
    target: '#btnAsk',
    place: 'below'
  },
  {
    title: 'Write alongside it',
    body: 'A document that formats as you type: "# " makes a heading, "- [ ] " makes a tick box. Send any highlight into it, and hand a paragraph to the AI to tidy up.',
    target: '#btnDoc',
    place: 'below',
    before: () => document.querySelectorAll('.rtab')[4].click(),
    after: () => document.querySelectorAll('.rtab')[0].click()
  },
  {
    title: 'Brainrot mode',
    body: 'A silent gameplay strip for when a page of text won’t hold still. Dock it to any edge — on the left or right it becomes a tall portrait crop. It never starts on its own.',
    target: '#btnFocus',
    place: 'left'
  },
  {
    title: 'Setups',
    body: 'Arranging four panels every session gets old. A setup saves the whole layout — video edge, caption size, which panel is open — and puts it back in one click.',
    target: '#btnLayouts',
    place: 'left'
  },
  {
    title: 'Everything else lives here',
    body: 'Voices, the AI model, your name, themes and this walkthrough are all in Settings. That’s the tour — go and read something.',
    target: '#btnSettings',
    place: 'left'
  }
];

let index = 0;
let active = false;
let onFinish = null;

function visibleSteps() {
  return STEPS.filter((s) => {
    // A step with a `before` hook reveals its own target — judging it on
    // current visibility would drop it before it had the chance.
    if (s.before) return !!document.querySelector(s.target);
    const node = document.querySelector(s.target);
    return node && node.offsetParent !== null;
  });
}

let steps = [];

function position() {
  const step = steps[index];
  const node = document.querySelector(step.target);
  const hole = $('#tourHole');
  const card = $('#tourCard');
  if (!node) return next();

  const r = node.getBoundingClientRect();
  const pad = 6;
  hole.style.left = `${r.left - pad}px`;
  hole.style.top = `${r.top - pad}px`;
  hole.style.width = `${r.width + pad * 2}px`;
  hole.style.height = `${r.height + pad * 2}px`;

  $('#tourStep').textContent = `Step ${index + 1} of ${steps.length}`;
  $('#tourTitle').textContent = step.title;
  $('#tourBody').textContent = step.body;
  $('#tourBack').disabled = index === 0;
  $('#tourNext').textContent = index === steps.length - 1 ? 'Done' : 'Next';

  // Place the card near its target without letting it leave the window.
  const cw = card.offsetWidth || 340;
  const ch = card.offsetHeight || 180;
  let left = r.left + r.width / 2 - cw / 2;
  let top = r.bottom + 14;

  if (step.place === 'left') {
    left = r.left - cw - 14;
    top = r.top;
  }
  if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
  left = Math.max(12, Math.min(window.innerWidth - cw - 12, left));
  top = Math.max(12, Math.min(window.innerHeight - ch - 12, top));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function runBefore() {
  const step = steps[index];
  if (step && step.before) {
    try { step.before(); } catch { /* a missing panel shouldn't end the tour */ }
  }
}

function runAfter() {
  const step = steps[index];
  if (step && step.after) {
    try { step.after(); } catch { /* same */ }
  }
}

function show() {
  runBefore();
  // Let any panel opened by `before` lay out before measuring.
  requestAnimationFrame(() => setTimeout(position, 60));
}

function next() {
  runAfter();
  if (index >= steps.length - 1) return finish();
  index += 1;
  show();
}

function back() {
  runAfter();
  if (index === 0) return;
  index -= 1;
  show();
}

async function finish() {
  runAfter();
  active = false;
  $('#tourOverlay').classList.add('hidden');
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', position);
  state.settings = await window.api.settings.set({ tourDone: true });
  if (onFinish) onFinish();
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); finish(); }
  if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
}

export function startTour(options = {}) {
  steps = visibleSteps();
  if (!steps.length) return toast('Open a PDF first and the tour will make more sense.');
  index = 0;
  active = true;
  onFinish = options.onFinish || null;
  $('#tourOverlay').classList.remove('hidden');
  show();
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', position);
}

export const tourSeen = () => state.settings.tourDone === true;

export function initTour() {
  $('#tourNext').addEventListener('click', next);
  $('#tourBack').addEventListener('click', back);
  $('#tourSkip').addEventListener('click', finish);
}
