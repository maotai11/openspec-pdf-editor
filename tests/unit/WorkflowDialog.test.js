import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/WorkflowDialog.js')).href;
const { resolveDialogSubmission } = await import(modulePath);

describe('WorkflowDialog', () => {
  it('awaits async getValue before validation', async () => {
    const submission = await resolveDialogSubmission({
      async getValue() {
        return { signerName: 'Alice' };
      },
      validate(value) {
        return value.signerName ? '' : 'missing signer';
      },
    });

    assert.equal(submission.validationError, '');
    assert.deepEqual(submission.value, { signerName: 'Alice' });
  });

  it('supports async validation', async () => {
    const submission = await resolveDialogSubmission({
      getValue() {
        return { mode: 'typed' };
      },
      async validate(value) {
        return value.mode === 'typed' ? '' : 'bad mode';
      },
    });

    assert.equal(submission.validationError, '');
    assert.deepEqual(submission.value, { mode: 'typed' });
  });

  it('returns validation errors for resolved values', async () => {
    const submission = await resolveDialogSubmission({
      async getValue() {
        return { signerName: '' };
      },
      validate(value) {
        return value.signerName ? '' : 'missing signer';
      },
    });

    assert.equal(submission.validationError, 'missing signer');
    assert.deepEqual(submission.value, { signerName: '' });
  });
});
