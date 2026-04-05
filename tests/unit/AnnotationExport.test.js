import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/AnnotationExport.js')).href;
const {
  buildArrowHeadSegments,
  buildRectangleOutlineSegments,
  buildRotatedLineSegmentsFromPathData,
  buildStampExportLayout,
  buildTextLineLayouts,
  buildLineSegmentsFromPathData,
  clampPointGeometry,
  getPdfRotationForScreenRotation,
  getPathBounds,
  normalizeLineGeometry,
  normalizeRectGeometry,
  parsePathData,
  rotatePoint,
} = await import(modulePath);

describe('AnnotationExport', () => {
  it('parses move and line commands from stored path data', () => {
    const commands = parsePathData('M 10 20 L 30 40 L 50 60');
    assert.deepEqual(commands, [
      { command: 'M', x: 10, y: 20 },
      { command: 'L', x: 30, y: 40 },
      { command: 'L', x: 50, y: 60 },
    ]);
  });

  it('converts stored path data into bounded line segments', () => {
    const segments = buildLineSegmentsFromPathData('M 10 20 L 30 40 L 900 1200', 100, 200);
    assert.deepEqual(segments, [
      {
        start: { x: 10, y: 20 },
        end: { x: 30, y: 40 },
      },
      {
        start: { x: 30, y: 40 },
        end: { x: 100, y: 200 },
      },
    ]);
  });

  it('clamps rectangle geometry to the page box', () => {
    const rect = normalizeRectGeometry({ x: -10, y: 50, width: 80, height: 500 }, 60, 200);
    assert.deepEqual(rect, {
      x: 0,
      y: 50,
      width: 60,
      height: 150,
    });
  });

  it('clamps rectangle geometry to a cropped page origin', () => {
    const rect = normalizeRectGeometry({ x: 10, y: 30, width: 300, height: 200 }, 120, 80, 40, 60);
    assert.deepEqual(rect, {
      x: 40,
      y: 60,
      width: 120,
      height: 80,
    });
  });

  it('clamps line segments to a cropped page origin', () => {
    const segments = buildLineSegmentsFromPathData('M 10 20 L 50 80 L 500 900', 100, 120, 30, 40);
    assert.deepEqual(segments, [
      {
        start: { x: 30, y: 40 },
        end: { x: 50, y: 80 },
      },
      {
        start: { x: 50, y: 80 },
        end: { x: 130, y: 160 },
      },
    ]);
  });

  it('clamps line geometry to a cropped page origin', () => {
    const line = normalizeLineGeometry({ x1: 10, y1: 20, x2: 400, y2: 500 }, 100, 120, 30, 40);
    assert.deepEqual(line, {
      x1: 30,
      y1: 40,
      x2: 130,
      y2: 160,
    });
  });

  it('clamps text anchors within a cropped page origin', () => {
    const point = clampPointGeometry({ x: 999, y: 20 }, 200, 150, 25, 35, 0, 12);
    assert.deepEqual(point, {
      x: 225,
      y: 47,
    });
  });

  it('rotates a point around a geometry center', () => {
    const point = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    assert.deepEqual(point, {
      x: 0,
      y: 10,
    });
  });

  it('maps screen-space clockwise rotation to pdf-space rotation', () => {
    assert.equal(getPdfRotationForScreenRotation(90), 270);
    assert.equal(getPdfRotationForScreenRotation(270), 90);
  });

  it('returns bounds for stored path data', () => {
    const bounds = getPathBounds('M 10 20 L 30 60 L 15 45');
    assert.deepEqual(bounds, {
      x: 10,
      y: 20,
      width: 20,
      height: 40,
    });
  });

  it('rotates stored draw segments around the path bounds center', () => {
    const segments = buildRotatedLineSegmentsFromPathData('M 10 10 L 30 10', 90, 100, 100);
    assert.deepEqual(segments, [
      {
        start: { x: 20, y: 0 },
        end: { x: 20, y: 20 },
      },
    ]);
  });

  it('builds rotated rectangle outline segments', () => {
    const segments = buildRectangleOutlineSegments({ x: 10, y: 20, width: 40, height: 20 }, 200, 200, 0, 0, 90);
    assert.deepEqual(segments, [
      {
        start: { x: 40, y: 10 },
        end: { x: 40, y: 50 },
      },
      {
        start: { x: 40, y: 50 },
        end: { x: 20, y: 50 },
      },
      {
        start: { x: 20, y: 50 },
        end: { x: 20, y: 10 },
      },
      {
        start: { x: 20, y: 10 },
        end: { x: 40, y: 10 },
      },
    ]);
  });

  it('builds arrow head segments from a line end point', () => {
    const segments = buildArrowHeadSegments({ x: 10, y: 10 }, { x: 50, y: 10 }, 10, 30);
    assert.deepEqual(segments, [
      {
        start: { x: 50, y: 10 },
        end: { x: 41.3397, y: 15 },
      },
      {
        start: { x: 50, y: 10 },
        end: { x: 41.3397, y: 5 },
      },
    ]);
  });

  it('builds rotated text line origins using the same visual rotation direction as the canvas', () => {
    const layouts = buildTextLineLayouts({
      anchor: { x: 100, y: 100 },
      lineWidths: [20, 20],
      lineHeight: 12,
      rotation: 90,
    });

    assert.deepEqual(layouts, [
      {
        x: 100,
        y: 100,
        rotation: 270,
        width: 20,
      },
      {
        x: 88,
        y: 100,
        rotation: 270,
        width: 20,
      },
    ]);
  });

  it('builds stamp divider and centered text layout around the stamp center', () => {
    const layout = buildStampExportLayout(
      { x: 0, y: 0, width: 100, height: 60 },
      {
        rotation: 90,
        lineWidths: [20, 10],
        lineHeight: 19.2,
      },
    );

    assert.deepEqual(layout, {
      center: { x: 50, y: 30 },
      rotation: 270,
      divider: {
        start: { x: 46.4, y: 62 },
        end: { x: 46.4, y: -2 },
      },
      textLines: [
        {
          x: 54.8,
          y: 40,
          rotation: 270,
          width: 20,
        },
        {
          x: 35.6,
          y: 35,
          rotation: 270,
          width: 10,
        },
      ],
    });
  });
});
