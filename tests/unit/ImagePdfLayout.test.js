import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/ImagePdfLayout.js')).href;
const {
  mmToPt,
  resolveImageDrawLayout,
  resolveMarginPt,
  resolveTargetPageSize,
} = await import(modulePath);

describe('ImagePdfLayout', () => {
  it('converts standard margin presets to points', () => {
    assert.equal(resolveMarginPt({ preset: 'none' }), 0);
    assert.ok(Math.abs(resolveMarginPt({ preset: 'standard' }) - mmToPt(10)) < 0.001);
    assert.ok(Math.abs(resolveMarginPt({ preset: 'custom', customMm: 15 }) - mmToPt(15)) < 0.001);
  });

  it('resolves original page size from pixels and dpi', () => {
    const page = resolveTargetPageSize({
      pageSize: 'original',
      imageWidthPx: 3000,
      imageHeightPx: 1500,
      dpi: 300,
      marginPt: 18,
    });

    assert.ok(Math.abs(page.width - (720 + 36)) < 0.001);
    assert.ok(Math.abs(page.height - (360 + 36)) < 0.001);
  });

  it('rotates fit-page output to landscape for wide images', () => {
    const page = resolveTargetPageSize({
      pageSize: 'fit-page',
      imageWidthPx: 2400,
      imageHeightPx: 1200,
      dpi: 150,
      marginPt: 0,
    });

    assert.ok(page.width > page.height);
  });

  it('fits images inside target pages without exceeding margins', () => {
    const draw = resolveImageDrawLayout({
      pageWidthPt: 595.28,
      pageHeightPt: 841.89,
      imageWidthPx: 2400,
      imageHeightPx: 1800,
      dpi: 150,
      marginPt: 24,
    });

    assert.ok(draw.x >= 24);
    assert.ok(draw.y >= 24);
    assert.ok(draw.width <= 595.28 - 48 + 0.001);
    assert.ok(draw.height <= 841.89 - 48 + 0.001);
  });
});
