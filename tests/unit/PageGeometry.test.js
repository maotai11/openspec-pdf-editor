import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/PageGeometry.js')).href;
const {
  getVisualViewport,
  pdfPointToScreen,
  pdfRectToScreenRect,
  screenPointToPdf,
  screenRectToPdfRect,
  visualEdgeInsetsToPdfEdgeInsets,
  visualLayoutPointToPdf,
} = await import(modulePath);

describe('PageGeometry', () => {
  it('round-trips points for rotated cropped pages', () => {
    const viewport = {
      pageWidthPt: 200,
      pageHeightPt: 100,
      originXPt: 25,
      originYPt: 40,
      rotation: 90,
      screenWidth: 500,
      screenHeight: 1000,
    };
    const original = { x: 60, y: 110 };
    const screen = pdfPointToScreen(original, viewport);
    const roundTrip = screenPointToPdf(screen, viewport);

    assert.ok(Math.abs(roundTrip.x - original.x) < 0.001);
    assert.ok(Math.abs(roundTrip.y - original.y) < 0.001);
  });

  it('round-trips rectangles for rotated cropped pages', () => {
    const viewport = {
      pageWidthPt: 180,
      pageHeightPt: 240,
      originXPt: 10,
      originYPt: 20,
      rotation: 270,
      screenWidth: 900,
      screenHeight: 600,
    };
    const original = { x: 40, y: 70, width: 80, height: 90 };
    const screen = pdfRectToScreenRect(original, viewport);
    const roundTrip = screenRectToPdfRect(screen, viewport);

    assert.ok(Math.abs(roundTrip.x - original.x) < 0.001);
    assert.ok(Math.abs(roundTrip.y - original.y) < 0.001);
    assert.ok(Math.abs(roundTrip.width - original.width) < 0.001);
    assert.ok(Math.abs(roundTrip.height - original.height) < 0.001);
  });

  it('maps visual layout coordinates into rotated pdf coordinates', () => {
    const viewport = getVisualViewport({
      pageWidthPt: 200,
      pageHeightPt: 100,
      originXPt: 10,
      originYPt: 20,
      rotation: 90,
    });

    const pdfPoint = visualLayoutPointToPdf({ x: 100, y: 50 }, viewport);

    assert.ok(Math.abs(pdfPoint.x - 160) < 0.001);
    assert.ok(Math.abs(pdfPoint.y - 120) < 0.001);
  });

  it('maps visual crop edges into pdf crop edges for rotated pages', () => {
    assert.deepEqual(
      visualEdgeInsetsToPdfEdgeInsets({ top: 10, right: 20, bottom: 30, left: 40 }, { rotation: 90 }),
      { top: 20, right: 30, bottom: 40, left: 10 },
    );
    assert.deepEqual(
      visualEdgeInsetsToPdfEdgeInsets({ top: 10, right: 20, bottom: 30, left: 40 }, { rotation: 180 }),
      { top: 30, right: 40, bottom: 10, left: 20 },
    );
    assert.deepEqual(
      visualEdgeInsetsToPdfEdgeInsets({ top: 10, right: 20, bottom: 30, left: 40 }, { rotation: 270 }),
      { top: 40, right: 10, bottom: 20, left: 30 },
    );
  });
});
