import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/TextMarkup.js')).href;
const {
  groupTextRunsIntoLines,
  normalizeTextRun,
  resolveTextMarkupSelection,
} = await import(modulePath);

describe('TextMarkup', () => {
  it('normalizes text runs into stable bounding boxes', () => {
    const run = normalizeTextRun(
      {
        str: 'OpenSpec',
        transform: [12, 0, 0, 12, 100, 200],
        width: 64,
        height: 12,
      },
      { ascent: 0.8, descent: -0.2 },
    );

    assert.equal(run.left, 100);
    assert.equal(run.right, 164);
    assert.ok(Math.abs(run.bottom - 197.6) < 0.001);
    assert.ok(Math.abs(run.top - 209.6) < 0.001);
  });

  it('groups runs on the same line together', () => {
    const lines = groupTextRunsIntoLines([
      { left: 10, right: 40, top: 100, bottom: 88, width: 30, height: 12, centerY: 94 },
      { left: 50, right: 90, top: 99, bottom: 87, width: 40, height: 12, centerY: 93 },
      { left: 10, right: 30, top: 70, bottom: 58, width: 20, height: 12, centerY: 64 },
    ]);

    assert.equal(lines.length, 2);
    assert.equal(lines[0].runs.length, 2);
    assert.equal(lines[1].runs.length, 1);
  });

  it('resolves highlight selections per text line', () => {
    const selection = resolveTextMarkupSelection([
      { left: 10, right: 40, top: 100, bottom: 88, width: 30, height: 12, centerY: 94 },
      { left: 48, right: 92, top: 100, bottom: 88, width: 44, height: 12, centerY: 94 },
      { left: 10, right: 30, top: 70, bottom: 58, width: 20, height: 12, centerY: 64 },
    ], {
      x: 0,
      y: 80,
      width: 120,
      height: 30,
    }, 'highlight');

    assert.equal(selection.length, 1);
    assert.deepEqual(selection[0].geometry, {
      x: 10,
      y: 88,
      width: 82,
      height: 12,
    });
  });

  it('resolves underline selections from text bounds', () => {
    const selection = resolveTextMarkupSelection([
      { left: 20, right: 120, top: 150, bottom: 136, width: 100, height: 14, centerY: 143 },
    ], {
      x: 18,
      y: 134,
      width: 104,
      height: 18,
    }, 'underline');

    assert.equal(selection.length, 1);
    assert.equal(selection[0].geometry.x1, 20);
    assert.equal(selection[0].geometry.x2, 120);
    assert.ok(selection[0].geometry.y1 > 136);
    assert.ok(selection[0].strokeWidth >= 1);
  });
});
