'use strict';
const { spawn } = require('child_process');

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

// Small-and-fast first: this app targets an 8 GB Mac where an 8B model has to
// share memory with Electron and a rendered 800-page PDF.
const PREFERRED = [
  /^qwen2\.5:3b/, /^llama3\.2:3b/, /^phi3(\.5)?:/, /^dolphin-phi/, /^gemma3:1b/,
  /^llama3\.2/, /^qwen2\.5:1\.5b/, /^gemma2:2b/, /^llama3\.1:8b/, /^llama3:/
];

let serveProc = null;

async function api(path, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // A caller's own signal (a cancelled scan) aborts the request too.
  const external = opts.signal;
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(`${HOST}${path}`, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function listModels() {
  const res = await api('/api/tags');
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    params: (m.details && m.details.parameter_size) || ''
  }));
}

function pickDefault(models) {
  const names = models.map((m) => m.name);
  for (const rx of PREFERRED) {
    const hit = names.find((n) => rx.test(n));
    if (hit) return hit;
  }
  // Otherwise take the smallest installed model — speed beats depth here.
  const sorted = [...models].sort((a, b) => a.size - b.size);
  return sorted.length ? sorted[0].name : null;
}

/** Try to bring up a local server the user already has installed. */
function startServer() {
  if (serveProc && !serveProc.killed) return;
  try {
    serveProc = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    serveProc.unref();
  } catch {
    serveProc = null;
  }
}

async function status({ autostart = true } = {}) {
  try {
    const models = await listModels();
    return { running: true, models, suggested: pickDefault(models) };
  } catch (err) {
    if (!autostart) return { running: false, models: [], error: describe(err) };
    startServer();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 600));
      try {
        const models = await listModels();
        return { running: true, models, suggested: pickDefault(models), started: true };
      } catch { /* keep waiting */ }
    }
    return { running: false, models: [], error: describe(err) };
  }
}

function describe(err) {
  const msg = String((err && err.message) || err);
  if (/abort/i.test(msg)) return 'Ollama did not respond in time.';
  if (/ECONNREFUSED|fetch failed/i.test(msg)) return 'Ollama is not running.';
  return msg;
}

const SYSTEM_PROMPT = `You are a study assistant reading ONE document with the reader.

You are given two kinds of evidence:
  • BOOK excerpts — text from the PDF itself, each labelled with its page.
  • NOTE entries — the reader's OWN highlights and notes, each labelled with its page.

Rules:
1. Answer ONLY from the evidence provided. If the evidence does not contain the
   answer, say so plainly and name what you'd need. Never invent page numbers,
   dates, names, or quotes.
2. Cite the book as [p. 42] right after the claim it supports.
3. SECTION OVERVIEWS are summaries of whole sections, useful for the shape of a
   topic. When the reader says "this chapter" or "this section", they mean the
   one marked as the section they are currently on. Prefer BOOK EXCERPTS for any
   specific fact, quote, date or name — the overviews are compressed and must
   never be quoted as if they were the text.
4. When you use the reader's own material, say so explicitly in the sentence —
   "your note on p. 42 says …" or "you highlighted …" — and cite it [note, p. 42].
   Never blur the reader's notes together with the book's text.
5. Be direct and brief. Lead with the answer, then support it. Short paragraphs
   or tight bullets. No preamble, no restating the question.`;

