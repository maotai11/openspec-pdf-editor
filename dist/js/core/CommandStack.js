/**
 * CommandStack.js
 * Undo/Redo command history. Separate from StateManager.
 * Only document mutations (annotation add/delete/update, page reorder/delete/rotate)
 * go through here. UI-only changes (zoom, navigation) do NOT.
 */

import { eventBus } from './EventBus.js';

const MAX_HISTORY = 100;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * @typedef {Object} Command
 * @property {() => void} execute
 * @property {() => void} undo
 * @property {string} description
 * @property {number} estimatedBytes
 */

class CommandStack {
  #history = [];   // [ Command, ... ]  oldest → newest
  #redoStack = [];
  #totalBytes = 0;

  get canUndo() { return this.#history.length > 0; }
  get canRedo() { return this.#redoStack.length > 0; }

  get historyDescription() {
    return this.#history.map(c => c.description);
  }

  get redoDescription() {
    return this.#redoStack.map(c => c.description);
  }

  /** Execute a command, push to history, clear redo stack. */
  execute(cmd) {
    cmd.execute();
    this.#redoStack = [];
    this.#history.push(cmd);
    this.#totalBytes += cmd.estimatedBytes ?? 0;
    this.#enforceLimit();
    this.#emitChange();
  }

  undo() {
    if (!this.canUndo) return;
    const cmd = this.#history.pop();
    this.#totalBytes -= cmd.estimatedBytes ?? 0;
    cmd.undo();
    this.#redoStack.push(cmd);
    this.#emitChange();
  }

  redo() {
    if (!this.canRedo) return;
    const cmd = this.#redoStack.pop();
    cmd.execute();
    this.#history.push(cmd);
    this.#totalBytes += cmd.estimatedBytes ?? 0;
    this.#enforceLimit();
    this.#emitChange();
  }

  clear() {
    this.#history = [];
    this.#redoStack = [];
    this.#totalBytes = 0;
    this.#emitChange();
  }

  #enforceLimit() {
    while (
      this.#history.length > MAX_HISTORY ||
      this.#totalBytes > MAX_BYTES
    ) {
      const oldest = this.#history.shift();
      this.#totalBytes -= oldest?.estimatedBytes ?? 0;
    }
  }

  #emitChange() {
    eventBus.emit('command:stack-changed', {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoDescription: this.#history.at(-1)?.description ?? null,
      redoDescription: this.#redoStack.at(-1)?.description ?? null,
    });
  }
}

export const commandStack = new CommandStack();
export default CommandStack;
