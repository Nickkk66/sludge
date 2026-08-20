'use strict';
/**
 * The detached caption window.
 *
 * A plain page driven entirely by messages from the main window, so it can sit
 * over another app while you take notes elsewhere. It holds no state of its own
 * beyond text size.
 */

const line = document.getElementById('line');
const meta = document.getElementById('meta');
const left = document.getElementById('left');
const bar = document.querySelector('#progress i');
const playPause = document.getElementById('playPause');

const SIZES = [16, 20, 26, 32, 40, 50];
let sizeIndex = 2;

const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M8 5.5h3v13H8zM13 5.5h3v13h-3z"/></svg>';

function renderSentence(text) {
  const parts = [];
  const re = /\S+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement('span');
    span.className = 'w';
    span.dataset.at = String(m.index);
    span.dataset.end = String(m.index + m[0].length);
    span.textContent = m[0];
    parts.push(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
  line.replaceChildren(...parts);
}

function markWord(start, end) {
  for (const w of line.querySelectorAll('.w')) {
    const at = Number(w.dataset.at);
    const to = Number(w.dataset.end);
    w.classList.toggle('now', at < end && to > start);
    w.classList.toggle('said', to <= start);
  }
}

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

window.popout.onUpdate((msg) => {
  if (msg.kind === 'sentence') {
    renderSentence(msg.text);
    meta.textContent = `p. ${msg.page} · ${msg.index + 1}/${msg.total}`;
    bar.style.width = `${msg.total ? (msg.index / msg.total) * 100 : 0}%`;
    left.textContent = `${clock(msg.remainingMs)} left`;
  } else if (msg.kind === 'word') {
    markWord(msg.wordStart, msg.wordEnd);
    left.textContent = `${clock(msg.remainingMs)} left`;
  } else if (msg.kind === 'state') {
    playPause.innerHTML = msg.playing ? PAUSE : PLAY;
    if (!msg.playing && !msg.paused) {
      line.replaceChildren(Object.assign(document.createElement('span'), {
        id: 'idle',
        textContent: 'Nothing is being read right now.'
      }));
      meta.textContent = '';
      left.textContent = '';
      bar.style.width = '0';
    }
  }
});

const applySize = () => {
  document.documentElement.style.setProperty('--size', `${SIZES[sizeIndex]}px`);
};

document.getElementById('bigger').addEventListener('click', () => {
  sizeIndex = Math.min(SIZES.length - 1, sizeIndex + 1);
  applySize();
});
document.getElementById('smaller').addEventListener('click', () => {
  sizeIndex = Math.max(0, sizeIndex - 1);
  applySize();
});
playPause.addEventListener('click', () => window.popout.command('toggle'));
document.getElementById('dock').addEventListener('click', () => window.popout.command('dock'));

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); window.popout.command('toggle'); }
  if (e.key === 'Escape') window.popout.command('dock');
});
