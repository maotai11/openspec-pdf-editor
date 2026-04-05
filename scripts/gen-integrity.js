#!/usr/bin/env node
/**
 * gen-integrity.js
 * Generates dist/integrity.json with SHA-256 hashes of all dist/ files.
 * IT/security teams can verify the package was not tampered with.
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function walk(dir, base = dir) {
  const entries = readdirSync(dir);
  const results = {};
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(base, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) {
      Object.assign(results, walk(full, base));
    } else if (entry !== 'integrity.json') {
      const bytes = statSync(full).size;
      results[rel] = { sha256: sha256(full), bytes };
    }
  }
  return results;
}

const manifest = {
  version: process.env.npm_package_version ?? '0.1.0',
  generatedAt: new Date().toISOString(),
  files: walk(DIST),
};

writeFileSync(join(DIST, 'integrity.json'), JSON.stringify(manifest, null, 2));
console.log(`  integrity.json: ${Object.keys(manifest.files).length} files`);
