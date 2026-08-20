/**
 * Chapter list recovery.
 *
 * Many textbooks — including scanned ones — ship with no embedded PDF outline,
 * but they all print a table of contents. This reads those pages, then works
 * out the offset between the book's printed page numbers and the PDF's page
 * indices so every entry lands on the right page.
 */

const NUM_FIX = { l: '1', I: '1', O: '0', o: '0', S: '5' };
const fixNum = (s) => s.replace(/[lIOoS]/g, (c) => NUM_FIX[c] || c);

// A contents line: some title, then the printed page number at the end.
const TRAILING_NUM = /^(.*?)[\s.]+([\dlIOoS]{1,4})$/;

const PERIOD = /^(period\s+[\divxlc]+)\s*[:.—-]?\s*(.*)$/i;
const CHAPTER = /^(chapter\s+\d+)\b[\s.:—-]*(.*)$/i;
const REVIEW = /^(period\s+\d+\s+review)\b\s*(.*)$/i;
const FRONT = /^(preface|introduction|index|glossary|appendix)\b[\s.:—-]*(.*)$/i;

// Sub-entries that would bury the real chapters if included.
const SKIP = /^(historical perspectives|think as a historian|long-essay|document-based|analyzing|writing|multiple-choice|short-answer|key terms|questions)/i;

/** Pages that look like a table of contents. */
function findTocPages(pages, limit = 60) {
  const hits = [];
  for (const p of pages.slice(0, limit)) {
    if (!p || !p.text) continue;
    const lines = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 5) continue;
    const numbered = lines.filter((l) => TRAILING_NUM.test(l)).length;
    const chapterish = lines.filter((l) => CHAPTER.test(l) || PERIOD.test(l)).length;
    const saysContents = /^contents\b/i.test(lines[0]) || /^table of contents/i.test(lines[0]);
    // Either it announces itself, or it reads like a dense list of numbered titles.
    if (saysContents || (chapterish >= 2 && numbered >= 5) || (chapterish >= 4)) {
      hits.push({ page: p.page, lines });
    }
  }
  return hits;
}

function parseEntries(tocPages) {
  const entries = [];
  for (const { lines } of tocPages) {
    for (const raw of lines) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line || line.length > 120 || SKIP.test(line)) continue;

      let body = line;
      let printed = null;
      const m = line.match(TRAILING_NUM);
      if (m) {
        const n = parseInt(fixNum(m[2]), 10);
        // A trailing number is only a page number if it's plausible.
        if (Number.isFinite(n) && n > 0 && n < 2000) {
          body = m[1].trim();
          printed = n;
        }
      }

      let kind = null;
      let title = null;
      let depth = 1;
      let key = null;

      let g;
      if ((g = body.match(REVIEW))) {
        kind = 'review'; depth = 1;
        title = cap(g[1]);
        key = title.toLowerCase();
      } else if ((g = body.match(CHAPTER))) {
        kind = 'chapter'; depth = 1;
        title = g[2] ? `${cap(g[1])}: ${g[2].trim()}` : cap(g[1]);
        key = fixNum(g[1].toLowerCase()).replace(/\s+/g, ' ');
      } else if ((g = body.match(PERIOD))) {
        kind = 'period'; depth = 0;
        title = g[2] ? `${cap(g[1])}: ${g[2].trim()}` : cap(g[1]);
        // "PERIOD l" and "PERIOD 1" are the same entry to a scanner.
        key = fixNum(g[1].toLowerCase()).replace(/\s+/g, ' ');
      } else if ((g = body.match(FRONT))) {
        kind = 'front'; depth = 1;
        title = g[2] ? `${cap(g[1])}: ${g[2].trim()}` : cap(g[1]);
        key = g[1].toLowerCase();
      }

      if (!kind || !title) continue;
      if (entries.some((e) => e.key === key)) continue;
      entries.push({ key, kind, title: tidy(title), printed, depth });
    }
  }
  return entries;
}

/**
 * The PDF's page 1 is rarely the book's page 1. Match a few contents entries
 * against where their titles actually appear and take the median difference.
 */
