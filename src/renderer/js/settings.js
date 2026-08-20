import { $, el, toast, setChildren, confirmAction } from './util.js';
import { state, emit, COLORS } from './state.js';
import { profile, setAnswerStyle } from './profile.js';
import { speech, getVoices, getAllVoices, setRate, setVoice, voicesAreBasic, refreshVoices } from './speech.js';
import { describeVoice } from './voices.js';
import { describeModel } from './ai.js';
import { startTour } from './tour.js';

/**
 * One place for everything adjustable.
 *
 * Controls had accumulated across four ribbon tabs, a colour bar, a status bar
 * and two modals. They still live where they're used, but this is the single
 * screen you can go to when you know what you want to change and not where it is.
 */

let section = 'you';
let models = [];

export const setSettingsModels = (list) => { models = list || []; };

const SECTIONS = [
  { id: 'you', label: 'You' },
  { id: 'reading', label: 'Reading & voice' },
  { id: 'ai', label: 'Local AI' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'video', label: 'Brainrot' },
  { id: 'data', label: 'Files & updates' }
];

/* ------------------------------------------------------------ helpers */

const row = (title, hint, ...controls) => el('div', { class: 'set-row' },
  el('div', { class: 'set-label' }, el('b', {}, title), hint ? el('small', {}, hint) : null),
  el('div', { class: 'set-control' }, ...controls)
);

