import { $, el, escapeHtml, renderMarkdown, toast, uid, setChildren } from './util.js';
import { state, emit, on } from './state.js';
import { profilePrompt, profile } from './profile.js';
import { goToPage, scrollToSpot } from './viewer.js';

/**
 * Question sheets.
 *
 * Drop in a worksheet, a study guide or a list of review questions and every
 * question gets answered against the same evidence the chat panel uses: the
 * PDF's pages, the reader's own highlights and notes, and — if the document has
 * been scanned — the section summaries. Each answer keeps its citations, so a
 * wrong one is traceable rather than mysterious.
 */

let sheet = null;          // { name, questions: [{ id, text, answer, evidence, state }] }
let running = false;
let cancelled = false;
let activeStream = null;

/* ------------------------------------------------------------ parsing */

/**
 * Pull questions out of free-form text. Handles numbered lists, lettered parts,
 * bullets and bare lines ending in a question mark, and stitches wrapped lines
 * back onto the question they belong to.
 */
export function parseQuestions(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const out = [];
  let current = null;

  const NUMBERED = /^\s*(?:\(?\d{1,3}[.)\]]|[a-hA-H][.)]|[ivxIVX]{1,4}[.)]|[-*•])\s+(.*)$/;
  const HEADING = /^\s*(?:name|date|class|period|directions?|instructions?|answer the following|part\s+[a-z0-9]+)\b.*$/i;
  // An unnumbered line is only a question if it asks or instructs. Without this
  // the worksheet's own title comes back as question one.
  const ASKS = /^(what|why|how|who|when|where|which|explain|describe|list|compare|contrast|identify|analys?e|analyze|discuss|define|evaluate|summari[sz]e|name|state|outline|assess|account for|to what extent|in what ways?)\b/i;

  const push = () => {
    if (!current) return;
    const text = current.replace(/\s+/g, ' ').trim();
    if (text.length > 8 && text.split(/\s+/).length >= 2) {
      out.push({ id: uid(), text, answer: '', evidence: null, state: 'pending' });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { push(); continue; }
    if (HEADING.test(trimmed) && !trimmed.includes('?')) { push(); continue; }

    const numbered = trimmed.match(NUMBERED);
    if (numbered) {
      push();
      current = numbered[1];
      continue;
    }

    // A question wrapped across lines continues in lower case; a new one starts
    // with a capital. That single signal separates the two reliably.
    const isContinuation = current
      && /^[a-z(]/.test(trimmed)
      && !/[.?!]$/.test(current.trim());

    if (isContinuation) {
      current += ` ${trimmed}`;
      continue;
    }

    push();
    if (trimmed.includes('?') || ASKS.test(trimmed)) current = trimmed;
  }
  push();
  return out;
}

/* ------------------------------------------------------------ loading */

async function loadFile() {
  const filePath = await window.api.questions.pick();
  if (!filePath) return;
  await ingest(filePath);
}

async function ingest(filePath) {
  try {
    const file = await window.api.questions.read(filePath);
    let text = file.text || '';

    if (file.kind === 'pdf') {
      const pdfjs = await import('../../../vendor/pdfjs/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(file.bytes) }).promise;
      const parts = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        parts.push(content.items.map((i) => (i.str || '') + (i.hasEOL ? '\n' : '')).join(''));
      }
      text = parts.join('\n');
      doc.destroy();
    }

    setSheet(file.name, text);
  } catch (err) {
    toast(`Could not read that file: ${err.message || err}`);
  }
}

function setSheet(name, text) {
  const questions = parseQuestions(text);
  if (!questions.length) {
    toast('No questions found in that file.');
    return;
  }
  sheet = { name, questions, raw: text };
  render();
  toast(`Found ${questions.length} question${questions.length === 1 ? '' : 's'}.`);
}

/* ------------------------------------------------------------ answering */

// One set of IPC listeners for the whole panel, keyed by stream id. Attaching
// them per question would leak a listener on every run.
const pendingAnswers = new Map();

function handleToken({ streamId, token }) {
  const entry = pendingAnswers.get(streamId);
  if (!entry) return;
  entry.q.answer += token;
  renderRow(entry.q);
}

function handleEvidence({ streamId, evidence }) {
  const entry = pendingAnswers.get(streamId);
  if (entry) entry.q.evidence = evidence;
}

function settle(streamId, finalText, outcome) {
  const entry = pendingAnswers.get(streamId);
  if (!entry) return;
  pendingAnswers.delete(streamId);
  if (finalText) entry.q.answer = finalText;
  entry.q.state = outcome;
  renderRow(entry.q);
  if (activeStream === streamId) activeStream = null;
  entry.resolve();
}

async function answerOne(q) {
  q.state = 'running';
  q.answer = '';
  q.evidence = null;
  renderRow(q);

  return new Promise((resolve) => {
    const streamId = uid();
    activeStream = streamId;
    pendingAnswers.set(streamId, { q, resolve });

    window.api.ai.ask({
      streamId,
      query: q.text,
      docId: state.docId,
      docName: state.docName,
      model: state.aiModel,
      currentPage: state.currentPage,
      // Dead zones are not notes, and must not become evidence.
      annotations: state.annotations
        .filter((a) => a.type !== 'deadzone')
        .map((a) => ({ id: a.id, page: a.page, type: a.type, note: a.note, quote: a.quote, tags: a.tags })),
      history: [],
      profile: profilePrompt(),
      readerName: profile.name || null
    });
  });
}

async function answerAll() {
  if (!sheet || running) return;
  if (!state.pdf) return toast('Open the PDF these questions are about first.');
  if (!state.aiModel) return toast('No local model available — check the AI tab.');

  running = true;
  cancelled = false;
  render();

  const pending = sheet.questions.filter((q) => q.state !== 'done');
  for (const q of pending) {
    if (cancelled) break;
    await answerOne(q);
    updateProgress();
  }

  running = false;
  render();
  if (!cancelled) toast('All questions answered.');
}

function stopAll() {
  cancelled = true;
  if (activeStream) window.api.ai.stop(activeStream);
  running = false;
  render();
}

/* ------------------------------------------------------------ rendering */

const answered = () => (sheet ? sheet.questions.filter((q) => q.state === 'done').length : 0);

function updateProgress() {
  const bar = $('#qsBar');
  const label = $('#qsProgress');
  if (!bar || !sheet) return;
  const pct = (answered() / sheet.questions.length) * 100;
  bar.style.width = `${pct}%`;
  label.textContent = `${answered()} of ${sheet.questions.length} answered`;
}

function render() {
  const box = $('#questionsView');
  if (!box) return;

  if (!sheet) {
    setChildren(box,
      el('div', { class: 'qs-empty' },
        el('div', { class: 'qs-mark', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5h8l4.5 4.5V20a.5.5 0 01-.5.5H6A.5.5 0 015.5 20V4a.5.5 0 01.5-.5z"/><path d="M14 3.5V8h4.5"/><path d="M9.4 12.2a2.1 2.1 0 113 1.9v1.1"/><circle cx="12.2" cy="17.4" r=".7" fill="currentColor"/></svg>' }),
        el('h3', {}, 'Answer a question sheet'),
        el('p', {}, 'Load a worksheet, study guide or list of review questions. Each one gets answered from this PDF and your own notes, with citations you can click.'),
        el('div', { class: 'qs-actions' },
          el('button', { class: 'big-btn primary', onclick: loadFile }, 'Choose a file'),
          el('button', { class: 'big-btn', onclick: pasteQuestions }, 'Paste instead')
        ),
        el('small', {}, 'Takes .txt, .md, .rtf, .doc, .docx and .pdf')
      ));
    return;
  }

  const head = el('div', { class: 'qs-head' },
    el('div', { class: 'qs-title' },
      el('b', {}, sheet.name),
      el('small', { id: 'qsProgress' }, `${answered()} of ${sheet.questions.length} answered`)
    ),
    el('div', { class: 'qs-bar' }, el('i', { id: 'qsBar' })),
    el('div', { class: 'qs-buttons' },
      running
        ? el('button', { onclick: stopAll }, 'Stop')
        : el('button', { class: 'primary', onclick: answerAll },
            answered() ? 'Answer the rest' : 'Answer all'),
      el('button', { onclick: exportAnswers }, 'Export'),
      el('button', { onclick: () => { sheet = null; render(); } }, 'Clear')
    )
  );

  const list = el('div', { class: 'qs-list', id: 'qsList' },
    ...sheet.questions.map((q) => questionRow(q)));

  setChildren(box, head, list);
  updateProgress();
}

function questionRow(q) {
  return el('div', { class: `qs-item ${q.state}`, 'data-id': q.id },
    el('div', { class: 'qs-q' },
      el('span', { class: 'qs-num' }, String(sheet.questions.indexOf(q) + 1)),
      el('span', { class: 'qs-text' }, q.text),
      el('button', {
        class: 'qs-redo',
        title: 'Answer this one',
        onclick: async () => {
          if (running) return toast('Already working through the sheet.');
          running = true;
          render();
          await answerOne(q);
          running = false;
          render();
        }
      }, q.state === 'done' ? '↻' : '▸')
    ),
    q.state === 'running' && !q.answer
      ? el('div', { class: 'qs-a thinking' }, el('i', { class: 'spin' }), 'searching the document and your notes…')
      : null,
    q.answer ? el('div', { class: 'qs-a', html: renderMarkdown(q.answer) }) : null,
    q.evidence && q.state === 'done' ? sourceLine(q.evidence) : null
  );
}

function sourceLine(evidence) {
  const pages = (evidence.pages || []).slice(0, 4);
  const notes = (evidence.notes || []).length;
  return el('div', { class: 'qs-src' },
    ...pages.map((p) => el('button', { class: 'cite', onclick: () => goToPage(p.page) }, `p.${p.page}`)),
    notes ? el('span', { class: 'qs-src-notes' }, `+ ${notes} of your notes`) : null
  );
}

function renderRow(q) {
  const existing = $(`#qsList .qs-item[data-id="${q.id}"]`);
  if (!existing) return;
  existing.replaceWith(questionRow(q));
}

/* ------------------------------------------------------------ paste + export */

function pasteQuestions() {
  const box = $('#questionsView');
  const area = el('textarea', {
    class: 'qs-paste',
    rows: '12',
    placeholder: 'Paste your questions here — one per line, numbered or not.'
  });
  setChildren(box,
    el('div', { class: 'qs-empty' },
      el('h3', {}, 'Paste your questions'),
      area,
      el('div', { class: 'qs-actions' },
        el('button', {
          class: 'big-btn primary',
          onclick: () => setSheet('Pasted questions', area.value)
        }, 'Use these'),
        el('button', { class: 'big-btn', onclick: render }, 'Back')
      )
    ));
  setTimeout(() => area.focus(), 40);
}

async function exportAnswers() {
  if (!sheet) return;
  const lines = [`# ${sheet.name}`, '', `_Answered from ${state.docName || 'the open PDF'} and your notes._`, ''];
  sheet.questions.forEach((q, i) => {
    lines.push(`## ${i + 1}. ${q.text}`, '');
    lines.push(q.answer ? q.answer : '_Not answered._', '');
    if (q.evidence && q.evidence.pages && q.evidence.pages.length) {
      lines.push(`*Sources: ${q.evidence.pages.map((p) => `p. ${p.page}`).join(', ')}*`, '');
    }
  });
  const saved = await window.api.exportNotes(`${sheet.name.replace(/\.[^.]+$/, '')} — answers.md`, lines.join('\n'));
  if (saved) toast(`Exported to ${saved.split('/').pop()}`);
}

/* ------------------------------------------------------------ wiring */

export function initQuestions() {
  render();

  window.api.ai.onToken(handleToken);
  window.api.ai.onEvidence(handleEvidence);
  window.api.ai.onDone(({ streamId, text, aborted }) => {
    settle(streamId, text, aborted ? 'pending' : 'done');
  });
  window.api.ai.onError(({ streamId, error }) => {
    const entry = pendingAnswers.get(streamId);
    if (entry) entry.q.answer = `**Could not answer:** ${error}`;
    settle(streamId, null, 'error');
  });

  // Dropping a file straight onto the panel is the fastest route in.
  const box = $('#questionsView');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.classList.remove('drop');
    const file = [...(e.dataTransfer.files || [])][0];
    if (!file) return;
    const path = window.api.pathForFile ? window.api.pathForFile(file) : null;
    if (path) ingest(path);
    else toast('Could not read that file — use "Choose a file" instead.');
  });

  on('doc:loaded', () => {
    // Answers belong to the document they were produced from.
    if (sheet) {
      for (const q of sheet.questions) { q.answer = ''; q.evidence = null; q.state = 'pending'; }
      render();
    }
  });
}
