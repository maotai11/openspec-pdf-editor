import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import EventBus first (StateManager depends on it)
await import(pathToFileURL(join(__dirname, '../../src/js/core/EventBus.js')).href);
const { default: StateManager } = await import(
  pathToFileURL(join(__dirname, '../../src/js/core/StateManager.js')).href
);

describe('StateManager', () => {
  it('has initial state with idle documentStatus', () => {
    const sm = new StateManager();
    assert.equal(sm.state.documentStatus, 'idle');
  });

  it('patch() merges partial state', () => {
    const sm = new StateManager();
    sm.patch({ currentPage: 5 });
    assert.equal(sm.state.currentPage, 5);
  });

  it('patch() does not mutate original state', () => {
    const sm = new StateManager();
    const before = sm.state;
    sm.patch({ currentPage: 3 });
    assert.equal(before.currentPage, 1); // original snapshot unchanged
  });

  it('subscribe() receives { prev, next, changed }', () => {
    const sm = new StateManager();
    let received = null;
    sm.subscribe((ev) => { received = ev; });
    sm.patch({ zoom: 2.0 });
    assert.ok(received);
    assert.ok(received.changed.includes('zoom'));
    assert.equal(received.next.zoom, 2.0);
    assert.equal(received.prev.zoom, 1.0);
  });

  it('no notification if patch has no real changes', () => {
    const sm = new StateManager();
    let callCount = 0;
    sm.subscribe(() => callCount++);
    sm.patch({ zoom: 1.0 }); // same as initial
    assert.equal(callCount, 0);
  });

  it('unsubscribe() stops notifications', () => {
    const sm = new StateManager();
    let count = 0;
    const h = () => count++;
    sm.subscribe(h);
    sm.patch({ zoom: 1.5 });
    sm.unsubscribe(h);
    sm.patch({ zoom: 2.0 });
    assert.equal(count, 1);
  });

  it('returns shallow copy from .state — external mutation has no effect', () => {
    const sm = new StateManager();
    const s = sm.state;
    s.currentPage = 999;
    assert.equal(sm.state.currentPage, 1);
  });

  it('reset() restores initial state', () => {
    const sm = new StateManager();
    sm.patch({ documentStatus: 'ready', currentPage: 7, zoom: 2.5 });
    sm.reset();
    assert.equal(sm.state.documentStatus, 'idle');
    assert.equal(sm.state.currentPage, 1);
    assert.equal(sm.state.zoom, 1.0);
  });
});
