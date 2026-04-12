import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bindBufferedTextCommit,
  flushPendingTextCommits,
} from '../../src/js/core/TextFieldCommit.js';

function createMockTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      const current = listeners.get(type) ?? [];
      current.push(handler);
      listeners.set(type, current);
    },
    removeEventListener(type, handler) {
      const current = listeners.get(type) ?? [];
      listeners.set(type, current.filter((entry) => entry !== handler));
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) {
        handler(event);
      }
    },
    contains(target) {
      return target === this;
    },
  };
}

describe('bindBufferedTextCommit', () => {
  it('commits the latest value when clicking outside before blur-driven teardown', async () => {
    const input = createMockTarget();
    const documentTarget = createMockTarget();
    input.value = '原始';
    const commits = [];

    const binding = bindBufferedTextCommit(input, {
      documentTarget,
      onCommit(value) {
        commits.push(value);
      },
    });

    input.value = '第一行\n第二行';
    documentTarget.dispatch('pointerdown', { target: createMockTarget() });
    binding.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(commits, ['第一行\n第二行']);
  });

  it('does not commit when the pointer event stays inside the active editor', async () => {
    const input = createMockTarget();
    const documentTarget = createMockTarget();
    input.value = '內容';
    const commits = [];

    const binding = bindBufferedTextCommit(input, {
      documentTarget,
      onCommit(value) {
        commits.push(value);
      },
    });

    input.value = '更新中';
    documentTarget.dispatch('pointerdown', { target: input });
    await new Promise((resolve) => setTimeout(resolve, 10));
    binding.cleanup({ cancelPending: true });

    assert.deepEqual(commits, []);
  });

  it('can cancel a pending commit when the edit is explicitly discarded', async () => {
    const input = createMockTarget();
    const documentTarget = createMockTarget();
    input.value = '舊值';
    const commits = [];

    const binding = bindBufferedTextCommit(input, {
      documentTarget,
      onCommit(value) {
        commits.push(value);
      },
    });

    input.value = '不要保存';
    documentTarget.dispatch('pointerdown', { target: createMockTarget() });
    binding.cleanup({ cancelPending: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(commits, []);
  });

  it('flushes unblurred edits so session persistence can capture the latest value', () => {
    const input = createMockTarget();
    const documentTarget = createMockTarget();
    input.value = '第一行';
    const commits = [];

    const binding = bindBufferedTextCommit(input, {
      documentTarget,
      onCommit(value) {
        commits.push(value);
      },
    });

    input.value = '第一行\n第二行';
    const didCommit = flushPendingTextCommits();
    binding.cleanup();

    assert.equal(didCommit, true);
    assert.deepEqual(commits, ['第一行\n第二行']);
  });
});
