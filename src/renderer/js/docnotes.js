import { $, el, escapeHtml, renderMarkdown, debounce, toast, uid } from './util.js';
import { state, emit, on } from './state.js';

/**
 * The long-form note document — a Markdown editor that lives beside the PDF.
 *
 * Deliberately a plain textarea rather than a rich-text surface: Markdown stays
 * the source of truth, so what you write is exactly what lands in the sidecar
 * file and in an export. The Notion-ish parts are the slash menu, the shortcuts
 * and the AI rewrites, not a hidden document model.
 */

let editor = null;
let dirty = false;
let previewOn = false;
let slashMenu = null;

/* ------------------------------------------------------------ blocks */

const BLOCKS = [
  { key: 'h1',     label: 'Heading 1',   hint: 'Big section title', apply: (l) => `# ${l}` },
  { key: 'h2',     label: 'Heading 2',   hint: 'Sub-section',       apply: (l) => `## ${l}` },
  { key: 'h3',     label: 'Heading 3',   hint: 'Minor heading',     apply: (l) => `### ${l}` },
  { key: 'bullet', label: 'Bulleted list', hint: 'A simple list',   apply: (l) => `- ${l}` },
  { key: 'number', label: 'Numbered list', hint: 'Ordered steps',   apply: (l) => `1. ${l}` },
  { key: 'todo',   label: 'To-do',       hint: 'Checkbox item',     apply: (l) => `- [ ] ${l}` },
  { key: 'quote',  label: 'Quote',       hint: 'Callout or excerpt',apply: (l) => `> ${l}` },
  { key: 'code',   label: 'Code block',  hint: 'Monospaced',        apply: (l) => `\`\`\`\n${l}\n\`\`\`` },
  { key: 'rule',   label: 'Divider',     hint: 'Horizontal line',   apply: () => '---' },
  { key: 'table',  label: 'Table',       hint: 'Two-column table',  apply: () => '| | |\n|---|---|\n| | |' }
];

const INLINE = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  codeSpan: ['`', '`']
};

/* ------------------------------------------------------------ editing */

function lineBounds(value, pos) {
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  let end = value.indexOf('\n', pos);
  if (end < 0) end = value.length;
  return { start, end };
}

function replaceRange(start, end, text, caret) {
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  editor.value = before + text + after;
  const at = caret === undefined ? start + text.length : caret;
  editor.setSelectionRange(at, at);
  editor.focus();
  onInput();
}

