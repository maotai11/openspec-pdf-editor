import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/LayoutPresets.js')).href;
const { resolveImageWatermarkLayout, resolvePageNumberLayout, resolveWatermarkLayout } = await import(modulePath);

describe('LayoutPresets', () => {
  it('keeps bottom-center page number centered', () => {
    const layout = resolvePageNumberLayout({
      pageWidth: 595,
      pageHeight: 842,
      position: 'bottom-center',
      text: '12',
      fontSize: 10,
      marginPt: 20,
    });
    assert.ok(layout.text.x > 285 && layout.text.x < 300);
    assert.equal(layout.text.y, 20);
  });

  it('keeps page number with timestamp inside the bottom margin block', () => {
    const layout = resolvePageNumberLayout({
      pageWidth: 595,
      pageHeight: 842,
      position: 'bottom-center',
      text: '12',
      fontSize: 10,
      marginPt: 20,
      includeTimestamp: true,
      timestampText: '2026-04-05 09:30',
    });

    assert.equal(layout.block.y, 20);
    assert.ok(layout.timestamp.y >= layout.block.y);
    assert.ok(layout.text.y > layout.timestamp.y);
    assert.ok((layout.block.y + layout.block.height) < 60);
  });

  it('places top-right watermark near the top-right corner', () => {
    const layout = resolveWatermarkLayout({
      pageWidth: 595,
      pageHeight: 842,
      position: 'top-right',
      text: '草稿',
      fontSize: 60,
    });
    assert.ok(layout.x > 450);
    assert.ok(layout.y > 700);
  });

  it('places image watermarks near the requested corner', () => {
    const layout = resolveImageWatermarkLayout({
      pageWidth: 842,
      pageHeight: 595,
      position: 'bottom-right',
      imageWidth: 1200,
      imageHeight: 600,
      scale: 0.3,
    });

    assert.ok(layout.x > 500);
    assert.ok(layout.y < 80);
    assert.ok(layout.width > layout.height);
  });
});
