import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import classes (not singletons) for isolation
const ebPath   = pathToFileURL(join(__dirname, '../../src/js/core/EventBus.js')).href;
const csPath   = pathToFileURL(join(__dirname, '../../src/js/core/CommandStack.js')).href;

// We need a fresh EventBus per test to avoid singleton bleed
// Import the module and access the class
const { default: EventBus, eventBus } = await import(ebPath);
const { default: CommandStack }       = await import(csPath);

function makeCmd(label, log) {
  return {
    execute: () => log.push(`exec:${label}`),
    undo:    () => log.push(`undo:${label}`),
    description: label,
    estimatedBytes: 10,
  };
}

describe('CommandStack', () => {
  it('execute() runs command and adds to history', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    assert.deepEqual(log, ['exec:A']);
    assert.ok(cs.canUndo);
    assert.ok(!cs.canRedo);
  });

  it('undo() calls undo and enables redo', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    cs.undo();
    assert.deepEqual(log, ['exec:A', 'undo:A']);
    assert.ok(!cs.canUndo);
    assert.ok(cs.canRedo);
  });

  it('redo() re-executes undone command', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    cs.undo();
    cs.redo();
    assert.deepEqual(log, ['exec:A', 'undo:A', 'exec:A']);
    assert.ok(cs.canUndo);
    assert.ok(!cs.canRedo);
  });

  it('execute() after undo clears redo stack', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    cs.undo();
    cs.execute(makeCmd('B', log));
    assert.ok(!cs.canRedo);
    assert.deepEqual(log, ['exec:A', 'undo:A', 'exec:B']);
  });

  it('multiple undo/redo in sequence', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    cs.execute(makeCmd('B', log));
    cs.undo();
    cs.undo();
    assert.deepEqual(log, ['exec:A', 'exec:B', 'undo:B', 'undo:A']);
    cs.redo();
    cs.redo();
    assert.deepEqual(log, ['exec:A', 'exec:B', 'undo:B', 'undo:A', 'exec:A', 'exec:B']);
  });

  it('respects MAX_HISTORY limit (100)', () => {
    const cs = new CommandStack();
    const log = [];
    for (let i = 0; i < 105; i++) {
      cs.execute(makeCmd(`cmd${i}`, log));
    }
    // Should have max 100 in history
    assert.equal(cs.historyDescription.length, 100);
  });

  it('clear() resets everything', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    cs.clear();
    assert.ok(!cs.canUndo);
    assert.ok(!cs.canRedo);
  });

  it('historyDescription reflects current history', () => {
    const cs = new CommandStack();
    const log = [];
    cs.execute(makeCmd('A', log));
    cs.execute(makeCmd('B', log));
    assert.deepEqual(cs.historyDescription, ['A', 'B']);
  });

  it('record() stores an already-executed command without calling execute()', () => {
    const cs = new CommandStack();
    let executions = 0;

    cs.record({
      execute: () => { executions += 1; },
      undo: () => {},
      description: 'Recorded',
      estimatedBytes: 10,
    });

    assert.equal(executions, 0);
    assert.deepEqual(cs.historyDescription, ['Recorded']);
    assert.ok(cs.canUndo);
  });
});
