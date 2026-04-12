import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/OpenFilePlan.js')).href;
const { planOpenFiles } = await import(modulePath);

describe('OpenFilePlan', () => {
  const isImageFile = (file) => String(file.type ?? '').startsWith('image/');

  it('classifies multiple pdf files as a batch import', () => {
    const plan = planOpenFiles([
      { name: 'a.pdf', type: 'application/pdf' },
      { name: 'b.pdf', type: 'application/pdf' },
    ], { isImageFile });

    assert.equal(plan.mode, 'multi-pdf');
    assert.equal(plan.pdfFiles.length, 2);
    assert.equal(plan.imageFiles.length, 0);
  });

  it('classifies mixed pdf and image selections separately', () => {
    const plan = planOpenFiles([
      { name: 'a.pdf', type: 'application/pdf' },
      { name: 'cover.png', type: 'image/png' },
    ], { isImageFile });

    assert.equal(plan.mode, 'mixed');
    assert.equal(plan.pdfFiles.length, 1);
    assert.equal(plan.imageFiles.length, 1);
  });
});
