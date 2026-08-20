#!/usr/bin/env node
'use strict';
/**
 * Copy the pieces of pdfjs-dist the app loads at runtime into vendor/.
 * The renderer runs with a strict CSP and no bundler, so it imports these
 * files directly rather than reaching into node_modules.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const out = path.join(root, 'vendor', 'pdfjs');

if (!fs.existsSync(src)) {
  console.error('vendor-pdfjs: pdfjs-dist is not installed — run npm install first.');
  process.exit(0);
}

fs.mkdirSync(out, { recursive: true });

const files = [
  ['build/pdf.min.mjs', 'pdf.mjs'],
  ['build/pdf.worker.min.mjs', 'pdf.worker.mjs']
];
for (const [from, to] of files) {
  fs.copyFileSync(path.join(src, from), path.join(out, to));
}

// cmaps and standard fonts let the viewer render CJK text and PDFs that omit
// their base-14 fonts, without any network access.
for (const dir of ['cmaps', 'standard_fonts']) {
  fs.rmSync(path.join(out, dir), { recursive: true, force: true });
  fs.cpSync(path.join(src, dir), path.join(out, dir), { recursive: true });
}

console.log('vendor-pdfjs: pdf.js assets copied to vendor/pdfjs');
