'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { app } = require('electron');
const { execFile, execFileSync } = require('child_process');
const media = require('./media');

/**
 * Neural text-to-speech, fully offline once installed.
 *
 * macOS's premium voices are good but capped; these are Piper models — the
 * open neural voices used by Home Assistant — which sound close to a human
 * reader. The engine binary and each voice are downloaded once from their
 * official homes (GitHub and Hugging Face), then everything runs locally.
 * Every voice has a hosted sample so it can be auditioned before committing
 * to a 60–120 MB download.
 */

// The engine is sherpa-onnx rather than the piper CLI: piper's own macOS
// arm64 release is broken upstream (an x86_64 binary with its dylibs missing),
// while sherpa-onnx ships a working native build and hosts every Piper voice
// as one self-contained archive — model, tokens and espeak data together.
const ENGINE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.6/sherpa-onnx-v1.13.6-onnxruntime-1.17.1-osx-arm64-shared.tar.bz2';
const MODELS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';
const SAMPLES = 'https://rhasspy.github.io/piper-samples/samples';

const CATALOG = [
  { id: 'ryan',  label: 'Ryan — American male',   hint: 'Deep, even, the classic audiobook read', quality: 'high',   mb: 115, dir: 'en/en_US/ryan/high',   file: 'en_US-ryan-high' },
  { id: 'amy',   label: 'Amy — American female',  hint: 'Warm and easy-going',                    quality: 'medium', mb: 64,  dir: 'en/en_US/amy/medium',  file: 'en_US-amy-medium' },
  { id: 'lessac',label: 'Lessac — American female', hint: 'Crisp, newsreader-clear',              quality: 'medium', mb: 64,  dir: 'en/en_US/lessac/medium', file: 'en_US-lessac-medium' },
  { id: 'cori',  label: 'Cori — British female',  hint: 'Bright RP English',                      quality: 'high',   mb: 115, dir: 'en/en_GB/cori/high',   file: 'en_GB-cori-high' },
  { id: 'alan',  label: 'Alan — British male',    hint: 'Measured northern English',              quality: 'medium', mb: 64,  dir: 'en/en_GB/alan/medium', file: 'en_GB-alan-medium' },
  { id: 'alba',  label: 'Alba — Scottish female', hint: 'Soft Edinburgh lilt',                    quality: 'medium', mb: 64,  dir: 'en/en_GB/alba/medium', file: 'en_GB-alba-medium' }
];

const engineDir = () => path.join(app.getPath('userData'), 'tts-engine');
const voicesDir = () => path.join(app.getPath('userData'), 'voices');
const voiceDir = (v) => path.join(voicesDir(), `vits-piper-${v.file}`);

