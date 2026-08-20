import { $, el, toast } from './util.js';
import { state, emit, on, deadZonesOnPage } from './state.js';
import { getPageEl, renderPage, goToPage, refreshAnnotations, viewerEl } from './viewer.js';
import { flattenTextLayer, rectsFor, splitSentences } from './textmap.js';
import { pickVoices, needsBetterVoices, allEnglish } from './voices.js';

/**
 * Read-aloud.
 *
 * Speaks the page you're on through the system's offline voices, highlighting
 * the sentence it's in and the word it's saying, and turning the page for you.
 * Pausing releases the page so you can highlight and annotate mid-listen.
 */

const synth = window.speechSynthesis;

let voices = [];        // the four curated choices
let rawVoices = [];     // everything the system offers
let spokenWords = 0;    // for measuring the reader's actual pace
let pageStartedAt = 0;
let mapped = null;        // flattened text layer for the page being read
let sentences = [];       // sentences of that page, with offsets
let index = 0;            // sentence being spoken
let utterance = null;
let readingPage = 0;
let stopping = false;
// Where the voice is inside the current sentence, so a repaint can restore it.
let wordAt = [0, 0];

export const speech = {
  playing: false,
  paused: false,
  rate: 1,
  voiceURI: null,
  followScroll: true
};

/* ------------------------------------------------------------ voices */

function loadVoices() {
  const all = (synth.getVoices() || []).filter((v) => v.localService !== false);
  rawVoices = all.length ? all : (synth.getVoices() || []);
  voices = pickVoices(rawVoices);
  return voices;
}

/** The four curated choices: US/UK × male/female. */
export function getVoices() {
  if (!voices.length) loadVoices();
  return voices;
}

/**
 * Force a fresh read of the system voice list. Needed after the reader
 * downloads new voices — the cached list would otherwise report the old set.
 */
export function refreshVoices() {
  loadVoices();
  emit('speech:voices');
  return voices;
}

/** Every usable English voice, for readers who want the full list. */
export function getAllVoices() {
  if (!rawVoices.length) loadVoices();
  return allEnglish(rawVoices);
}

/** True when the Mac only has the old robotic voices installed. */
export function voicesAreBasic() {
  if (!voices.length) loadVoices();
  return needsBetterVoices(voices);
}

function pickVoice() {
  const all = getAllVoices();
  const saved = all.find((v) => v.voiceURI === speech.voiceURI);
  if (saved) return saved;
  const curated = getVoices();
  // Default to the best-quality curated voice available.
  const best = [...curated].sort((a, b) => b.tier.rank - a.tier.rank)[0];
  return best ? best.voice : (all[0] || null);
}

/* ------------------------------------------------------------ page prep */

/**
 * A text node is skipped when its middle falls inside a dead zone — the reader
 * has said that region is a figure or a caption, not something to read out.
 */
function makeSkipper(pageEl, pageNum) {
  const zones = deadZonesOnPage(pageNum);
  if (!zones.length) return null;
  const pb = pageEl.getBoundingClientRect();
  if (!pb.width || !pb.height) return null;

  return (node) => {
    const host = node.parentElement;
    if (!host) return false;
    const r = host.getBoundingClientRect();
    const cx = (r.left + r.width / 2 - pb.left) / pb.width;
    const cy = (r.top + r.height / 2 - pb.top) / pb.height;
    return zones.some((z) => cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h);
  };
}

async function preparePage(pageNum) {
  await renderPage(pageNum);
  // The text layer needs a frame before ranges measure correctly.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
  const pageEl = getPageEl(pageNum);
  const layer = pageEl && pageEl.querySelector('.textLayer');
  if (!layer) return false;
  mapped = flattenTextLayer(layer, { skip: makeSkipper(pageEl, pageNum) });
  if (!mapped || !mapped.flat.trim()) return false;
  sentences = splitSentences(mapped.flat);
  readingPage = pageNum;
  return sentences.length > 0;
}

/* ------------------------------------------------------------ highlighting */

/**
 * The page can re-render underneath us (scrolling back into view, a zoom), which
 * detaches the text nodes our offsets point at. Re-flatten when that happens —
 * the text is identical, so the sentence offsets stay valid.
 */
