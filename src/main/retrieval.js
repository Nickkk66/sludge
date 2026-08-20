'use strict';

/**
 * Local, dependency-free retrieval over the PDF's page text and the user's
 * notes. BM25 with a phrase bonus — fast enough to search an 800-page textbook
 * in a few milliseconds, and it never leaves the machine.
 */

const STOP = new Set(
  ('a an and are as at be by for from has have had he her his i in into is it its of on or she that the their then there ' +
   'they this to was were what when where which who will with you your we our us do does did but not no so if than them ' +
   'these those been being am about over under more most such can could would should may might').split(' ')
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// Very light suffix stripping — enough to match "colonies"/"colonial"/"colony".
function stem(t) {
  if (t.length > 5 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  return t;
}

class Bm25 {
  constructor(docs) {
    // docs: [{ id, text, meta }]
    this.docs = docs;
    this.k1 = 1.4;
    this.b = 0.72;
    this.df = new Map();
    this.tf = [];
    this.len = [];
    let total = 0;
    for (const d of docs) {
      const toks = tokenize(d.text);
      const counts = new Map();
      for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      this.tf.push(counts);
      this.len.push(toks.length);
      total += toks.length;
    }
    this.avgLen = total / Math.max(1, docs.length);
    this.N = docs.length;
  }

  search(query, limit = 8) {
    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length) return [];
    const phrase = String(query).toLowerCase().trim();
    const scores = new Array(this.N).fill(0);

    for (const t of qTokens) {
      const df = this.df.get(t) || 0;
      if (!df) continue;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < this.N; i++) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const norm = 1 - this.b + this.b * (this.len[i] / this.avgLen);
        scores[i] += idf * ((f * (this.k1 + 1)) / (f + this.k1 * norm));
      }
    }

    // Exact-phrase bonus: a page literally containing the question's wording
    // is almost always the right page.
    if (phrase.length > 8) {
      for (let i = 0; i < this.N; i++) {
        if (scores[i] > 0 && String(this.docs[i].text).toLowerCase().includes(phrase)) {
          scores[i] *= 1.6;
        }
      }
    }

    return scores
      .map((score, i) => ({ score, doc: this.docs[i] }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** Pull the most query-relevant window of text out of a long page. */
function bestExcerpt(text, query, maxChars = 900) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const qTokens = new Set(tokenize(query));
  const sentences = clean.split(/(?<=[.?!])\s+/);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const window = sentences.slice(i, i + 4).join(' ');
    let s = 0;
    for (const t of tokenize(window)) if (qTokens.has(t)) s++;
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  let out = '';
  for (let i = best; i < sentences.length && out.length < maxChars; i++) out += `${sentences[i]} `;
  return `${out.trim().slice(0, maxChars)}…`;
}

/**
 * Rank pages and notes separately so the answer layer always knows which
 * evidence came from the book and which came from the reader's own notes.
 */
// Questions aimed at the reader's own material, and at the document itself.
// Pure keyword ranking answers both badly, so they get explicit handling.
const NOTE_INTENT = /\b(my|our)\s+(notes?|highlights?|comments?|annotations?)\b|\bwhat did i\b|\bi (wrote|noted|highlighted|marked)\b|\bmy own\b/i;
const META_INTENT = /\bwho\s+(wrote|authored|is the author)\b|\bauthors?\b|\bwhat (book|textbook|document) is this\b|\btitle of (this|the)\b|\bedition\b|\bpublish(er|ed)\b|\bcopyright\b|\bwhat is this (book|pdf|document)\b/i;

function retrieve({ query, pages = [], annotations = [], pageLimit = 6, noteLimit = 5 }) {
  const pageDocs = pages
    .filter((p) => p && p.text && p.text.trim().length > 40)
    .map((p) => ({ id: `p${p.page}`, text: p.text, meta: { page: p.page } }));

  const noteDocs = annotations
    .filter((a) => (a.note && a.note.trim()) || (a.quote && a.quote.trim()))
    .map((a) => ({
      id: a.id,
      // Index the note text and the highlighted quote together so a question
      // matches either the reader's words or the sentence they marked.
      text: `${a.note || ''} ${a.quote || ''} ${(a.tags || []).join(' ')}`,
      meta: {
        page: a.page,
        created: a.created || '',
        note: a.note || '',
        quote: a.quote || '',
        tags: a.tags || [],
        type: a.type,
        color: a.color
      }
    }));

  let pageHits = pageDocs.length ? new Bm25(pageDocs).search(query, pageLimit) : [];
  let noteHits = noteDocs.length ? new Bm25(noteDocs).search(query, noteLimit) : [];

  // "What do my notes say?" has few keywords to match on. When the reader is
  // clearly asking about their own material, show it to the model regardless
  // of lexical overlap — newest first, since that is what they just wrote.
  if (NOTE_INTENT.test(query) && noteHits.length < noteLimit) {
    const already = new Set(noteHits.map((h) => h.doc.id));
    const extras = noteDocs
      .filter((d) => !already.has(d.id))
      .sort((a, b) => (b.meta.created || '').localeCompare(a.meta.created || ''))
      .slice(0, noteLimit - noteHits.length)
      .map((doc) => ({ score: 0, doc }));
    noteHits = noteHits.concat(extras);
  }

  // Title, author, and edition live in the front matter, which rarely contains
  // the words the question uses.
  if (META_INTENT.test(query)) {
    const already = new Set(pageHits.map((h) => h.doc.meta.page));
    const front = pageDocs
      .filter((d) => d.meta.page <= 8 && !already.has(d.meta.page))
      .slice(0, 4)
      .map((doc) => ({ score: 0, doc }));
    pageHits = front.concat(pageHits).slice(0, pageLimit + front.length);
  }

  return {
    pages: pageHits.map((h) => ({
      page: h.doc.meta.page,
      score: Number(h.score.toFixed(3)),
      excerpt: bestExcerpt(h.doc.text, query)
    })),
    notes: noteHits.map((h) => ({
      id: h.doc.id,
      page: h.doc.meta.page,
      score: Number(h.score.toFixed(3)),
      note: h.doc.meta.note,
      quote: bestExcerpt(h.doc.meta.quote, query, 400),
      tags: h.doc.meta.tags,
      type: h.doc.meta.type
    }))
  };
}

module.exports = { retrieve, tokenize, Bm25, bestExcerpt };