function buildPrompt({ query, evidence, docName }) {
  const parts = [];
  parts.push(`Document: ${docName || 'this PDF'}`);

  if (evidence.overview && evidence.overview.length) {
    parts.push('\n=== SECTION OVERVIEWS (from a full scan of this document) ===');
    for (const o of evidence.overview) {
      const where = o.chapter ? `${o.chapter}, pp. ${o.from}-${o.to}` : `pp. ${o.from}-${o.to}`;
      const mark = o.current ? ' — THE SECTION THE READER IS CURRENTLY ON' : '';
      parts.push(`[${where}${mark}] ${o.summary}`);
    }
  }

  if (evidence.pages.length) {
    parts.push('\n=== BOOK EXCERPTS ===');
    for (const p of evidence.pages) parts.push(`[p. ${p.page}] ${p.excerpt}`);
  } else {
    parts.push('\n=== BOOK EXCERPTS ===\n(no matching passages found)');
  }

  if (evidence.notes.length) {
    parts.push("\n=== THE READER'S OWN NOTES & HIGHLIGHTS ===");
    for (const n of evidence.notes) {
      const bits = [`[note, p. ${n.page}]`];
      if (n.quote) bits.push(`highlighted text: "${n.quote}"`);
      if (n.note) bits.push(`reader wrote: "${n.note}"`);
      if (n.tags && n.tags.length) bits.push(`tags: ${n.tags.map((t) => `#${t}`).join(' ')}`);
      parts.push(bits.join(' — '));
    }
  } else {
    parts.push("\n=== THE READER'S OWN NOTES & HIGHLIGHTS ===\n(none relevant to this question)");
  }

  parts.push(`\n=== QUESTION ===\n${query}`);
  return parts.join('\n');
}

/**
 * Stream a grounded answer. onToken receives text deltas; resolves with the
 * full answer. Abort by calling the returned controller's abort().
 */
function chat({ model, query, evidence, docName, history = [], profile = null }, onToken) {
  const ctrl = new AbortController();
  const system = profile ? `${SYSTEM_PROMPT}\n\nAbout this reader: ${profile}` : SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: system },
    ...history.slice(-6),
    { role: 'user', content: buildPrompt({ query, evidence, docName }) }
  ];

  const done = (async () => {
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: '30m',
        options: { temperature: 0.2, num_predict: 700, num_ctx: 4096 }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { done: fin, value } = await reader.read();
      if (fin) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const piece = msg.message && msg.message.content;
        if (piece) {
          full += piece;
          onToken(piece);
        }
      }
    }
    return full;
  })();

  return { promise: done, controller: ctrl };
}

/**
 * One-shot text transformation for the note document. Unlike `chat` this has
 * no document evidence attached — it only ever sees the text handed to it.
 */
async function rewrite({ model, instruction, text, profile = null, signal = null }) {
  const res = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: '30m',
      messages: [
        {
          role: 'system',
          content: 'You edit the user\'s own writing. Follow the instruction exactly and return ONLY the resulting text — ' +
                   'no preamble, no explanation, no surrounding quotes, no code fences. Preserve Markdown formatting.' +
                   (profile ? `\n\nAbout this writer: ${profile}` : '')
        },
        { role: 'user', content: `${instruction}\n\n---\n${text}` }
      ],
      options: { temperature: 0.3, num_ctx: 4096 }
    }),
    signal
  }, 180000);
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const data = await res.json();
  let out = (data.message && data.message.content) || '';
  // Small models like to wrap answers in a fence even when told not to.
  out = out.replace(/^\s*```[a-z]*\n([\s\S]*?)\n?```\s*$/i, '$1');
  return out.trim();
}

/**
 * A single summarisation turn for the document scan. Separate from `rewrite`
 * because it needs its own system prompt and a tight output budget.
 */
async function summarise({ model, system, prompt, signal = null }) {
  const res = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: '25m',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 260 }
    }),
    signal
  }, 240000);
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const data = await res.json();
  return ((data.message && data.message.content) || '').trim();
}

/**
 * Load a model into memory ahead of the first question. Cold-loading a 3B model
 * costs ~20 s; doing it while the reader is still typing hides all of that.
 */
async function warm(model) {
  if (!model) return false;
  try {
    const res = await api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '30m' })
    }, 120000);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { status, listModels, pickDefault, chat, rewrite, summarise, warm, startServer, SYSTEM_PROMPT, buildPrompt };
