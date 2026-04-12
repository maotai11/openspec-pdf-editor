import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/SignaturePreview.js')).href;
const { resolveSignaturePreviewDataUrl } = await import(modulePath);

describe('SignaturePreview', () => {
  it('keeps typed signatures unchanged even when background removal is requested', async () => {
    const result = await resolveSignaturePreviewDataUrl({
      mode: 'typed',
      dataUrl: 'data:image/png;base64,typed',
      removeBackground: true,
      removeWhiteBackground: async () => 'data:image/png;base64,changed',
    });

    assert.equal(result, 'data:image/png;base64,typed');
  });

  it('keeps drawn/image signatures unchanged when background removal is disabled', async () => {
    const result = await resolveSignaturePreviewDataUrl({
      mode: 'image',
      dataUrl: 'data:image/png;base64,raw',
      removeBackground: false,
      removeWhiteBackground: async () => 'data:image/png;base64,changed',
    });

    assert.equal(result, 'data:image/png;base64,raw');
  });

  it('applies background removal to image previews when requested', async () => {
    const calls = [];
    const result = await resolveSignaturePreviewDataUrl({
      mode: 'image',
      dataUrl: 'data:image/png;base64,raw',
      removeBackground: true,
      removeWhiteBackground: async (dataUrl) => {
        calls.push(dataUrl);
        return 'data:image/png;base64,transparent';
      },
    });

    assert.deepEqual(calls, ['data:image/png;base64,raw']);
    assert.equal(result, 'data:image/png;base64,transparent');
  });
});
