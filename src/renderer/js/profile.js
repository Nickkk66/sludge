import { $, el } from './util.js';
import { state, emit } from './state.js';

/**
 * Who's reading.
 *
 * Asked once, on first launch. The answers do two things: they let the app
 * greet you by name and offer the book you were in the middle of, and they get
 * folded into the local model's system prompt so its answers fit how you read.
 * Nothing here leaves the machine.
 */

const STYLE_HINT = {
  brief: 'Answer in as few words as the question allows. Lead with the answer; skip preamble and restatement.',
  explain: 'Give the answer, then a short, concrete explanation of why. Prefer plain language over jargon.',
  study: 'Answer, then push the reader: add a follow-up question that checks whether they actually understood it.'
};

export const profile = {
  name: '',
  purpose: '',
  style: 'explain',
  onboarded: false
};

export function loadProfile(settings) {
  Object.assign(profile, {
    name: settings.profileName || '',
    purpose: settings.profilePurpose || '',
    style: settings.profileStyle || 'explain',
    onboarded: settings.onboarded === true
  });
  return profile;
}

async function saveProfile() {
  state.settings = await window.api.settings.set({
    profileName: profile.name,
    profilePurpose: profile.purpose,
    profileStyle: profile.style,
    onboarded: true
  });
  profile.onboarded = true;
  emit('profile:changed', profile);
}

/** The bit handed to the model, or null when there's nothing worth saying. */
export function profilePrompt() {
  const bits = [];
  if (profile.name) bits.push(`The reader's name is ${profile.name}.`);
  if (profile.purpose) bits.push(`They are reading this for: ${profile.purpose}.`);
  if (STYLE_HINT[profile.style]) bits.push(STYLE_HINT[profile.style]);
  return bits.length ? bits.join(' ') : null;
}

/* ------------------------------------------------------------ onboarding */

export function showOnboarding() {
  const modal = $('#onboardModal');
  $('#obName').value = profile.name;
  $('#obPurpose').value = profile.purpose;
  $('#obStyle').value = profile.style;
  modal.classList.remove('hidden');
  setTimeout(() => $('#obName').focus(), 60);
}

function closeOnboarding() {
  $('#onboardModal').classList.add('hidden');
}

/** Change how answers come back, without reopening the first-run questions. */
export async function setAnswerStyle(style) {
  if (!STYLE_HINT[style]) return;
  profile.style = style;
  state.settings = await window.api.settings.set({ profileStyle: style });
  emit('profile:changed', profile);
}

export function initProfile() {
  const styleSelect = $('#answerStyle');
  styleSelect.value = profile.style;
  styleSelect.addEventListener('change', (e) => setAnswerStyle(e.target.value));
  // Keep the ribbon control and the first-run answer in step.
  emit('profile:ready', profile);

  $('#obSave').addEventListener('click', async () => {
    profile.name = $('#obName').value.trim();
    profile.purpose = $('#obPurpose').value.trim();
    profile.style = $('#obStyle').value;
    await saveProfile();
    $('#answerStyle').value = profile.style;
    closeOnboarding();
    renderGreeting();
  });

  $('#obSkip').addEventListener('click', async () => {
    // Skipping still counts as answered, so it isn't asked again every launch.
    await saveProfile();
    closeOnboarding();
    renderGreeting();
  });

  $('#onboardModal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      $('#obSave').click();
    }
  });
}

/* ------------------------------------------------------------ greeting */

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Greet by name and offer the book that was open last. */
export async function renderGreeting() {
  const heading = $('#welcomeGreeting');
  const sub = $('#welcomeSub');
  const resume = $('#welcomeResume');

  heading.textContent = profile.name ? `${timeGreeting()}, ${profile.name}.` : 'Sludge';

  const lib = await window.api.library.list().catch(() => ({ docs: [] }));
  const last = lib.docs && lib.docs[0];

  if (last) {
    const title = last.title || last.name.replace(/\.pdf$/i, '');
    sub.textContent = profile.name
      ? `Want to keep reading ${title}?`
      : `Pick up where you left off in ${title}.`;
    resume.hidden = false;
    $('#resumeName').textContent = title;
    $('#resumeMeta').textContent = [
      last.lastPage ? `page ${last.lastPage}` : null,
      last.pages ? `of ${last.pages}` : null,
      last.noteCount ? `· ${last.noteCount} notes` : null
    ].filter(Boolean).join(' ');
    const cover = $('#resumeCover');
    cover.style.backgroundImage = last.thumb ? `url("${last.thumb}")` : '';
    $('#resumeBtn').onclick = () => emit('doc:request', last.path);
  } else {
    resume.hidden = true;
    sub.textContent = profile.name
      ? 'Open a PDF and I’ll read it, mark it up, and answer questions about it — all on this machine.'
      : 'Read a PDF, highlight it, keep your notes together, and ask a local AI about both — all offline.';
  }
}
