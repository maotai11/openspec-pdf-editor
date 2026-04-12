import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/WorkflowAsync.js')).href;
const {
  createFileScopedValueCache,
  createLatestAsyncRunner,
} = await import(modulePath);

describe('WorkflowAsync', () => {
  it('caches values per file object instead of file name', async () => {
    const cache = createFileScopedValueCache();
    const firstFile = { name: 'same-name.png', size: 1 };
    const secondFile = { name: 'same-name.png', size: 2 };
    const calls = [];

    const first = await cache.get(firstFile, async (file) => {
      calls.push(file.size);
      return { width: 100, height: 200 };
    });
    const second = await cache.get(secondFile, async (file) => {
      calls.push(file.size);
      return { width: 300, height: 400 };
    });

    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(first, { width: 100, height: 200 });
    assert.deepEqual(second, { width: 300, height: 400 });
  });

  it('reuses the cached value when the same file object is requested twice', async () => {
    const cache = createFileScopedValueCache();
    const file = { name: 'single.png', size: 1 };
    let calls = 0;

    const first = await cache.get(file, async () => {
      calls += 1;
      return { width: 640, height: 480 };
    });
    const second = await cache.get(file, async () => {
      calls += 1;
      return { width: 800, height: 600 };
    });

    assert.equal(calls, 1);
    assert.deepEqual(first, { width: 640, height: 480 });
    assert.deepEqual(second, { width: 640, height: 480 });
  });

  it('marks older async results as stale when a newer task completes later', async () => {
    const runLatest = createLatestAsyncRunner();

    let releaseFirst;
    const firstPromise = runLatest(async () => new Promise((resolve) => {
      releaseFirst = () => resolve('first');
    }));
    const secondPromise = runLatest(async () => 'second');
    releaseFirst();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.deepEqual(first, { stale: true, value: 'first' });
    assert.deepEqual(second, { stale: false, value: 'second' });
  });
});
