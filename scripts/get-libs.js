#!/usr/bin/env node
/**
 * get-libs.js
 * Downloads and vendors all required libraries into dist/lib/
 * Run once before building: npm run get-libs
 */

import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { get } from 'https';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', 'dist', 'lib');

mkdirSync(LIB_DIR, { recursive: true });

// pdfjs-dist v3 = last version with UMD build (window.pdfjsLib global)
// pdf-lib v1.17.1 = stable, MIT, UMD global (window.PDFLib)
// fflate v0.8 = UMD global (window.fflate)
const LIBS = [
  {
    name: 'pdf.min.js',
    url: 'https://unpkg.com/pdfjs-dist@3/build/pdf.min.js',
  },
  {
    name: 'pdf.worker.min.js',
    url: 'https://unpkg.com/pdfjs-dist@3/build/pdf.worker.min.js',
  },
  {
    name: 'pdf-lib.min.js',
    url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  },
  {
    name: 'fflate.min.js',
    url: 'https://unpkg.com/fflate@0.8.2/umd/index.js',
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    function fetchUrl(u) {
      get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Resolve relative redirect URLs against the original host
          const location = res.headers.location;
          const next = location.startsWith('http')
            ? location
            : new URL(location, u).href;
          fetchUrl(next);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        pipeline(res, file).then(resolve).catch(reject);
      }).on('error', reject);
    }
    fetchUrl(url);
  });
}

console.log('Downloading libraries to dist/lib/ ...\n');

for (const lib of LIBS) {
  const dest = join(LIB_DIR, lib.name);
  if (existsSync(dest)) {
    console.log(`  SKIP  ${lib.name} (already exists)`);
    continue;
  }
  process.stdout.write(`  GET   ${lib.name} ... `);
  try {
    await download(lib.url, dest);
    console.log('OK');
  } catch (err) {
    console.log(`FAIL\n        ${err.message}`);
    process.exit(1);
  }
}

console.log('\nAll libraries ready.');
