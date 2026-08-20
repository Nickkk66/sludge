import { $, el, escapeHtml, toast, setChildren } from './util.js';
import { state, emit, on } from './state.js';
import { goToPage } from './viewer.js';

/**
 * Story mode.
 *
 * The same trick as the gameplay strip, applied to the text: a chapter retold
 * as a first-person Reddit post, read aloud. It keeps the facts — the model is
 * told the point is remembering the history, not sounding good — and cites the
 * pages it came from so it can be checked against the book.
 *
 * It is a way in, not a substitute for the chapter.
 */

const SUBS = [
  { id: 'AmITheAsshole', label: 'r/AmITheAsshole', voice: 'someone in the middle of it, defending themselves' },
  { id: 'tifu', label: 'r/tifu', voice: 'the person who caused the mess, owning up' },
  { id: 'HistoryAnecdotes', label: 'r/HistoryAnecdotes', voice: 'a bystander telling a story down the pub' },
  { id: 'explainlikeimfive', label: 'r/explainlikeimfive', voice: 'someone explaining it plainly to a friend' },
  { id: 'nosleep', label: 'r/nosleep', voice: 'someone who found it unsettling and cannot let it go' }
];

let story = null;
let busy = false;

/* ------------------------------------------------------------ source */

/** The chapters worth offering, or page ranges when there is no chapter list. */
function sources() {
  const chapters = state.chapters || [];
  if (chapters.length) {
    return chapters.map((c, i) => ({
      label: c.title,
      from: c.page,
      to: i + 1 < chapters.length ? chapters[i + 1].page - 1 : state.numPages
    }));
  }
  const out = [];
  for (let p = 1; p <= state.numPages; p += 10) {
    out.push({ label: `Pages ${p}–${Math.min(state.numPages, p + 9)}`, from: p, to: Math.min(state.numPages, p + 9) });
  }
  return out;
}

function textFor(from, to, limit = 4600) {
  const pages = state.pageText.filter((p) => p && p.page >= from && p.page <= to && p.text);
  const joined = pages.map((p) => p.text).join('\n').trim();
  if (joined.length <= limit) return joined;
  // Sample across the range so the retelling covers more than the opening.
  const head = Math.round(limit * 0.5);
  const mid = Math.round(limit * 0.3);
  const tail = limit - head - mid;
  const midAt = Math.floor(joined.length / 2 - mid / 2);
  return [joined.slice(0, head), joined.slice(midAt, midAt + mid), joined.slice(-tail)].join('\n…\n');
}

/* ------------------------------------------------------------ generate */

async function generate(source, sub) {
  if (!state.pdf) return toast('Open a PDF first.');
  if (!state.indexReady) return toast('Still reading the document — try again in a moment.');
  if (!state.aiModel) return toast('No local model available — check the AI tab.');

  const text = textFor(source.from, source.to);
  if (text.length < 300) return toast('Not enough text in that section.');

  busy = true;
  render();
  try {
    const result = await window.api.ai.story({
      model: state.aiModel,
      text,
      subreddit: sub.id,
      voice: sub.voice
    });
    story = {
      ...result,
      source,
      sub,
      created: new Date().toISOString()
    };
  } catch (err) {
    toast(`Could not write it: ${err.message || err}`);
  } finally {
    busy = false;
    render();
  }
}

/* ------------------------------------------------------------ rendering */

function controls() {
  const list = sources();
  const pick = el('select', { id: 'storySource' },
    ...list.map((s, i) => el('option', { value: String(i) }, s.label)));

  // Default to whatever chapter the reader is currently in.
  const current = list.findIndex((s) => state.currentPage >= s.from && state.currentPage <= s.to);
  if (current >= 0) pick.value = String(current);

  const sub = el('select', { id: 'storySub' },
    ...SUBS.map((s) => el('option', { value: s.id }, s.label)));

  return el('div', { class: 'story-controls' },
    el('label', {}, el('span', {}, 'Section'), pick),
    el('label', {}, el('span', {}, 'Told like'), sub),
    el('button', {
      class: 'primary',
      disabled: busy,
      onclick: () => generate(list[Number(pick.value)], SUBS.find((x) => x.id === sub.value))
    }, busy ? 'Writing…' : (story ? 'Write another' : 'Write it'))
  );
}

function render() {
  const box = $('#storyView');
  if (!box) return;

  if (busy && !story) {
    setChildren(box, controls(), el('div', { class: 'story-busy' },
      el('i', { class: 'spin' }),
      el('span', {}, 'Retelling the section — this takes a moment on a local model.')));
    return;
  }

  if (!story) {
    setChildren(box, controls(), el('div', { class: 'story-empty' },
      el('h3', {}, 'Read it as a story'),
      el('p', {}, 'Pick a chapter and it gets retold as a Reddit post — same facts, same names and dates, told by someone who was there.'),
      el('p', { class: 'story-caveat' }, 'It is a way into the chapter, not a replacement for it. Every post says which pages it came from.')
    ));
    return;
  }

  const paragraphs = story.body.split(/\n{2,}/).filter((p) => p.trim());

  setChildren(box,
    controls(),
    el('article', { class: 'reddit-post' },
      el('div', { class: 'rp-head' },
        el('span', { class: 'rp-sub' }, story.sub.label),
        el('span', { class: 'rp-dot' }, '·'),
        el('span', { class: 'rp-meta' }, `posted from pages ${story.source.from}–${story.source.to}`)
      ),
      el('h2', { class: 'rp-title' }, story.title),
      el('div', { class: 'rp-body' }, ...paragraphs.map((p) => el('p', {}, p.trim()))),
      el('div', { class: 'rp-foot' },
        el('button', { class: 'rp-action', onclick: () => emit('story:read', story) },
          el('span', {}, '▸'), 'Read it aloud'),
        el('button', { class: 'rp-action', onclick: () => goToPage(story.source.from) },
          el('span', {}, '⤴'), `Go to page ${story.source.from}`),
        el('button', { class: 'rp-action', onclick: () => { navigator.clipboard.writeText(`${story.title}\n\n${story.body}`); toast('Copied'); } },
          el('span', {}, '⧉'), 'Copy'),
        el('button', { class: 'rp-action', onclick: () => emit('story:toDocument', story) },
          el('span', {}, '✎'), 'Send to document')
      )
    )
  );
}

export function initStory() {
  render();
  on('doc:loaded', () => { story = null; render(); });
  on('index:ready', () => { if (!story) render(); });
}

export const currentStory = () => story;