export function applyBlock(key) {
  const block = BLOCKS.find((b) => b.key === key);
  if (!block) return applyInline(key);
  const { selectionStart } = editor;
  const { start, end } = lineBounds(editor.value, selectionStart);
  const line = editor.value.slice(start, end).replace(/^(#{1,6}\s+|[-*]\s+\[.\]\s+|[-*]\s+|\d+[.)]\s+|>\s+)/, '');
  replaceRange(start, end, block.apply(line));
}

export function applyInline(kind) {
  const pair = INLINE[kind] || INLINE[kind === 'code' ? 'codeSpan' : ''];
  if (!pair) return;
  const { selectionStart: a, selectionEnd: b } = editor;
  const selected = editor.value.slice(a, b);
  if (!selected) {
    replaceRange(a, b, pair[0] + pair[1], a + pair[0].length);
    return;
  }
  // Toggle off if the selection is already wrapped.
  if (selected.startsWith(pair[0]) && selected.endsWith(pair[1])) {
    const inner = selected.slice(pair[0].length, selected.length - pair[1].length);
    replaceRange(a, b, inner, a + inner.length);
    return;
  }
  replaceRange(a, b, pair[0] + selected + pair[1], b + pair[0].length + pair[1].length);
}

/** Enter continues the list you're in, and clears an empty bullet. */
function handleEnter(e) {
  const { selectionStart } = editor;
  const { start, end } = lineBounds(editor.value, selectionStart);
  const line = editor.value.slice(start, end);
  const m = line.match(/^(\s*)([-*]\s\[[ xX]\]\s|[-*]\s|(\d+)[.)]\s)/);
  if (!m) return;

  const rest = line.slice(m[0].length);
  if (!rest.trim()) {
    // Empty list item: pressing Enter again should exit the list.
    e.preventDefault();
    replaceRange(start, end, '');
    return;
  }
  e.preventDefault();
  let marker = m[2];
  if (m[3]) marker = `${Number(m[3]) + 1}. `;
  else if (/\[[xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, '[ ]');
  replaceRange(selectionStart, selectionStart, `\n${m[1]}${marker}`);
}

/* ------------------------------------------------------------ slash menu */

function openSlashMenu() {
  closeSlashMenu();
  const rect = caretRect();
  slashMenu = el('div', { class: 'slash-menu' },
    ...BLOCKS.map((b, i) => el('button', {
      class: `slash-item${i === 0 ? ' on' : ''}`,
      'data-key': b.key,
      onclick: () => chooseSlash(b.key)
    },
      el('b', {}, b.label),
      el('small', {}, b.hint)
    ))
  );
  document.body.append(slashMenu);
  const h = slashMenu.offsetHeight;
  slashMenu.style.left = `${Math.min(window.innerWidth - 250, rect.left)}px`;
  slashMenu.style.top = `${rect.top > h + 20 ? rect.top - h - 6 : rect.bottom + 6}px`;
}

function closeSlashMenu() {
  if (slashMenu) slashMenu.remove();
  slashMenu = null;
}

function moveSlash(delta) {
  const items = [...slashMenu.querySelectorAll('.slash-item')];
  const at = items.findIndex((n) => n.classList.contains('on'));
  const next = (at + delta + items.length) % items.length;
  items.forEach((n, i) => n.classList.toggle('on', i === next));
  items[next].scrollIntoView({ block: 'nearest' });
}

function chooseSlash(key) {
  // Drop the "/" that opened the menu before inserting the block.
  const pos = editor.selectionStart;
  const at = editor.value.lastIndexOf('/', pos - 1);
  if (at >= 0) replaceRange(at, pos, '');
  closeSlashMenu();
  applyBlock(key);
}

/** Approximate on-screen position of the caret, for menu placement. */
function caretRect() {
  const box = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const mirror = el('div', { class: 'caret-mirror' });
  mirror.style.cssText = `position:fixed;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;
    width:${editor.clientWidth}px;font:${style.font};line-height:${style.lineHeight};padding:${style.padding};`;
  mirror.textContent = editor.value.slice(0, editor.selectionStart);
  const marker = el('span', {}, '​');
  mirror.append(marker);
  document.body.append(mirror);
  const m = marker.getBoundingClientRect();
  const top = box.top + (m.top - mirror.getBoundingClientRect().top) - editor.scrollTop;
  const left = box.left + (m.left - mirror.getBoundingClientRect().left);
  mirror.remove();
  return { top, bottom: top + 20, left };
}

/* ------------------------------------------------------------ AI actions */

const AI_ACTIONS = [
  { key: 'improve',  label: 'Improve writing',   prompt: 'Rewrite the text so it reads clearly and naturally. Keep the meaning, the facts and roughly the length. Return only the rewritten text.' },
  { key: 'grammar',  label: 'Fix spelling & grammar', prompt: 'Correct spelling, grammar and punctuation. Change nothing else. Return only the corrected text.' },
  { key: 'shorter',  label: 'Make it shorter',   prompt: 'Tighten this to about half the length while keeping every fact. Return only the shortened text.' },
  { key: 'bullets',  label: 'Turn into bullets', prompt: 'Rewrite this as a tight bulleted list, one idea per bullet. Return only the list.' },
  { key: 'expand',   label: 'Explain further',   prompt: 'Expand this with the reasoning left implicit, staying accurate to what is written. Return only the expanded text.' },
  { key: 'study',    label: 'Make study questions', prompt: 'Write five short exam-style questions that test this material, with a one-line answer each. Return only the questions and answers.' }
];

function openAiMenu(anchor) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const scope = sel.trim() ? 'selection' : 'whole document';
  const menu = el('div', { class: 'ctx-menu' },
    el('div', { class: 'ctx-head' }, `Apply to ${scope}`),
    ...AI_ACTIONS.map((a) => el('button', {
      class: 'ctx-item',
      onclick: () => { menu.remove(); runAiAction(a); }
    }, el('span', { class: 'ctx-check' }, ''), a.label))
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6)}px`;
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close);
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

async function runAiAction(action) {
  if (!state.aiModel) {
    toast('No local AI model available — check the AI tab.');
    return;
  }
  const a = editor.selectionStart;
  const b = editor.selectionEnd;
  const hasSel = editor.value.slice(a, b).trim().length > 0;
  const target = hasSel ? editor.value.slice(a, b) : editor.value;
  if (!target.trim()) return toast('Nothing to work on yet.');

  setDocStatus(`${action.label}…`, true);
  try {
    const result = await window.api.ai.rewrite({
      model: state.aiModel,
      instruction: action.prompt,
      text: target
    });
    const clean = String(result || '').trim();
    if (!clean) throw new Error('the model returned nothing');
    if (hasSel) replaceRange(a, b, clean, a + clean.length);
    else { editor.value = clean; onInput(); }
    setDocStatus('AI edit applied — ⌘Z to undo', false);
  } catch (err) {
    setDocStatus('', false);
    toast(`AI edit failed: ${err.message || err}`);
  }
}

/* ------------------------------------------------------------ persistence */

const save = debounce(() => {
  dirty = false;
  emit('document:changed');
  setDocStatus('Saved', false);
}, 700);

function onInput() {
  dirty = true;
  updateStats();
  if (previewOn) renderPreview();
  setDocStatus('Saving…', false);
  save();
}

function updateStats() {
  const text = editor.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const todo = (editor.value.match(/^\s*[-*]\s\[ \]/gm) || []).length;
  const done = (editor.value.match(/^\s*[-*]\s\[[xX]\]/gm) || []).length;
  $('#docStats').textContent =
    `${words} word${words === 1 ? '' : 's'}` + (todo + done ? ` · ${done}/${todo + done} done` : '');
}

function setDocStatus(text, busy) {
  const node = $('#docSaved');
  node.textContent = text;
  node.classList.toggle('busy', !!busy);
}

export const getMarkdown = () => (editor ? editor.value : '');

export function setMarkdown(md) {
  if (!editor) return;
  editor.value = md || '';
  dirty = false;
  updateStats();
  if (previewOn) renderPreview();
  setDocStatus('', false);
}

/* ------------------------------------------------------------ preview */

function renderPreview() {
  $('#docPreview').innerHTML = renderDocMarkdown(editor.value);
}

/** Markdown for the note document — headings and checkboxes on top of the base renderer. */
function renderDocMarkdown(md) {
  const lines = String(md).split('\n');
  const out = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length) {
      out.push(renderMarkdown(buffer.join('\n')));
      buffer = [];
    }
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const todo = line.match(/^\s*[-*]\s\[([ xX])\]\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      out.push(`<h${level}>${escapeHtml(h[2])}</h${level}>`);
    } else if (todo) {
      flush();
      const done = todo[1].toLowerCase() === 'x';
      out.push(`<div class="md-todo${done ? ' done' : ''}"><span>${done ? '☑' : '☐'}</span>${escapeHtml(todo[2])}</div>`);
    } else if (/^\s*---+\s*$/.test(line)) {
      flush();
      out.push('<hr />');
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out.join('');
}

export function togglePreview(force) {
  previewOn = force === undefined ? !previewOn : !!force;
  $('#docPreview').hidden = !previewOn;
  $('#docEditor').classList.toggle('half', previewOn);
  $('#btnDocPreview').classList.toggle('active', previewOn);
  if (previewOn) renderPreview();
}

export async function exportDocument() {
  const md = getMarkdown().trim();
  if (!md) return toast('The document is empty.');
  const base = (state.docName || 'document').replace(/\.pdf$/i, '');
  const saved = await window.api.exportNotes(`${base} — document.md`, md);
  if (saved) toast(`Exported to ${saved.split('/').pop()}`);
}

/* ------------------------------------------------------------ wiring */

export function initDocNotes() {
  editor = $('#docEditor');

  editor.addEventListener('input', onInput);

  editor.addEventListener('keydown', (e) => {
    if (slashMenu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveSlash(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveSlash(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const on = slashMenu.querySelector('.slash-item.on');
        return chooseSlash(on ? on.dataset.key : BLOCKS[0].key);
      }
      if (e.key === 'Escape') { e.preventDefault(); return closeSlashMenu(); }
    }

    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); return applyInline('bold'); }
      if (k === 'i') { e.preventDefault(); return applyInline('italic'); }
      if (k === 'e') { e.preventDefault(); return applyInline('codeSpan'); }
    }

    if (e.key === 'Enter' && !e.shiftKey) handleEnter(e);

    if (e.key === 'Tab') {
      e.preventDefault();
      replaceRange(editor.selectionStart, editor.selectionEnd, '  ');
    }
  });

  // "/" at the start of an empty line opens the block menu.
  editor.addEventListener('keyup', (e) => {
    if (e.key !== '/') return;
    const pos = editor.selectionStart;
    const { start } = lineBounds(editor.value, pos);
    if (editor.value.slice(start, pos).trim() === '/') openSlashMenu();
  });

  editor.addEventListener('blur', () => setTimeout(closeSlashMenu, 150));
  editor.addEventListener('scroll', closeSlashMenu);

  $('#docToolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-md]');
    if (!btn) return;
    const key = btn.dataset.md;
    if (key === 'bold' || key === 'italic') applyInline(key);
    else if (key === 'code') applyBlock('code');
    else applyBlock(key);
  });

  $('#docAiBtn').addEventListener('click', (e) => openAiMenu(e.currentTarget));
  $('#btnDocPreview').addEventListener('click', () => togglePreview());
  $('#btnDocExport').addEventListener('click', exportDocument);

  // Clicking a checkbox in the preview ticks it in the source.
  $('#docPreview').addEventListener('click', (e) => {
    const row = e.target.closest('.md-todo');
    if (!row) return;
    const rows = [...$('#docPreview').querySelectorAll('.md-todo')];
    const nth = rows.indexOf(row);
    let seen = -1;
    editor.value = editor.value.replace(/^(\s*[-*]\s)\[([ xX])\]/gm, (m, lead, mark) => {
      seen += 1;
      if (seen !== nth) return m;
      return `${lead}[${mark.toLowerCase() === 'x' ? ' ' : 'x'}]`;
    });
    onInput();
  });

  on('doc:loaded', () => updateStats());
}

/** Pull a highlight into the document — used by the notes panel's "send" action. */
export function insertQuote(annotation) {
  if (!editor) return;
  const parts = [];
  if (annotation.quote) parts.push(`> ${annotation.quote.replace(/\n+/g, ' ')}`);
  if (annotation.note) parts.push(annotation.note);
  parts.push(`*— p. ${annotation.page}*`);
  const block = `\n\n${parts.join('\n\n')}\n`;
  const at = editor.value.length;
  replaceRange(at, at, block);
  toast('Added to the document');
}
