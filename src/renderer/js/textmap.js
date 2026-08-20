/**
 * Shared bridge between a page's plain text and the DOM of pdf.js's text layer.
 *
 * pdf.js renders each text run as its own absolutely-positioned span, so a
 * sentence is usually split across several nodes with no whitespace between
 * them. Both search and read-aloud need to go from "characters 120–137 of this
 * page" back to a real DOM Range they can measure — this does that mapping.
 */

/**
 * Collapse a text layer into one normalized string plus a position map.
 * `skip` receives each text node and returns true to leave it out — used to
 * drop text inside dead zones so it is never read aloud.
 */
export function flattenTextLayer(layer, { skip = null } = {}) {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (skip && skip(node)) continue;
    nodes.push(node);
  }
  if (!nodes.length) return null;

  let flat = '';
  const map = [];
  let pendingSpace = false;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const value = node.nodeValue || '';
    for (let j = 0; j < value.length; j++) {
      const ch = value[j];
      if (/\s/.test(ch)) { pendingSpace = flat.length > 0; continue; }
      if (pendingSpace) { flat += ' '; map.push({ node, offset: j }); pendingSpace = false; }
      flat += ch;
      map.push({ node, offset: j });
    }
    // Separate spans read as separate words.
    if (i < nodes.length - 1 && flat.length) pendingSpace = true;
  }

  const last = nodes[nodes.length - 1];
  map.push({ node: last, offset: (last.nodeValue || '').length });
  return { flat, map, nodes };
}

/** Turn a [start, end) span of the flattened string into a DOM Range. */
export function rangeFor(mapped, start, end) {
  if (!mapped || start < 0 || end <= start) return null;
  const a = mapped.map[start];
  const b = mapped.map[Math.min(end, mapped.map.length) - 1];
  if (!a || !b) return null;
  const range = document.createRange();
  try {
    range.setStart(a.node, Math.min(a.offset, (a.node.nodeValue || '').length));
    range.setEnd(b.node, Math.min(b.offset + 1, (b.node.nodeValue || '').length));
  } catch {
    return null;
  }
  return range;
}

/** Rectangles for a flattened-text span, normalized to the page box. */
export function rectsFor(pageEl, mapped, start, end) {
  const range = rangeFor(mapped, start, end);
  if (!range) return [];
  const pb = pageEl.getBoundingClientRect();
  if (!pb.width || !pb.height) return [];
  const out = [];
  for (const r of range.getClientRects()) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    out.push({
      x: (r.left - pb.left) / pb.width,
      y: (r.top - pb.top) / pb.height,
      w: r.width / pb.width,
      h: r.height / pb.height
    });
  }
  return out;
}

/**
 * Split text into speakable sentences, keeping each one's offset into the
 * source string so spoken position can be mapped back onto the page.
 */
export function splitSentences(text, { minLength = 2 } = {}) {
  const out = [];
  const re = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body.length < minLength) continue;
    out.push({ text: body, start: m.index + lead, end: m.index + lead + body.length });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}
