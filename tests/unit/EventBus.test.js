import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// EventBus is a module singleton — import the class to test in isolation
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EventBusPath = join(__dirname, '../../src/js/core/EventBus.js');

// Dynamically import the module
const { default: EventBus } = await import(pathToFileURL(EventBusPath).href);

describe('EventBus', () => {
  it('emits to a single handler', () => {
    const bus = new EventBus();
    let received = null;
    bus.on('test', (p) => { received = p; });
    bus.emit('test', { x: 42 });
    assert.deepEqual(received, { x: 42 });
  });

  it('emits to multiple handlers on same event', () => {
    const bus = new EventBus();
    const results = [];
    bus.on('ev', (p) => results.push('a:' + p));
    bus.on('ev', (p) => results.push('b:' + p));
    bus.emit('ev', 1);
    assert.deepEqual(results, ['a:1', 'b:1']);
  });

  it('off() removes a specific handler', () => {
    const bus = new EventBus();
    let count = 0;
    const h = () => count++;
    bus.on('x', h);
    bus.emit('x');
    bus.off('x', h);
    bus.emit('x');
    assert.equal(count, 1);
  });

  it('on() returns unsubscribe function', () => {
    const bus = new EventBus();
    let count = 0;
    const unsub = bus.on('x', () => count++);
    bus.emit('x');
    unsub();
    bus.emit('x');
    assert.equal(count, 1);
  });

  it('does not throw when emitting with no handlers', () => {
    const bus = new EventBus();
    assert.doesNotThrow(() => bus.emit('nonexistent', {}));
  });

  it('handler errors do not affect other handlers', () => {
    const bus = new EventBus();
    let secondCalled = false;
    bus.on('ev', () => { throw new Error('intentional'); });
    bus.on('ev', () => { secondCalled = true; });
    assert.doesNotThrow(() => bus.emit('ev'));
    assert.ok(secondCalled);
  });

  it('clear() removes all handlers for an event', () => {
    const bus = new EventBus();
    let count = 0;
    bus.on('ev', () => count++);
    bus.on('ev', () => count++);
    bus.clear('ev');
    bus.emit('ev');
    assert.equal(count, 0);
  });
});
