/**
 * KeyMap.js
 * Central registry for ALL keyboard shortcuts (SPEC.md Section 6.3).
 * No component should add its own keydown listeners for shortcuts.
 * Modal open state disables Undo/Redo.
 */

import { eventBus } from './EventBus.js';

const SHORTCUTS = [
  // File
  { key: 'o',           ctrl: true,               action: 'open' },
  { key: 's',           ctrl: true, shift: true,   action: 'save-as' },
  { key: 'w',           ctrl: true,               action: 'close' },

  // Edit
  { key: 'z',           ctrl: true,               action: 'undo',        undoable: true },
  { key: 'y',           ctrl: true,               action: 'redo',        undoable: true },
  { key: 'z',           ctrl: true, shift: true,   action: 'redo',        undoable: true },
  { key: 'a',           ctrl: true,               action: 'select-all' },
  { key: 'Delete',                                 action: 'delete' },

  // View
  { key: '=',           ctrl: true,               action: 'zoom-in' },
  { key: '+',           ctrl: true,               action: 'zoom-in' },
  { key: '-',           ctrl: true,               action: 'zoom-out' },
  { key: '0',           ctrl: true,               action: 'fit-width' },
  { key: '0',           ctrl: true, shift: true,   action: 'fit-page' },
  { key: 'F6',                                     action: 'toggle-sidebar' },
  { key: 'F7',                                     action: 'toggle-inspector' },

  // Navigation
  { key: 'ArrowLeft',                              action: 'page-prev' },
  { key: 'ArrowRight',                             action: 'page-next' },

  // Tools
  { key: 'v',                                      action: 'tool-select' },
  { key: 'Escape',                                 action: 'tool-select' },
  { key: 'h',                                      action: 'tool-highlight' },
  { key: 'd',                                      action: 'tool-draw' },
  { key: 't',                                      action: 'tool-text' },
  { key: 'r',                                      action: 'tool-rect' },
];

class KeyMap {
  #modalDepth = 0;  // modal open/close counter

  init() {
    document.addEventListener('keydown', (e) => this.#handle(e));
    eventBus.on('modal:open',  () => this.#modalDepth++);
    eventBus.on('modal:close', () => this.#modalDepth = Math.max(0, this.#modalDepth - 1));
  }

  #handle(e) {
    // Don't intercept shortcuts when typing in inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
      // Allow Escape from inputs
      if (e.key !== 'Escape') return;
    }

    for (const sc of SHORTCUTS) {
      if (this.#matches(e, sc)) {
        // Block undoable shortcuts when modal is open
        if (sc.undoable && this.#modalDepth > 0) continue;

        e.preventDefault();
        eventBus.emit('ui:action', { action: sc.action, source: 'keyboard' });
        return;
      }
    }
  }

  #matches(e, sc) {
    if (e.key.toLowerCase() !== sc.key.toLowerCase() && e.key !== sc.key) return false;
    if (!!sc.ctrl  !== e.ctrlKey)  return false;
    if (!!sc.shift !== e.shiftKey) return false;
    if (!!sc.alt   !== e.altKey)   return false;
    return true;
  }
}

export const keyMap = new KeyMap();
export default KeyMap;
