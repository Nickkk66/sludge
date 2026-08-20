import { $, el, escapeHtml, renderMarkdown, debounce, toast, uid } from './util.js';
import { state, emit, on } from './state.js';
import { profilePrompt } from './profile.js';
import { markdownToNodes, nodesToMarkdown, applyLineRule, currentBlock, placeCaretAtEnd, makeTodo } from './editor.js';

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

/* ------------------------------------------------------------ editing */

const INLINE = { bold: ['**', '**'], italic: ['*', '*'], codeSpan: ['`', '`'] };

/** Wrap the selection in an inline element, or unwrap it if already wrapped. */
export function applyInline(kind) {
  const tag = kind === 'bold' ? 'strong' : (kind === 'italic' ? 'em' : 'code');
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  if (range.collapsed) {
    const node = document.createElement(tag);
    node.textContent = '\u200b';
    range.insertNode(node);
    placeCaretAtEnd(node);
    onInput();
    return;
  }

  // Already inside one of these? Strip it.
  let anc = range.commonAncestorContainer;
  if (anc.nodeType === Node.TEXT_NODE) anc = anc.parentNode;
  const existing = anc.closest && anc.closest(tag);
  if (existing) {
    const text = document.createTextNode(existing.textContent);
    existing.replaceWith(text);
    onInput();
    return;
  }

  const node = document.createElement(tag);
  try {
    node.append(range.extractContents());
    range.insertNode(node);
    placeCaretAtEnd(node);
  } catch { /* selection spanned blocks; leave it be */ }
  onInput();
}

/** Turn the caret's block into the requested kind. */
export function applyBlock(key) {
  const block = currentBlock(editor);
  if (!block) return;
  const text = block.textContent.replace(/^(#{1,3}\s|[-*]\s\[.\]\s|[-*]\s|\d+[.)]\s|>\s)/, '');

  const swap = (tag) => {
    const next = document.createElement(tag);
    next.textContent = text;
    block.replaceWith(next);
    placeCaretAtEnd(next);
  };

  switch (key) {
    case 'h1': swap('h1'); break;
    case 'h2': swap('h2'); break;
    case 'h3': swap('h3'); break;
    case 'quote': swap('blockquote'); break;
    case 'code': {
      const pre = document.createElement('pre');
      pre.textContent = text;
      block.replaceWith(pre);
      placeCaretAtEnd(pre);
      break;
    }
    case 'todo': {
      const row = makeTodo(false, text);
      block.replaceWith(row);
      placeCaretAtEnd(row.querySelector('.todo-text'));
      break;
    }
    case 'bullet':
    case 'number': {
      const list = document.createElement(key === 'bullet' ? 'ul' : 'ol');
      const li = document.createElement('li');
      li.textContent = text;
      list.append(li);
      block.replaceWith(list);
      placeCaretAtEnd(li);
      break;
    }
    case 'rule': {
      const hr = document.createElement('hr');
      const after = document.createElement('p');
      after.append(document.createElement('br'));
      block.replaceWith(hr);
      hr.after(after);
      placeCaretAtEnd(after);
      break;
    }
    case 'table': {
      const pre = document.createElement('pre');
      pre.textContent = '| | |\n|---|---|\n| | |';
      block.replaceWith(pre);
      placeCaretAtEnd(pre);
      break;
    }
    default: break;
  }
  onInput();
}

/**
 * Enter inside an empty list item or tick box leaves the list, which is what
 * every editor does and what fingers expect.
 */
function handleEnter(e) {
  const block = currentBlock(editor);
  if (!block) return;

  const isTodo = block.classList && block.classList.contains('todo');
  const todoRow = isTodo ? block : (block.closest && block.closest('.todo'));

  if (todoRow) {
    e.preventDefault();
    const body = todoRow.querySelector('.todo-text');
    if (!body.textContent.trim()) {
      const p = document.createElement('p');
      p.append(document.createElement('br'));
      todoRow.replaceWith(p);
      placeCaretAtEnd(p);
    } else {
      const row = makeTodo(false, '');
      todoRow.after(row);
      placeCaretAtEnd(row.querySelector('.todo-text'));
    }
    onInput();
    return;
  }

  if (block.tagName === 'LI' && !block.textContent.trim()) {
    e.preventDefault();
    const list = block.parentElement;
    const p = document.createElement('p');
    p.append(document.createElement('br'));
    list.after(p);
    block.remove();
    if (!list.children.length) list.remove();
    placeCaretAtEnd(p);
    onInput();
    return;
  }

  // Leaving a heading or quote starts an ordinary paragraph.
  if (/^(H1|H2|H3|BLOCKQUOTE)$/.test(block.tagName)) {
    e.preventDefault();
    const p = document.createElement('p');
    p.append(document.createElement('br'));
    block.after(p);
    placeCaretAtEnd(p);
    onInput();
  }
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
  const block = currentBlock(editor);
  if (block) block.textContent = block.textContent.replace(/\/$/, '');
  closeSlashMenu();
  applyBlock(key);
}

/** On-screen caret position, for placing the block menu. */
function caretRect() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return { top: r.top, bottom: r.bottom, left: r.left };
    const block = currentBlock(editor);
    if (block) {
      const b = block.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left };
    }
  }
  const box = editor.getBoundingClientRect();
  return { top: box.top + 40, bottom: box.top + 60, left: box.left + 20 };
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
  const selection = window.getSelection();
  const hasSel = selection && !selection.isCollapsed
    && selection.toString().trim() && editor.contains(selection.anchorNode);
  const scope = hasSel ? 'selection' : 'whole document';
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
  const sel = window.getSelection();
  const hasSel = sel && !sel.isCollapsed && sel.toString().trim() && editor.contains(sel.anchorNode);
  const target = hasSel ? sel.toString() : getMarkdown();
  if (!target.trim()) return toast('Nothing to work on yet.');
  const savedRange = hasSel ? sel.getRangeAt(0).cloneRange() : null;

  setDocStatus(`${action.label}…`, true);
  try {
    const result = await window.api.ai.rewrite({
      model: state.aiModel,
      instruction: action.prompt,
      text: target,
      profile: profilePrompt()
    });
    const clean = String(result || '').trim();
    if (!clean) throw new Error('the model returned nothing');
    if (hasSel && savedRange) {
      savedRange.deleteContents();
      const nodes = markdownToNodes(clean);
      // A single paragraph goes inline; anything longer becomes real blocks.
      if (nodes.length === 1 && nodes[0].tagName === 'P') {
        savedRange.insertNode(document.createTextNode(nodes[0].textContent));
      } else {
        const block = currentBlock(editor) || editor.lastElementChild;
        let anchor = block;
        for (const node of nodes) { anchor.after(node); anchor = node; }
      }
    } else {
      setMarkdown(clean);
    }
    onInput();
    setDocStatus('AI edit applied', false);
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
  setDocStatus('Saving…', false);
  save();
}

