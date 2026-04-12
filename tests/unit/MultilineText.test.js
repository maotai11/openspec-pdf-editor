import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMultilineText,
  splitPreservedLines,
} from '../../src/js/core/MultilineText.js';

describe('MultilineText', () => {
  it('normalizes CRLF and CR line endings into LF', () => {
    assert.equal(normalizeMultilineText('a\r\nb\rc'), 'a\nb\nc');
  });

  it('preserves blank lines instead of collapsing them', () => {
    assert.deepEqual(splitPreservedLines('第一行\n\n第三行'), [
      '第一行',
      '',
      '第三行',
    ]);
  });

  it('returns an empty array for empty content', () => {
    assert.deepEqual(splitPreservedLines(''), []);
  });
});
