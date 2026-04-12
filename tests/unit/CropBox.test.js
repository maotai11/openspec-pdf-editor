import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/CropBox.js')).href;
const { resolveSafeCropBox } = await import(modulePath);

describe('CropBox', () => {
  it('keeps oversized crop requests inside the original page bounds', () => {
    const cropBox = resolveSafeCropBox(
      { x: 0, y: 0, width: 200, height: 120 },
      { left: 180, right: 120, top: 80, bottom: 60 },
    );

    assert.ok(cropBox.x >= 0);
    assert.ok(cropBox.y >= 0);
    assert.ok(cropBox.width >= 36);
    assert.ok(cropBox.height >= 36);
    assert.ok(cropBox.x + cropBox.width <= 200 + 0.001);
    assert.ok(cropBox.y + cropBox.height <= 120 + 0.001);
  });

  it('scales opposing insets proportionally when they exceed the available space', () => {
    const cropBox = resolveSafeCropBox(
      { x: 10, y: 20, width: 100, height: 80 },
      { left: 40, right: 40, top: 30, bottom: 30 },
      36,
    );

    assert.ok(Math.abs(cropBox.x - 42) < 0.001);
    assert.ok(Math.abs(cropBox.width - 36) < 0.001);
    assert.ok(Math.abs(cropBox.y - 42) < 0.001);
    assert.ok(Math.abs(cropBox.height - 36) < 0.001);
  });
});