function updateStats() {
  const text = editor.textContent.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const todo = editor.querySelectorAll('.todo:not(.done)').length;
  const done = editor.querySelectorAll('.todo.done').length;
  $('#docStats').textContent =
    `${words} word${words === 1 ? '' : 's'}` + (todo + done ? ` · ${done}/${todo + done} done` : '');
}

function setDocStatus(text, busy) {
  const node = $('#docSaved');
  node.textContent = text;
  node.classList.toggle('busy', !!busy);
}

export const getMarkdown = () => (editor ? nodesToMarkdown(editor) : '');

export function setMarkdown(md) {
  if (!editor) return;
  if (rawMode) {
    $('#docRaw').value = md || '';
  }
  editor.replaceChildren(...markdownToNodes(md || ''));
  dirty = false;
  updateStats();
  setDocStatus('', false);
}

/* ------------------------------------------------------------ raw markdown */

let rawMode = false;

/** Show the Markdown the document is actually stored as. */
export function toggleRawMarkdown(force) {
  rawMode = force === undefined ? !rawMode : !!force;
  const body = $('.doc-body');
  const raw = $('#docRaw');
  $('#btnDocMarkdown').classList.toggle('active', rawMode);

  if (rawMode) {
    const area = raw || el('textarea', { id: 'docRaw', class: 'doc-raw', spellcheck: 'false' });
    area.value = getMarkdown();
    editor.hidden = true;
    if (!raw) body.append(area);
    area.hidden = false;
    area.focus();
  } else {
    if (raw) {
      // Take back whatever was typed in the raw view.
      const md = raw.value;
      raw.hidden = true;
      editor.hidden = false;
      setMarkdown(md);
      onInput();
    } else {
      editor.hidden = false;
    }
  }
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
  if (!editor.children.length) editor.append(document.createElement('p'));

  editor.addEventListener('input', () => {
    // Formatting is applied as you type, so the marker never survives.
    applyLineRule(currentBlock(editor));
    onInput();
  });

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
  });

  editor.addEventListener('keyup', (e) => {
    if (e.key !== '/') return;
    const block = currentBlock(editor);
    if (block && block.textContent.trim() === '/') openSlashMenu();
  });

  // Paste as plain text; pasted HTML would bring foreign styling with it.
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    const nodes = markdownToNodes(text);
    const block = currentBlock(editor);
    if (block && nodes.length) {
      let anchor = block;
      for (const node of nodes) { anchor.after(node); anchor = node; }
      if (!block.textContent.trim()) block.remove();
      placeCaretAtEnd(anchor);
    }
    onInput();
  });

  // Clicking a tick box toggles it.
  editor.addEventListener('click', (e) => {
    const box = e.target.closest('.todo-box');
    if (!box) return;
    const row = box.closest('.todo');
    row.classList.toggle('done');
    box.textContent = row.classList.contains('done') ? '\u2713' : '';
    onInput();
  });

  editor.addEventListener('blur', () => setTimeout(closeSlashMenu, 150));
  editor.addEventListener('scroll', closeSlashMenu);

  $('#docToolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-md]');
    if (!btn) return;
    const key = btn.dataset.md;
    if (key === 'bold' || key === 'italic') applyInline(key);
    else applyBlock(key);
  });

  $('#docAiBtn').addEventListener('click', (e) => openAiMenu(e.currentTarget));
  $('#btnDocMarkdown').addEventListener('click', () => toggleRawMarkdown());
  $('#btnDocExport').addEventListener('click', exportDocument);

  on('doc:loaded', () => updateStats());
}

/** Append a block of Markdown to the document. */
export function insertMarkdown(md) {
  if (!editor) return;
  for (const node of markdownToNodes(md)) editor.append(node);
  placeCaretAtEnd(editor.lastElementChild);
  onInput();
}

/** Pull a highlight into the document — used by the notes panel's "send" action. */
export function insertQuote(annotation) {
  if (!editor) return;
  const parts = [];
  if (annotation.quote) parts.push(`> ${annotation.quote.replace(/\n+/g, ' ')}`);
  if (annotation.note) parts.push(annotation.note);
  parts.push(`*— p. ${annotation.page}*`);
  for (const node of markdownToNodes(parts.join('\n\n'))) editor.append(node);
  placeCaretAtEnd(editor.lastElementChild);
  onInput();
  toast('Added to the document');
}