function ensureMapping() {
  if (mapped && mapped.nodes.length && mapped.nodes[0].isConnected) return true;
  const pageEl = getPageEl(readingPage);
  const layer = pageEl && pageEl.querySelector('.textLayer');
  if (!pageEl) return false;
  if (!layer) return false;
  const fresh = flattenTextLayer(layer, { skip: makeSkipper(pageEl, readingPage) });
  if (!fresh) return false;
  mapped = fresh;
  return true;
}

function paintReading(sentence, wordStart = wordAt[0], wordEnd = wordAt[1]) {
  wordAt = [wordStart, wordEnd];
  const pageEl = getPageEl(readingPage);
  if (!pageEl) return;
  const layer = pageEl.querySelector('.annoLayer');
  if (!layer) return;
  if (!ensureMapping()) return;

  layer.querySelectorAll('.speak-sentence, .speak-word').forEach((n) => n.remove());
  if (!sentence) return;

  for (const r of rectsFor(pageEl, mapped, sentence.start, sentence.end)) {
    layer.append(el('div', {
      class: 'speak-sentence',
      style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }
    }));
  }

  if (wordEnd > wordStart) {
    for (const r of rectsFor(pageEl, mapped, wordStart, wordEnd)) {
      layer.append(el('div', {
        class: 'speak-word',
        style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }
      }));
    }
  }
}

export function clearReadingHighlight() {
  wordAt = [0, 0];
  document.querySelectorAll('.speak-sentence, .speak-word').forEach((n) => n.remove());
}

function keepInView(sentence) {
  if (!speech.followScroll || !sentence) return;
  const pageEl = getPageEl(readingPage);
  if (!pageEl || !ensureMapping()) return;
  const rects = rectsFor(pageEl, mapped, sentence.start, sentence.end);
  if (!rects.length) return;
  const wrap = viewerEl();
  const top = pageEl.offsetTop + pageEl.offsetHeight * rects[0].y;
  const seen = top > wrap.scrollTop + 80 && top < wrap.scrollTop + wrap.clientHeight - 140;
  if (!seen) wrap.scrollTo({ top: Math.max(0, top - wrap.clientHeight * 0.35), behavior: 'smooth' });
}

/* ------------------------------------------------------------ transport */

function speakCurrent() {
  const sentence = sentences[index];
  if (!sentence) return advancePage();

  utterance = new SpeechSynthesisUtterance(sentence.text);
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = speech.rate;

  wordAt = [0, 0];
  paintReading(sentence, 0, 0);
  keepInView(sentence);
  emit('speech:sentence', {
    text: sentence.text,
    index,
    total: sentences.length,
    page: readingPage,
    remainingMs: estimateRemaining(sentence, 0)
  });
  // The scroll above can trigger a re-render; repaint once it has settled,
  // keeping whatever word the voice has reached by then.
  requestAnimationFrame(() => setTimeout(() => {
    if (speech.playing && sentences[index] === sentence) paintReading(sentence);
  }, 120));

  utterance.onboundary = (e) => {
    if (e.name && e.name !== 'word') return;
    const local = e.charIndex || 0;
    const len = e.charLength || wordLengthAt(sentence.text, local);
    const at = sentence.start + local;
    paintReading(sentence, at, at + len);
    emit('speech:word', {
      text: sentence.text,
      wordStart: local,
      wordEnd: local + len,
      remainingMs: estimateRemaining(sentence, local)
    });
  };

  utterance.onend = () => {
    if (stopping) return;
    spokenWords += countWords(sentence.text);
    index += 1;
    if (index < sentences.length) speakCurrent();
    else advancePage();
  };

  utterance.onerror = (e) => {
    // "interrupted" is what cancel() produces; it isn't a failure.
    if (stopping || (e.error && /interrupted|canceled|cancelled/i.test(e.error))) return;
    toast(`Read aloud stopped: ${e.error || 'speech error'}`);
    stop();
  };

  synth.speak(utterance);
}

function wordLengthAt(text, at) {
  const m = /^\S+/.exec(text.slice(at));
  return m ? m[0].length : 1;
}

const countWords = (t) => (String(t).match(/\S+/g) || []).length;

/**
 * Time left on this page. Starts from a nominal speaking rate and switches to
 * the reader's measured pace once there's enough of it to trust.
 */