/** The extracted archive's top folder carries its version; find the CLI inside. */
function engineBin() {
  try {
    for (const entry of fs.readdirSync(engineDir())) {
      const candidate = path.join(engineDir(), entry, 'bin', 'sherpa-onnx-offline-tts');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* not installed */ }
  return null;
}

const engineInstalled = () => !!engineBin();
const voiceInstalled = (v) => {
  try {
    const d = voiceDir(v);
    return fs.statSync(path.join(d, `${v.file}.onnx`)).size > 10_000_000
      && fs.existsSync(path.join(d, 'tokens.txt'));
  } catch { return false; }
};

async function status() {
  // A broken earlier attempt used the piper CLI; clear its leftovers quietly.
  fsp.rm(path.join(app.getPath('userData'), 'piper'), { recursive: true, force: true }).catch(() => {});
  return {
    engine: engineInstalled(),
    engineMb: 19,
    voices: CATALOG.map((v) => ({ ...v, installed: voiceInstalled(v) }))
  };
}

/* ------------------------------------------------------------ downloads */

async function fetchTo(url, dest, onProgress, signal) {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(`${dest}.part`);
  const reader = res.body.getReader();
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    if (onProgress && Date.now() - last > 200) {
      last = Date.now();
      onProgress({ got, total });
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  await fsp.rename(`${dest}.part`, dest);
  return got;
}

async function installEngine(onProgress, signal) {
  if (engineInstalled()) return true;
  const tarball = path.join(engineDir(), 'engine.tar.bz2');
  await fetchTo(ENGINE_URL, tarball, onProgress, signal);
  execFileSync('/usr/bin/tar', ['-xjf', tarball, '-C', engineDir()]);
  await fsp.rm(tarball, { force: true });
  const bin = engineBin();
  if (!bin) throw new Error('Engine unpacked but the binary is missing.');
  await fsp.chmod(bin, 0o755).catch(() => {});
  return true;
}

async function installVoice(id, onProgress, signal) {
  const v = CATALOG.find((x) => x.id === id);
  if (!v) throw new Error('Unknown voice');
  // The engine rides along with the first voice.
  if (!engineInstalled()) {
    await installEngine((p) => onProgress && onProgress({ ...p, stage: 'engine' }), signal);
  }
  const tarball = path.join(voicesDir(), `${v.file}.tar.bz2`);
  await fetchTo(`${MODELS}/vits-piper-${v.file}.tar.bz2`, tarball,
    (p) => onProgress && onProgress({ ...p, stage: 'voice' }), signal);
  execFileSync('/usr/bin/tar', ['-xjf', tarball, '-C', voicesDir()]);
  await fsp.rm(tarball, { force: true });
  if (!voiceInstalled(v)) throw new Error('Voice unpacked but its files are missing.');
  return true;
}

async function removeVoice(id) {
  const v = CATALOG.find((x) => x.id === id);
  if (!v) return false;
  await fsp.rm(voiceDir(v), { recursive: true, force: true });
  return true;
}

/** A ~1 MB hosted sample, so a voice can be heard before it is downloaded. */
async function preview(id) {
  const v = CATALOG.find((x) => x.id === id);
  if (!v) throw new Error('Unknown voice');
  const dest = path.join(media.mediaDir(), `preview-${v.id}.mp3`);
  if (!fs.existsSync(dest)) {
    await media.ensureDir();
    await fetchTo(`${SAMPLES}/${v.dir}/speaker_0.mp3`, dest, null, null);
  }
  return `sludge-media://${encodeURIComponent(path.basename(dest))}`;
}

/* ------------------------------------------------------------ synthesis */

const cache = new Map();   // hash -> filename
const MAX_CACHE = 40;

async function synth({ voiceId, text, rate = 1 }) {
  const v = CATALOG.find((x) => x.id === voiceId);
  if (!v) throw new Error('Unknown voice');
  if (!engineInstalled() || !voiceInstalled(v)) throw new Error('Voice not installed');

  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Nothing to say');
  const lengthScale = Math.max(0.4, Math.min(2.5, 1 / (Number(rate) || 1)));
  const key = crypto.createHash('sha1').update(`${v.id}|${lengthScale.toFixed(2)}|${clean}`).digest('hex').slice(0, 20);

  if (cache.has(key)) {
    const name = cache.get(key);
    if (fs.existsSync(path.join(media.mediaDir(), name))) {
      return { url: `sludge-media://${name}`, cached: true };
    }
    cache.delete(key);
  }

  await media.ensureDir();
  const name = `tts-${key}.wav`;
  const out = path.join(media.mediaDir(), name);

  const bin = engineBin();
  const d = voiceDir(v);
  await new Promise((resolve, reject) => {
    execFile(bin, [
      `--vits-model=${path.join(d, `${v.file}.onnx`)}`,
      `--vits-tokens=${path.join(d, 'tokens.txt')}`,
      `--vits-data-dir=${path.join(d, 'espeak-ng-data')}`,
      `--vits-length-scale=${lengthScale}`,
      `--output-filename=${out}`,
      clean
    ], {
      timeout: 90000,
      env: { ...process.env, DYLD_LIBRARY_PATH: path.join(path.dirname(bin), '..', 'lib') }
    }, (err) => (err ? reject(err) : resolve()));
  });

  cache.set(key, name);
  // Keep the cache from eating the disk one page at a time.
  if (cache.size > MAX_CACHE) {
    const [oldKey, oldName] = cache.entries().next().value;
    cache.delete(oldKey);
    fsp.rm(path.join(media.mediaDir(), oldName), { force: true }).catch(() => {});
  }
  return { url: `sludge-media://${name}`, cached: false };
}

module.exports = { status, installVoice, removeVoice, preview, synth, CATALOG };
