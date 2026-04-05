#!/usr/bin/env node
/**
 * build.js
 * Bundles src/js/app.js → dist/js/app.bundle.js (IIFE, no ES module imports at runtime)
 * This is required for file:// compatibility — Chrome blocks <script type="module"> on file://.
 * Also copies css/ and generates integrity.json.
 */

import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC  = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// Ensure dist structure exists
mkdirSync(join(DIST, 'js'),  { recursive: true });
mkdirSync(join(DIST, 'css'), { recursive: true });
mkdirSync(join(DIST, 'lib'), { recursive: true });

// Bundle src/js/app.js → dist/js/app.bundle.js (IIFE)
// All ES module imports are resolved at build time — no runtime imports needed.
// External globals: window.pdfjsLib, window.PDFLib, window.fflate (loaded via <script> tags)
await build({
  entryPoints: [join(SRC, 'js', 'app.js')],
  bundle:      true,
  format:      'iife',
  outfile:     join(DIST, 'js', 'app.bundle.js'),
  platform:    'browser',
  target:      ['chrome115'],
  loader: {
    '.ttf': 'binary',
  },
  // These globals are loaded via <script> tags in index.html — do not bundle them
  external:    [],
  define: {},
  logLevel: 'warning',
});
console.log('  BUNDLE  src/js/app.js → dist/js/app.bundle.js');

// Copy src/css → dist/css
cpSync(join(SRC, 'css'), join(DIST, 'css'), { recursive: true });
console.log('  COPY    src/css → dist/css');

// Copy src/index.html → dist/index.html
cpSync(join(SRC, 'index.html'), join(DIST, 'index.html'));
console.log('  COPY    src/index.html → dist/index.html');

// Generate integrity.json
console.log('  GEN     integrity.json');
execSync('node scripts/gen-integrity.js', { cwd: ROOT, stdio: 'inherit' });

console.log('\nBuild complete → dist/');