function estimateRemaining(sentence, localChar) {
  let words = countWords(sentence.text.slice(localChar));
  for (let i = index + 1; i < sentences.length; i++) words += countWords(sentences[i].text);

  const elapsed = pageStartedAt ? Date.now() - pageStartedAt : 0;
  const measured = spokenWords > 25 && elapsed > 4000 ? (spokenWords / (elapsed / 60000)) : null;
  const wpm = measured || 165 * speech.rate;
  return Math.round((words / Math.max(40, wpm)) * 60000);
}

async function advancePage() {
  clearReadingHighlight();
  const next = readingPage + 1;
  if (next > state.numPages) {
    toast('Reached the end of the document.');
    stop();
    return;
  }
  goToPage(next, { smooth: true });
  const ok = await preparePage(next);
  if (!speech.playing) return;
  index = 0;
  spokenWords = 0;
  pageStartedAt = Date.now();
  if (ok) speakCurrent();
  else advancePage();   // blank or image-only page
}

export async function play(fromPage) {
  if (!state.pdf) return toast('Open a PDF first.');
  if (speech.paused && synth.paused) {
    synth.resume();
    speech.paused = false;
    speech.playing = true;
    emit('speech:changed');
    return;
  }

  stopping = true;
  synth.cancel();
  stopping = false;

  const page = fromPage || state.currentPage;
  const ok = await preparePage(page);
  if (!ok) {
    toast(`No readable text on page ${page}.`);
    return;
  }
  index = 0;
  spokenWords = 0;
  pageStartedAt = Date.now();
  speech.playing = true;
  speech.paused = false;
  emit('speech:changed');
  speakCurrent();
}

export function pause() {
  if (!speech.playing) return;
  synth.pause();
  speech.paused = true;
  speech.playing = false;
  emit('speech:changed');
}

export function stop() {
  stopping = true;
  synth.cancel();
  stopping = false;
  speech.playing = false;
  speech.paused = false;
  utterance = null;
  clearReadingHighlight();
  emit('speech:changed');
}

export function toggle() {
  if (speech.playing) pause();
  else play();
}

export function skip(delta) {
  if (!sentences.length) return;
  const next = index + delta;
  if (next < 0 || next >= sentences.length) {
    if (delta > 0) return advancePage();
    return;
  }
  index = next;
  stopping = true;
  synth.cancel();
  stopping = false;
  if (speech.playing) speakCurrent();
  else paintReading(sentences[index], 0, 0);
}

export function setRate(rate) {
  speech.rate = Math.max(0.5, Math.min(3, Number(rate) || 1));
  window.api.settings.set({ speechRate: speech.rate }).catch(() => {});
  // Rate only applies to a new utterance, so restart the current sentence.
  if (speech.playing) {
    stopping = true;
    synth.cancel();
    stopping = false;
    speakCurrent();
  }
  emit('speech:changed');
}

export function setVoice(uri) {
  speech.voiceURI = uri;
  window.api.settings.set({ speechVoice: uri }).catch(() => {});
  if (speech.playing) {
    stopping = true;
    synth.cancel();
    stopping = false;
    speakCurrent();
  }
}

export function initSpeech() {
  loadVoices();
  if (typeof synth.onvoiceschanged !== 'undefined') {
    synth.onvoiceschanged = () => { loadVoices(); emit('speech:voices'); };
  }
  // The speech engine populates its voice list asynchronously and doesn't
  // always fire onvoiceschanged, so poll briefly until it fills.
  let tries = 0;
  const poll = setInterval(() => {
    tries += 1;
    loadVoices();
    if (voices.length) {
      emit('speech:voices');
      clearInterval(poll);
    } else if (tries > 20) {
      clearInterval(poll);
    }
  }, 250);
  speech.rate = state.settings.speechRate || 1;
  speech.voiceURI = state.settings.speechVoice || null;

  // Re-rendering a page (zoom, scroll back) wipes the overlay we drew on it.
  // A re-rendered page loses the overlay and invalidates the mapping.
  on('page:rendered', (page) => {
    if (page !== readingPage || !sentences[index]) return;
    if (!speech.playing && !speech.paused) return;
    mapped = null;
    paintReading(sentences[index]);
  });

  // Never leave the synthesiser talking after the window goes away.
  window.addEventListener('beforeunload', () => synth.cancel());
}

export const readingState = () => ({
  page: readingPage,
  sentence: index,
  total: sentences.length,
  text: sentences[index] ? sentences[index].text : ''
});
