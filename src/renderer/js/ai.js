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

    // The scan picker needs the same list, ranked its own way.
    const { setModels } = await import('./scan.js');
    setModels(info.models);
    const { setSettingsModels } = await import('./settings.js');
    setSettingsModels(info.models);
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

let passage = null;
const attachments = [];   // { name, text, ocr, busy }

function renderAttachments() {
  const box = $('#aiAttachments');
  box.hidden = !attachments.length;
  box.replaceChildren(...attachments.map((a, i) => el('span', { class: `ai-chip-file${a.busy ? ' busy' : ''}` },
    el('span', { class: 'acf-name' }, a.name),
    el('span', { class: 'acf-meta' },
      a.busy ? a.busy : `${(a.text || '').length.toLocaleString()} chars${a.ocr ? ' · OCR' : ''}`),
    el('button', {
      class: 'acf-x',
      title: 'Remove',
      onclick: () => { attachments.splice(i, 1); renderAttachments(); }
    }, '✕')
  )));
}

/** Pull the text out of an attached file, whatever it is. */
async function extractAttachment(filePath, chip) {
  const file = await window.api.questions.read(filePath);

  if (file.kind === 'text') return { text: file.text || '', ocr: false };

  if (file.kind === 'image') {
    chip.busy = 'recognizing…';
    renderAttachments();
    const lines = await window.api.ocr.buffer({ bytes: file.bytes, name: file.name });
    return { text: lines.map((l) => l.t).join('\n'), ocr: true };
  }

  // A PDF: native text where it exists, OCR where it doesn't.
  const pdfjs = await import('../../../vendor/pdfjs/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(file.bytes) }).promise;
  const maxPages = Math.min(doc.numPages, 20);
  const parts = [];
  let usedOcr = false;
  for (let n = 1; n <= maxPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('').trim();
    if (text.length < 30) {
      chip.busy = `recognizing page ${n} of ${maxPages}…`;
      renderAttachments();
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(4, (vp1.width > vp1.height ? 3200 : 2200) / vp1.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      canvas.width = canvas.height = 0;
      const lines = await window.api.ocr.buffer({ bytes: await blob.arrayBuffer(), name: 'page.png' });
      const { orderReading } = await import('./viewer.js');
      text = orderReading(lines, vp1.width > vp1.height * 1.15).map((l) => l.t).join('\n');
      usedOcr = true;
    }
    parts.push(text);
  }
  doc.destroy();
  let text = parts.join('\n\n');
  if (doc.numPages > maxPages) text += `\n[only the first ${maxPages} of ${doc.numPages} pages were read]`;
  return { text, ocr: usedOcr };
}

/** Attach files by path — used by the picker, drag-drop, and tests alike. */
export async function attachFiles(paths) {
  for (const filePath of paths) {
    if (attachments.length >= 3) {
      toast('Three attached files is the limit — remove one first.');
      break;
    }
    const name = filePath.split('/').pop();
    const chip = { name, text: '', ocr: false, busy: 'reading…' };
    attachments.push(chip);
    renderAttachments();
    try {
      const got = await extractAttachment(filePath, chip);
      chip.text = got.text;
      chip.ocr = got.ocr;
      chip.busy = null;
      if (!chip.text.trim()) {
        toast(`No readable text found in ${name}.`);
        attachments.splice(attachments.indexOf(chip), 1);
      }
    } catch (err) {
      toast(`Could not read ${name}: ${err.message || err}`);
      attachments.splice(attachments.indexOf(chip), 1);
    }
    renderAttachments();
  }
  emit('panel:right', 'ai');
}

export const currentAttachments = () =>
  attachments.filter((a) => !a.busy && a.text).map((a) => ({ name: a.name, text: a.text }));

/** Show the selected passage as pinned context above the composer. */
export function setPassage(text) {
  passage = text ? String(text).replace(/\s+/g, ' ').trim() : null;
  const box = $('#aiPassage');
  if (!box) return;
  box.hidden = !passage;
  if (passage) {
    $('#aiPassageText').textContent = passage.length > 220 ? `${passage.slice(0, 220)}…` : passage;
    $('#aiInput').placeholder = 'What do you want to know about it?';
  } else {
    $('#aiInput').placeholder = 'Ask about the PDF or your notes…';
  }
}

export async function ask(question) {
  let q = String(question || '').trim();
  if (!q && passage) return toast('Type what you want to know about the passage.');
  if (!q) return;
  if (attachments.some((a) => a.busy)) return toast('Still reading an attached file — a moment.');
  // A pinned passage rides along with whatever the reader actually asked.
  if (passage) {
    q = `About this passage from the document:\n"${passage.slice(0, 900)}"\n\nMy question: ${q}`;
  }
  if (!state.pdf) return toast('Open a PDF first.');
  if (state.aiRunning) return;
  if (!state.aiModel) {
    const info = await refreshAiStatus();
    if (!info.running || !state.aiModel) return;
  }

  const thread = $('#aiThread');
  const intro = thread.querySelector('.ai-intro');
  if (intro) intro.remove();

  const shown = passage ? String(question).trim() : q;
  const userMsg = el('div', { class: 'msg user' },
    el('div', { class: 'who' }, 'You'),
    passage ? el('div', { class: 'msg-passage' }, `“${passage.slice(0, 160)}${passage.length > 160 ? '…' : ''}”`) : null,
    el('div', { class: 'bubble' }, shown)
  );
  thread.append(userMsg);
  setPassage(null);

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
    currentPage: state.currentPage,
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

  // "Ask" from the text-selection popup. The passage becomes context shown
  // above the composer; sending it without a question of your own only ever
  // produced a generic summary nobody asked for.
  on('ai:askAbout', (text) => {
    emit('panel:right', 'ai');
    setPassage(text);
    setTimeout(() => $('#aiInput').focus(), 140);
  });

  $('#aiPassageClear').addEventListener('click', () => setPassage(null));

  $('#aiAttach').addEventListener('click', async () => {
    const paths = await window.api.pickAiFiles();
    if (paths.length) attachFiles(paths);
  });

  // Dropping a file on the AI panel attaches it.
  const panel = document.querySelector('.panel-view[data-view="ai"]');
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drop'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    panel.classList.remove('drop');
    const paths = [...(e.dataTransfer.files || [])]
      .map((f) => (window.api.pathForFile ? window.api.pathForFile(f) : null))
      .filter(Boolean);
    if (paths.length) attachFiles(paths);
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
