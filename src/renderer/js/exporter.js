import { toast } from './util.js';
import { state, filteredAnnotations } from './state.js';

/** Build a study-ready Markdown digest of every highlight and note. */
export function buildMarkdown({ onlyFiltered = false } = {}) {
  const notes = onlyFiltered ? filteredAnnotations() : [...state.annotations].sort(
    (a, b) => a.page - b.page || topOf(a) - topOf(b)
  );

  const lines = [];
  lines.push(`# Notes — ${state.docName || 'Document'}`);
  lines.push('');
  lines.push(`_${notes.length} annotation${notes.length === 1 ? '' : 's'} · exported ${new Date().toLocaleString()}_`);
  lines.push('');

  const tagIndex = new Map();
  for (const a of notes) for (const t of a.tags || []) {
    if (!tagIndex.has(t)) tagIndex.set(t, []);
    tagIndex.get(t).push(a.page);
  }
  if (tagIndex.size) {
    lines.push('**Tags:** ' + [...tagIndex.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t, pages]) => `#${t} (${pages.length})`)
      .join(' · '));
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  let lastPage = null;
  for (const a of notes) {
    if (a.page !== lastPage) {
      lines.push(`## Page ${a.page}`);
      lines.push('');
      lastPage = a.page;
    }
    if (a.quote) {
      lines.push(`> ${a.quote.replace(/\n+/g, ' ')}`);
      lines.push('');
    }
    if (a.note) {
      lines.push(`**Note:** ${a.note}`);
      lines.push('');
    }
    if (a.tags && a.tags.length) {
      lines.push(a.tags.map((t) => `\`#${t}\``).join(' '));
      lines.push('');
    }
  }

  if (!notes.length) {
    lines.push('_No annotations yet._');
    lines.push('');
  }
  return lines.join('\n');
}

const topOf = (a) => (a.type === 'pin' ? a.y : (a.rects && a.rects[0] ? a.rects[0].y : 0));

export async function exportNotes() {
  if (!state.annotations.length) return toast('No notes to export yet.');
  const base = (state.docName || 'document').replace(/\.pdf$/i, '');
  const saved = await window.api.exportNotes(`${base} — notes.md`, buildMarkdown());
  if (saved) toast(`Exported to ${saved.split('/').pop()}`);
}
