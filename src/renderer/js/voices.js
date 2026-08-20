/**
 * Voice selection.
 *
 * macOS ships a pile of novelty and legacy voices — Bells, Zarvox, Albert — and
 * hides the good ones behind a download in System Settings. This narrows the
 * list to the four the reader actually wants (US and UK, male and female),
 * picks the best installed voice for each, and can tell when only the old
 * robotic set is present so the app can offer to fix that.
 */

// Novelty and singing voices: never appropriate for reading a textbook.
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|junior|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|princess|bruce|agnes|kathy|ralph|fred|grandma|grandpa|rocko|sandy|shelley|eddy|flo|reed)\b/i;

// Apple's higher-quality tiers, best first. Premium ≈ neural, Enhanced ≈ better
// concatenative, plain ≈ the old robotic ones.
const TIER = [
  { rx: /\(premium\)|premium/i, rank: 3, label: 'Premium' },
  { rx: /\(enhanced\)|enhanced/i, rank: 2, label: 'Enhanced' },
  { rx: /siri/i, rank: 3, label: 'Siri' }
];

// Known-good names per accent and gender, best first.
const CATALOGUE = [
  { id: 'us-female', label: 'American · female', lang: /^en[-_]US/i, names: ['ava', 'allison', 'samantha', 'susan', 'zoe', 'joelle', 'nicky'] },
  { id: 'us-male',   label: 'American · male',   lang: /^en[-_]US/i, names: ['tom', 'evan', 'nathan', 'aaron', 'alex'] },
  { id: 'gb-female', label: 'British · female',  lang: /^en[-_]GB/i, names: ['serena', 'kate', 'stephanie', 'martha'] },
  { id: 'gb-male',   label: 'British · male',    lang: /^en[-_]GB/i, names: ['daniel', 'oliver', 'jamie', 'malcolm', 'arthur'] }
];

function tierOf(voice) {
  const name = `${voice.name} ${voice.voiceURI}`;
  for (const t of TIER) if (t.rx.test(name)) return t;
  return { rank: 1, label: 'Basic' };
}

const baseName = (voice) => String(voice.name)
  .replace(/\s*\((premium|enhanced|english[^)]*)\)\s*/gi, '')
  .trim()
  .toLowerCase();

/**
 * Reduce the system list to one voice per category, preferring the highest
 * quality tier and then the most natural-sounding name we know of.
 */
export function pickVoices(all = []) {
  const english = all.filter((v) => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name));
  const out = [];

  for (const slot of CATALOGUE) {
    const candidates = english.filter((v) => slot.lang.test(v.lang));
    let best = null;
    let bestScore = -1;

    for (const v of candidates) {
      const nameIndex = slot.names.indexOf(baseName(v));
      if (nameIndex < 0) continue;
      const tier = tierOf(v);
      // Quality tier dominates; among equals, prefer the earlier known name.
      const score = tier.rank * 100 + (slot.names.length - nameIndex);
      if (score > bestScore) {
        bestScore = score;
        best = { ...slot, voice: v, tier };
      }
    }
    if (best) out.push(best);
  }

  return out;
}

/** True when every chosen voice is still the old robotic tier. */
export function needsBetterVoices(chosen = []) {
  if (!chosen.length) return true;
  return chosen.every((c) => c.tier.rank <= 1);
}

/** Anything English that isn't a novelty, for the "show all" escape hatch. */
export function allEnglish(all = []) {
  return all
    .filter((v) => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name))
    .sort((a, b) => tierOf(b).rank - tierOf(a).rank || a.name.localeCompare(b.name));
}

export const describeVoice = (entry) =>
  `${entry.label}${entry.tier.rank > 1 ? ` · ${entry.tier.label}` : ''} — ${entry.voice.name.replace(/\s*\(English \([^)]*\)\)/i, '')}`;
