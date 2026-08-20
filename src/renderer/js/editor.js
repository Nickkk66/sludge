/**
 * The note document's editing surface.
 *
 * A textarea plus a preview pane meant reading your notes twice — once as
 * syntax and once as output. This is a contenteditable surface that formats as
 * you type: "# " turns the line into a heading and the marker disappears,
 * "- [ ] " becomes a real tick box.
 *
 * Markdown stays the storage format. The DOM is a view of it, serialised back
 * on every change, so what lands in the sidecar file is still plain text you
 * could open anywhere.
 */

const BLOCKS = 'H1,H2,H3,P,LI,BLOCKQUOTE,PRE,DIV';

/* ------------------------------------------------------------ markdown → DOM */

export function markdownToNodes(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let list = null;      // { type: 'UL'|'OL', node }
  let fence = null;     // collecting a code block

  const closeList = () => { list = null; };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (fence !== null) {
      if (/^```/.test(line)) {
        const pre = document.createElement('pre');
        pre.textContent = fence.join('\n');
        out.push(pre);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) { closeList(); fence = []; continue; }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push(document.createElement('hr'));
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const h = document.createElement(`h${heading[1].length}`);
      h.innerHTML = inlineToHtml(heading[2]);
      out.push(h);
      continue;
    }

    const todo = line.match(/^\s*[-*]\s\[([ xX])\]\s?(.*)$/);
    if (todo) {
      closeList();
      out.push(makeTodo(todo[1].toLowerCase() === 'x', todo[2]));
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const type = bullet ? 'UL' : 'OL';
      if (!list || list.type !== type) {
        const node = document.createElement(type.toLowerCase());
        out.push(node);
        list = { type, node };
      }
      const li = document.createElement('li');
      li.innerHTML = inlineToHtml((bullet || numbered)[1]);
      list.node.append(li);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      const bq = document.createElement('blockquote');
      bq.innerHTML = inlineToHtml(quote[1]);
      out.push(bq);
      continue;
    }

    closeList();
    const p = document.createElement('p');
    if (line.trim()) p.innerHTML = inlineToHtml(line);
    else p.append(document.createElement('br'));
    out.push(p);
  }

  if (fence !== null && fence.length) {
    const pre = document.createElement('pre');
    pre.textContent = fence.join('\n');
    out.push(pre);
  }
  if (!out.length) out.push(document.createElement('p'));
  return out;
}

export function makeTodo(done, text) {
  const row = document.createElement('div');
  row.className = `todo${done ? ' done' : ''}`;
  const box = document.createElement('span');
  box.className = 'todo-box';
  box.contentEditable = 'false';
  box.textContent = done ? '✓' : '';
  const body = document.createElement('span');
  body.className = 'todo-text';
  body.innerHTML = inlineToHtml(text || '');
  row.append(box, body);
  return row;
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown → HTML, for the spans inside a block. */
function inlineToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>');
  return html || '';
}

/* ------------------------------------------------------------ DOM → markdown */

export function nodesToMarkdown(root) {
  const lines = [];

  const inline = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { out += child.nodeValue; continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName;
      if (tag === 'BR') out += '\n';
      else if (tag === 'STRONG' || tag === 'B') out += `**${inline(child)}**`;
      else if (tag === 'EM' || tag === 'I') out += `*${inline(child)}*`;
      else if (tag === 'CODE') out += `\`${inline(child)}\``;
      else out += inline(child);
    }
    return out;
  };

  for (const node of root.children) {
    const tag = node.tagName;
    if (tag === 'H1') lines.push(`# ${inline(node)}`);
    else if (tag === 'H2') lines.push(`## ${inline(node)}`);
    else if (tag === 'H3') lines.push(`### ${inline(node)}`);
    else if (tag === 'HR') lines.push('---');
    else if (tag === 'PRE') lines.push('```', node.textContent, '```');
    else if (tag === 'BLOCKQUOTE') lines.push(`> ${inline(node)}`);
    else if (tag === 'UL' || tag === 'OL') {
      let n = 1;
      for (const li of node.children) {
        lines.push(tag === 'UL' ? `- ${inline(li)}` : `${n++}. ${inline(li)}`);
      }
    } else if (node.classList && node.classList.contains('todo')) {
      const body = node.querySelector('.todo-text');
      lines.push(`- [${node.classList.contains('done') ? 'x' : ' '}] ${body ? inline(body) : ''}`);
    } else {
      const text = inline(node).replace(/\n$/, '');
      lines.push(text);
    }
  }

  // Collapse the runs of blank lines that editing tends to leave behind.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------ live rules */

/**
 * Markdown typed at the start of a line becomes the block it describes, and the
 * marker is removed — the formatting is the feedback, not the syntax.
 */
export function applyLineRule(block) {
  if (!block) return null;
  const text = block.textContent;

  const heading = text.match(/^(#{1,3})\s(.*)$/);
  if (heading && block.tagName !== `H${heading[1].length}`) {
    return replaceBlock(block, `h${heading[1].length}`, heading[2]);
  }

  const todo = text.match(/^[-*]\s\[([ xX])\]\s?(.*)$/);
  if (todo && !block.classList.contains('todo')) {
    const row = makeTodo(todo[1].toLowerCase() === 'x', todo[2]);
    block.replaceWith(row);
    placeCaretAtEnd(row.querySelector('.todo-text'));
    return row;
  }

  const bullet = text.match(/^[-*]\s(.*)$/);
  if (bullet && block.tagName !== 'LI' && !block.classList.contains('todo')) {
    return intoList(block, 'ul', bullet[1]);
  }

  const numbered = text.match(/^\d+[.)]\s(.*)$/);
  if (numbered && block.tagName !== 'LI') {
    return intoList(block, 'ol', numbered[1]);
  }

  const quote = text.match(/^>\s(.*)$/);
  if (quote && block.tagName !== 'BLOCKQUOTE') {
    return replaceBlock(block, 'blockquote', quote[1]);
  }

  if (/^(---|\*\*\*)$/.test(text.trim()) && block.tagName !== 'HR') {
    const hr = document.createElement('hr');
    const after = document.createElement('p');
    after.append(document.createElement('br'));
    block.replaceWith(hr);
    hr.after(after);
    placeCaretAtEnd(after);
    return hr;
  }

  return null;
}

function replaceBlock(block, tag, text) {
  const next = document.createElement(tag);
  next.textContent = text;
  block.replaceWith(next);
  placeCaretAtEnd(next);
  return next;
}

function intoList(block, tag, text) {
  const prev = block.previousElementSibling;
  const li = document.createElement('li');
  li.textContent = text;
  // Join the list above rather than starting a second one next to it.
  if (prev && prev.tagName === tag.toUpperCase()) {
    prev.append(li);
    block.remove();
  } else {
    const list = document.createElement(tag);
    list.append(li);
    block.replaceWith(list);
  }
  placeCaretAtEnd(li);
  return li;
}

/* ------------------------------------------------------------ caret helpers */

export function placeCaretAtEnd(node) {
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The block-level element the caret is currently inside. */
export function currentBlock(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== root) {
    if (node.matches && node.matches(BLOCKS)) return node;
    node = node.parentNode;
  }
  return null;
}
