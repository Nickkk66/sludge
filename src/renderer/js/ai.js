import { $, el, escapeHtml, renderMarkdown, uid, toast } from './util.js';
import { state, on, emit } from './state.js';
import { scrollToSpot, goToPage } from './viewer.js';
import { profile, profilePrompt } from './profile.js';

let activeStream = null;
let activeBubble = null;
let activeSources = null;

/* ---------------- status + model list ---------------- */

export async function refreshAiStatus({ autostart = true } = {}) {
  const status = $('#aiStatus');
  const select = $('#modelSelect');
  status.className = 'ai-status';
  status.innerHTML = '<i></i> checking local AI…';

  try {
    const info = await window.api.ai.status(autostart);
    if (!info.running) {
      status.className = 'ai-status bad';
      status.innerHTML = `<i></i> ${escapeHtml(info.error || 'Ollama is not running')}`;
      select.replaceChildren(el('option', {}, 'unavailable'));
      setFoot('The AI needs Ollama running locally. Install it from ollama.com, then reopen this tab.');
      return info;
    }

    if (!info.models.length) {
      status.className = 'ai-status bad';
      status.innerHTML = '<i></i> no models installed';
      select.replaceChildren(el('option', {}, 'no models'));
      setFoot('Ollama is running but has no models. Pull a small one, e.g. `ollama pull llama3.2:3b`.');
      return info;
    }

    const saved = state.settings.aiModel;
    const chosen = info.models.some((m) => m.name === saved) ? saved : info.suggested;
    state.aiModel = chosen;

    const ranked = [...info.models].sort((a, b) => (a.size || 0) - (b.size || 0));
    select.replaceChildren(...ranked.map((m) => el('option', {
      value: m.name,
      selected: m.name === chosen
    }, describeModel(m))));

    status.className = 'ai-status ok';
    status.innerHTML = '<i></i> ready · offline';
    setFoot('');
    // Load the model now so the first question doesn't pay the cold-start cost.
    warmModel(chosen);
    return info;
  } catch (err) {
    status.className = 'ai-status bad';
    status.innerHTML = `<i></i> ${escapeHtml(String(err.message || err))}`;
    return { running: false, models: [] };
  }
}

/**
 * Model names like "dolphin-phi:latest" say nothing about what to expect.
 * Label them by the trade-off that actually matters on this machine: how
 * sharp the answers are versus how long you wait.
 */
export function describeModel(m) {
  const b = paramBillions(m);
  let label;
  if (b === null) label = 'Local model';
  else if (b < 0.7) label = 'Quickest, roughest';
  else if (b < 2.5) label = 'Quick, simple answers';
  else if (b < 5) label = 'Balanced — recommended';
  else if (b < 10) label = 'Smartest, slow';
  else label = 'Smartest, very slow';
  const size = m.size ? `${(m.size / 1e9).toFixed(1)} GB` : '';
  return `${label} · ${m.name}${size ? ` (${size})` : ''}`;
}

function paramBillions(m) {
  const src = String(m.params || m.name || '');
  const g = src.match(/([\d.]+)\s*B\b/i);
  if (g) return parseFloat(g[1]);
  const mm = src.match(/([\d.]+)\s*M\b/i);
  if (mm) return parseFloat(mm[1]) / 1000;
  if (m.size) return m.size / 6e8;   // rough: q4 weights ≈ 0.6 GB per billion
  return null;
}

const setFoot = (text) => { $('#aiFoot').textContent = text || ''; };

let warmedModel = null;
function warmModel(model) {
  if (!model || warmedModel === model) return;
  warmedModel = model;
  window.api.ai.warm(model).catch(() => { warmedModel = null; });
}

/* ---------------- asking ---------------- */

export async function ask(question) {
  const q = String(question || '').trim();
  if (!q) return;
  if (!state.pdf) return toast('Open a PDF first.');
  if (state.aiRunning) return;
  if (!state.aiModel) {
    const info = await refreshAiStatus();
    if (!info.running || !state.aiModel) return;
  }

  const thread = $('#aiThread');
  const intro = thread.querySelector('.ai-intro');
  if (intro) intro.remove();

  thread.append(el('div', { class: 'msg user' },
    el('div', { class: 'who' }, 'You'),
    el('div', { class: 'bubble' }, q)
  ));

  const aiMsg = el('div', { class: 'msg ai' }, el('div', { class: 'who' }, state.aiModel));
  const thinking = el('div', { class: 'ai-thinking' }, el('i', { class: 'spin' }), 'searching the document and your notes…');
  const bubble = el('div', { class: 'bubble' });
  aiMsg.append(thinking, bubble);
  thread.append(aiMsg);
  thread.scrollTop = thread.scrollHeight;

  activeBubble = { bubble, thinking, raw: '', msg: aiMsg };
  activeSources = null;
  state.aiRunning = true;
  setSending(true);

  const streamId = uid();
  activeStream = streamId;

  if (!state.indexReady) setFoot('Still reading the document — answers improve once indexing finishes.');

  window.api.ai.ask({
    streamId,
    query: q,
    docId: state.docId,
    docName: state.docName,
    model: state.aiModel,
    annotations: state.annotations.map((a) => ({
      id: a.id, page: a.page, type: a.type, note: a.note, quote: a.quote, tags: a.tags, color: a.color
    })),
    history: state.aiHistory.slice(-4),
    profile: profilePrompt(),
    readerName: profile.name || null
  });

  state.aiHistory.push({ role: 'user', content: q });
}

