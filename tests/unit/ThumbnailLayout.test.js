import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/ThumbnailLayout.js')).href;
const { resolveThumbnailViewport } = await import(modulePath);

describe('ThumbnailLayout', () => {
  it('caps portrait thumbnails to the configured preview box', () => {
    const layout = resolveThumbnailViewport({
      pageWidth: 595,
      pageHeight: 842,
      maxWidth: 96,
      maxHeight: 136,
    });

    assert.equal(layout.width, 96);
    assert.equal(layout.height, 136);
  });

  it('keeps landscape thumbnails within the same preview box', () => {
    const layout = resolveThumbnailViewport({
      pageWidth: 842,
      pageHeight: 595,
      maxWidth: 96,
      maxHeight: 136,
    });

    assert.equal(layout.width, 96);
    assert.equal(layout.height, 68);
  });
});
