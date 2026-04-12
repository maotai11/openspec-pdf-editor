import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/PageSelection.js')).href;
const { resolveTargetPageNumbers } = await import(modulePath);

describe('DocumentEngine target page resolution', () => {
  it('returns an empty selection when the document has no pages', () => {
    assert.deepEqual(resolveTargetPageNumbers(0, { fromPage: 1, toPage: 3 }, 1), []);
  });

  it('filters and sorts explicit page lists', () => {
    assert.deepEqual(
      resolveTargetPageNumbers(6, { pages: [6, 2, 2, 9, 0, 4] }, 1),
      [2, 4, 6],
    );
  });

  it('clamps fallback and range values into the live page count', () => {
    assert.deepEqual(
      resolveTargetPageNumbers(4, { fromPage: 3, toPage: 9 }, 7),
      [3, 4],
    );
    assert.deepEqual(
      resolveTargetPageNumbers(4, {}, 7),
      [4],
    );
  });

  it('returns an empty selection when explicit pages are all invalid', () => {
    assert.deepEqual(resolveTargetPageNumbers(5, { pages: [0, 8, 99] }, 3), []);
  });
});
