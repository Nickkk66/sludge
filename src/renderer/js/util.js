export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

/**
 * Replace an element's children, dropping conditional blanks.
 * `Node.replaceChildren(null)` inserts the literal text "null"; this doesn't.
 */
export const setChildren = (node, ...kids) => {
  node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
};

export const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(pending);
      pending = setTimeout(() => {
        last = performance.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

/**
 * A small in-app confirm. Native dialogs steal focus and feel heavier than a
 * note deletion deserves.
 */
export function confirmAction({ message, detail = '', confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    document.querySelectorAll('.confirm-sheet').forEach((n) => n.remove());
    const done = (answer) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };

    const card = el('div', { class: 'confirm-card' },
      el('b', {}, message),
      detail ? el('p', {}, detail) : null,
      el('div', { class: 'confirm-actions' },
        el('button', { onclick: () => done(false) }, 'Cancel'),
        el('button', { class: danger ? 'danger' : 'primary', onclick: () => done(true) }, confirmLabel)
      )
    );
    const wrap = el('div', { class: 'confirm-sheet', onclick: (e) => { if (e.target === wrap) done(false); } }, card);
    document.body.append(wrap);
    document.addEventListener('keydown', onKey);
    setTimeout(() => card.querySelector('button:last-child').focus(), 30);
  });
}

let toastTimer;
export function toast(message, ms = 2600) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export const fmtSize = (bytes) => {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
};

/** Merge rects that sit on the same text line, so a highlight is one bar per line. */
export function mergeLineRects(rects, tolerance = 0.004) {
  const sorted = [...rects].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const r of sorted) {
    const line = lines.find(
      (l) => Math.abs(l.y - r.y) < tolerance && Math.abs((l.y + l.h) - (r.y + r.h)) < tolerance * 2
    );
    if (line) {
      const right = Math.max(line.x + line.w, r.x + r.w);
      line.x = Math.min(line.x, r.x);
      line.w = right - line.x;
      line.y = Math.min(line.y, r.y);
      line.h = Math.max(line.h, r.h);
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

/** Minimal, safe markdown → HTML for AI answers (no raw HTML passes through). */
export function renderMarkdown(md) {
  let html = escapeHtml(md);

  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Citations become clickable jump targets.
  html = html.replace(/\[note,?\s*p\.?\s*(\d+)\]/gi,
    (_m, p) => `<span class="cite note-cite" data-page="${p}" title="Your note on page ${p}">note p.${p}</span>`);
  html = html.replace(/\[p\.?\s*(\d+)\]/gi,
    (_m, p) => `<span class="cite" data-page="${p}" title="Go to page ${p}">p.${p}</span>`);

  const lines = html.split('\n');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${ol[1]}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join('');
}