const toggle = (checked, onChange) => {
  const input = el('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
  input.checked = !!checked;
  return el('label', { class: 'switch' }, input, el('span', {}));
};

const group = (title, hint, ...rows) => el('div', { class: 'set-group' },
  el('h4', {}, title),
  hint ? el('p', { class: 'set-hint' }, hint) : null,
  ...rows
);

const save = async (patch) => { state.settings = await window.api.settings.set(patch); };

/* ------------------------------------------------------------ sections */

function paneYou() {
  const name = el('input', { type: 'text', value: profile.name, placeholder: 'Gilbert', maxlength: '40' });
  const purpose = el('input', { type: 'text', value: profile.purpose, placeholder: 'AP US History — exam in May', maxlength: '120' });
  const commit = async () => {
    profile.name = name.value.trim();
    profile.purpose = purpose.value.trim();
    await save({ profileName: profile.name, profilePurpose: profile.purpose });
    emit('profile:changed', profile);
  };
  name.addEventListener('change', commit);
  purpose.addEventListener('change', commit);

  return group('You', 'Kept on this machine. Used to greet you, and given to the local model so its answers fit how you read.',
    row('Name', 'What the app and the AI call you', name),
    row('Reading for', 'Gives the model context for what matters to you', purpose),
    row('Answer style', 'How the AI pitches its replies',
      el('select', {
        onchange: (e) => setAnswerStyle(e.target.value)
      },
        el('option', { value: 'brief', selected: profile.style === 'brief' }, 'Short and direct'),
        el('option', { value: 'explain', selected: profile.style === 'explain' }, 'Explain it'),
        el('option', { value: 'study', selected: profile.style === 'study' }, 'Study mode — quiz me')
      ))
  );
}

function paneReading() {
  const curated = getVoices();
  const all = getAllVoices();
  const rate = el('input', {
    type: 'range', min: '0.5', max: '2.5', step: '0.05', value: String(speech.rate),
    oninput: (e) => { rateLabel.textContent = `${Number(e.target.value).toFixed(2).replace(/0$/, '')}×`; },
    onchange: (e) => setRate(e.target.value)
  });
  const rateLabel = el('b', { style: { minWidth: '38px' } }, `${Number(speech.rate).toFixed(2).replace(/0$/, '')}×`);

  return el('div', {},
    group('Voice', voicesAreBasic()
      ? 'Your Mac only has the old robotic voices installed. The natural ones are a free download.'
      : 'Four choices, best quality first. The full system list is there if you want it.',
      row('Voice', 'American and British, male and female',
        el('select', {
          onchange: (e) => setVoice(e.target.value)
        },
          ...curated.map((c) => el('option', { value: c.voice.voiceURI, selected: c.voice.voiceURI === speech.voiceURI }, describeVoice(c))),
          el('optgroup', { label: 'Everything else' },
            ...all.map((v) => el('option', { value: v.voiceURI, selected: v.voiceURI === speech.voiceURI }, `${v.name} (${v.lang})`)))
        )),
      row('Speed', 'Applies from the next sentence', rate, rateLabel),
      voicesAreBasic()
        ? row('Better voices', 'Walks you through adding Apple’s natural voices',
            el('button', { onclick: () => { close(); $('#voiceModal').classList.remove('hidden'); } }, 'Show me how'))
        : row('Recheck voices', 'After downloading a new one',
            el('button', { onclick: () => { refreshVoices(); toast('Voice list refreshed.'); } }, 'Recheck'))
    ),
    group('Caption panel', 'The floating panel showing what is being read.',
      row('Show captions', 'One sentence at a time, word by word',
        toggle(state.settings.teleprompter !== false, async (on) => {
          $('#spShowText').checked = on;
          $('#spShowText').dispatchEvent(new Event('change'));
        })),
      row('Text size', 'Bigger is easier to follow from across the room',
        el('select', {
          onchange: (e) => {
            document.documentElement.style.setProperty('--tp-size', `${e.target.value}px`);
            save({ teleprompterSize: Number(e.target.value) });
          }
        }, ...[15, 17, 19, 23, 28, 34, 40].map((n) => el('option', {
          value: String(n), selected: String(n) === String(state.settings.teleprompterSize || 19)
        }, `${n}px`)))),
      row('Follow along', 'Scrolls the page to keep up with the voice',
        toggle(speech.followScroll, (on) => { speech.followScroll = on; $('#spFollow').checked = on; }))
    )
  );
}

function paneAi() {
  const list = models.length ? models : [];
  return group('Local AI', 'Runs through Ollama on this machine. Nothing is sent anywhere.',
    row('Chat model', 'Answers questions about the document and your notes',
      list.length
        ? el('select', {
            onchange: async (e) => {
              state.aiModel = e.target.value;
              await save({ aiModel: e.target.value });
              const sel = $('#modelSelect');
              if (sel) sel.value = e.target.value;
            }
          }, ...list.map((m) => el('option', { value: m.name, selected: m.name === state.aiModel }, describeModel(m))))
        : el('span', { class: 'set-path' }, 'No models found — is Ollama running?')),
    row('Scan model', 'Used for the full-document read. Bigger is much better here.',
      list.length
        ? el('select', {
            onchange: (e) => save({ scanModel: e.target.value })
          }, ...list.map((m) => el('option', { value: m.name, selected: m.name === state.settings.scanModel }, describeModel(m))))
        : el('span', { class: 'set-path' }, '—')),
    row('Clear this document’s scan', 'Forces a fresh read next time',
      el('button', {
        class: 'danger',
        onclick: async () => {
          if (!state.docId) return toast('No document open.');
          await window.api.scan.clear(state.docId);
          toast('Scan cleared.');
        }
      }, 'Clear'))
  );
}

function paneAppearance() {
  return group('Appearance', null,
    row('Theme', 'Dark or light chrome',
      el('select', {
        onchange: (e) => { if ((e.target.value === 'dark') !== (state.theme === 'dark')) $('#themeToggle').click(); }
      },
        el('option', { value: 'dark', selected: state.theme === 'dark' }, 'Night'),
        el('option', { value: 'light', selected: state.theme !== 'dark' }, 'Day'))),
    row('Invert the PDF', 'Turns a white page dark without touching your highlights',
      toggle(state.invert, (on) => {
        if (on !== state.invert) emit('settings:invert', on);
      })),
    row('Ask before highlighting', 'Opens the note editor straight after a highlight',
      toggle(state.autoNote, async (on) => {
        state.autoNote = on;
        $('#autoNote').checked = on;
        await save({ autoNote: on });
      })),
    row('Default highlight colour', null,
      el('div', { class: 'set-control' }, ...COLORS.map((c) => el('button', {
        class: `swatch${c.hex === state.color ? ' active' : ''}`,
        style: { background: c.hex, width: '20px', height: '20px', borderRadius: '50%', padding: '0' },
        title: c.name,
        onclick: async (e) => {
          state.color = c.hex;
          document.documentElement.style.setProperty('--swatch', c.hex);
          await save({ defaultColor: c.hex });
          for (const n of e.currentTarget.parentElement.children) n.classList.remove('active');
          e.currentTarget.classList.add('active');
        }
      }))))
  );
}

function paneVideo() {
  return group('Brainrot', 'The looping gameplay strip. It never starts on its own — you turn it on each session.',
    row('Manage video packs', 'Download, switch or remove them',
      el('button', { onclick: () => { close(); $('#btnFocus').click(); } }, 'Open')),
    row('Default edge', 'Where the strip appears when you turn it on',
      el('select', {
        onchange: (e) => save({ focusDock: e.target.value })
      }, ...['bottom', 'top', 'left', 'right'].map((d) => el('option', {
        value: d, selected: d === (state.settings.focusDock || 'bottom')
      }, d[0].toUpperCase() + d.slice(1))))),
    row('Media folder', 'Where downloaded packs are kept',
      el('button', { onclick: () => window.api.media.reveal() }, 'Show'))
  );
}

function paneData() {
  return el('div', {},
    group('Your files', 'Notes live in a plain .notes.json beside each PDF. The PDF itself is never modified.',
      row('Show this document’s notes file', null,
        el('button', {
          onclick: () => {
            if (!state.filePath) return toast('No document open.');
            window.api.revealSidecar(state.filePath, state.docId);
          }
        }, 'Show')),
      row('Export notes', 'Every highlight and note as Markdown',
        el('button', { onclick: () => { close(); $('#btnExport').click(); } }, 'Export'))
    ),
    group('App', null,
      row('Run the walkthrough again', 'The tour you got on first launch',
        el('button', { onclick: () => { close(); setTimeout(() => startTour(), 250); } }, 'Start tour')),
      row('Check for updates', 'Opens the release page if there is a newer build',
        el('button', {
          onclick: async () => {
            const info = await window.api.update.check();
            if (info.upToDate) toast(`You're on the latest build (${info.current}).`);
            else window.api.update.open(info.url);
          }
        }, 'Check')),
      row('Version', null, el('span', { class: 'set-path', id: 'setVersion' }, '—'))
    )
  );
}

const PANES = {
  you: paneYou,
  reading: paneReading,
  ai: paneAi,
  appearance: paneAppearance,
  video: paneVideo,
  data: paneData
};

/* ------------------------------------------------------------ shell */

function render() {
  setChildren($('#settingsNav'), ...SECTIONS.map((s) => el('button', {
    class: section === s.id ? 'on' : '',
    onclick: () => { section = s.id; render(); }
  }, s.label)));

  const build = PANES[section] || paneYou;
  setChildren($('#settingsPane'), build());

  if (section === 'data') {
    window.api.update.version().then((v) => {
      const node = $('#setVersion');
      if (node) node.textContent = `Sludge ${v}`;
    }).catch(() => {});
  }
}

export function openSettings(which) {
  if (which) section = which;
  $('#settingsModal').classList.remove('hidden');
  render();
}

function close() {
  $('#settingsModal').classList.add('hidden');
}

export function initSettings() {
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#settingsClose').addEventListener('click', close);
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') close();
  });
}