function estimateOffset(entries, pages, tocPageNumbers) {
  const skip = new Set(tocPageNumbers);
  const diffs = [];

  for (const e of entries) {
    if (!e.printed || !e.title) continue;
    const phrase = titlePhrase(e.title);
    if (!phrase || phrase.length < 12) continue;
    const found = findPhrasePage(pages, phrase, skip);
    if (found) diffs.push(found - e.printed);
    if (diffs.length >= 12) break;
  }

  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** The distinctive part of a title, without the "Chapter 4" prefix. */
function titlePhrase(title) {
  const after = title.split(':').slice(1).join(':').trim() || title;
  return after.replace(/,?\s*\d{4}[-–—]\d{4}\s*$/, '').trim();
}

function findPhrasePage(pages, phrase, skip, from = 0) {
  const needle = norm(phrase);
  if (needle.length < 10) return null;
  // A chapter title normally opens its page, so prefer that; but scanned books
  // push it below artwork, so fall back to anywhere on the page.
  for (const scope of [400, 0]) {
    for (const p of pages) {
      if (!p || !p.text || skip.has(p.page) || p.page <= from) continue;
      const hay = norm(scope ? p.text.slice(0, scope) : p.text);
      if (hay.includes(needle)) return p.page;
    }
  }
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const tidy = (s) => s
  .replace(/\s*[.…]{2,}\s*$/, '')
  // Scanners read "1" as "l" constantly; only touch it next to real digits.
  .replace(/\bl(?=\d{3}\b)/g, '1')
  .replace(/(\d)[-–—]\s*l\s*(\d{3})\b/g, '$1-1$2')
  // "of Industrial" is scanned as "oflndustrial" — capital I read as lowercase l.
  .replace(/\bof[lI]([a-z]{3,})/g, (m, rest) => `of I${rest}`)
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Entries whose page number the scan lost (OCR drops them on some pages) get
 * located by searching for the title itself.
 */
function fillMissingPages(entries, pages, offset, skip) {
  for (const e of entries) {
    if (e.page) continue;
    const phrase = titlePhrase(e.title);
    // Search forward of the previous placed entry — chapter titles recur in
    // running headers, and the first hit before the chapter is the wrong one.
    const prev = entries.slice(0, entries.indexOf(e)).reverse().find((x) => x.page);
    const found = findPhrasePage(pages, phrase, skip, prev ? prev.page : 0);
    if (found) { e.page = found; e.inferred = true; }
  }
  // Anything still unplaced gets spread evenly across the gap it sits in,
  // rather than piling onto one page.
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].page) continue;
    let j = i;
    while (j < entries.length && !entries[j].page) j++;
    const prev = entries.slice(0, i).reverse().find((e) => e.page);
    const next = entries[j] && entries[j].page;
    const run = j - i;
    if (prev && next && next > prev) {
      const step = (next - prev) / (run + 1);
      for (let k = 0; k < run; k++) {
        entries[i + k].page = Math.round(prev.page + step * (k + 1));
        entries[i + k].inferred = true;
      }
    }
    i = j - 1;
  }
  return entries.filter((e) => e.page);
}

export function parseToc(pages) {
  if (!pages || pages.length < 5) return [];
  const tocPages = findTocPages(pages);
  if (!tocPages.length) return [];

  const entries = parseEntries(tocPages);
  const chapters = entries.filter((e) => e.kind === 'chapter' || e.kind === 'period');
  if (chapters.length < 4) return [];

  const tocNums = tocPages.map((t) => t.page);
  const offset = estimateOffset(entries, pages, tocNums);
  if (offset === null) return [];

  for (const e of entries) {
    if (e.printed) e.page = e.printed + offset;
  }
  const placed = fillMissingPages(entries, pages, offset, new Set(tocNums));

  // Contents order is the book's order; keep it, but drop anything that
  // clearly landed out of sequence.
  const sorted = placed
    .filter((e) => e.page >= 1 && e.page <= pages.length)
    .sort((a, b) => a.page - b.page);

  return sorted.map((e) => ({ title: e.title, page: e.page, depth: e.depth, source: 'contents' }));
}