function setSending(on) {
  const btn = $('#aiSend');
  btn.disabled = false;
  btn.title = on ? 'Stop' : 'Send (↵)';
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 12l16-7-7 16-2-6z"/></svg>';
}

function finishStream(text, { aborted = false } = {}) {
  state.aiRunning = false;
  activeStream = null;
  setSending(false);
  if (!activeBubble) return;
  activeBubble.thinking.remove();
  if (text) {
    activeBubble.bubble.innerHTML = renderMarkdown(text);
    state.aiHistory.push({ role: 'assistant', content: text });
  } else if (aborted) {
    activeBubble.bubble.innerHTML = renderMarkdown(activeBubble.raw || '_(stopped)_');
  }
  if (activeSources) activeBubble.msg.append(activeSources);
  activeBubble = null;
  activeSources = null;
}

function buildSources(evidence) {
  if (!evidence || (!evidence.pages.length && !evidence.notes.length)) return null;
  const details = el('details', { class: 'ai-sources' },
    el('summary', {}, `sources — ${evidence.pages.length} passage${evidence.pages.length === 1 ? '' : 's'}, ${evidence.notes.length} of your notes`)
  );
  for (const p of evidence.pages) {
    details.append(el('div', { class: 'src', onclick: () => goToPage(p.page) },
      el('span', { class: 'src-tag' }, `p.${p.page}`),
      el('span', { class: 'src-txt' }, p.excerpt.slice(0, 140))
    ));
  }
  for (const n of evidence.notes) {
    const anno = state.annotations.find((a) => a.id === n.id);
    details.append(el('div', {
      class: 'src',
      onclick: () => {
        if (anno) scrollToSpot(anno.page, anno.type === 'pin' ? anno.y : (anno.rects?.[0]?.y ?? 0));
        else goToPage(n.page);
      }
    },
      el('span', { class: 'src-tag note' }, `your note p.${n.page}`),
      el('span', { class: 'src-txt' }, (n.note || n.quote || '').slice(0, 140))
    ));
  }
  return details;
}

/* ---------------- wiring ---------------- */

export function initAi() {
  const input = $('#aiInput');
  const send = $('#aiSend');
  const thread = $('#aiThread');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = input.value;
      input.value = '';
      input.style.height = '';
      ask(v);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(130, input.scrollHeight)}px`;
  });

  send.addEventListener('click', () => {
    if (state.aiRunning) {
      window.api.ai.stop(activeStream);
      return;
    }
    const v = input.value;
    input.value = '';
    input.style.height = '';
    ask(v);
  });

  thread.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) return ask(chip.dataset.q);
    const cite = e.target.closest('.cite');
    if (cite) {
      const page = Number(cite.dataset.page);
      if (page) goToPage(page);
    }
  });

  $('#modelSelect').addEventListener('change', async (e) => {
    state.aiModel = e.target.value;
    state.settings = await window.api.settings.set({ aiModel: e.target.value });
    warmModel(e.target.value);
    toast(`AI model set to ${e.target.value}`);
  });

  window.api.ai.onToken(({ streamId, token }) => {
    if (streamId !== activeStream || !activeBubble) return;
    if (activeBubble.thinking.isConnected) activeBubble.thinking.remove();
    activeBubble.raw += token;
    activeBubble.bubble.innerHTML = renderMarkdown(activeBubble.raw);
    const t = $('#aiThread');
    if (t.scrollHeight - t.scrollTop - t.clientHeight < 120) t.scrollTop = t.scrollHeight;
  });

  window.api.ai.onEvidence(({ streamId, evidence }) => {
    if (streamId !== activeStream) return;
    activeSources = buildSources(evidence);
    if (activeBubble && activeBubble.thinking.isConnected) {
      activeBubble.thinking.lastChild.textContent =
        ` found ${evidence.pages.length} passage${evidence.pages.length === 1 ? '' : 's'}` +
        `${evidence.notes.length ? ` and ${evidence.notes.length} of your notes` : ''} — writing…`;
    }
  });

  window.api.ai.onDone(({ streamId, text, aborted }) => {
    if (streamId !== activeStream) return;
    finishStream(text, { aborted });
  });

  window.api.ai.onError(({ streamId, error }) => {
    if (streamId !== activeStream) return;
    if (activeBubble) {
      activeBubble.thinking.remove();
      activeBubble.bubble.innerHTML = renderMarkdown(`**Could not answer:** ${error}`);
    }
    state.aiRunning = false;
    activeStream = null;
    setSending(false);
    activeBubble = null;
  });

  // "Ask" from the text-selection popup.
  on('ai:askAbout', (text) => {
    emit('panel:right', 'ai');
    const q = `About this passage: "${text.slice(0, 400)}" — explain it and connect it to my notes.`;
    setTimeout(() => ask(q), 120);
  });
}

export function resetAiThread() {
  state.aiHistory = [];
  const thread = $('#aiThread');
  thread.replaceChildren(el('div', { class: 'ai-intro' },
    el('h3', {}, 'Ask about this document'),
    el('p', { html: 'I search the pages <em>and</em> your own highlights and notes, then answer with citations. I\'ll always tell you when something came from your notes.' }),
    el('div', { class: 'ai-chips' },
      el('button', { class: 'chip', 'data-q': 'Summarize this chapter in five bullet points.' }, 'Summarize this chapter'),
      el('button', { class: 'chip', 'data-q': 'What do my notes say about this topic?' }, 'What do my notes say?'),
      el('button', { class: 'chip', 'data-q': 'Make five exam questions from this section.' }, 'Make exam questions')
    )
  ));
}
