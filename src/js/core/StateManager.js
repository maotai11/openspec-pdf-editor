/**
 * StateManager.js
 * Owns application UI state. Communicates changes via EventBus.
 * Does NOT own PDF binary state (DocumentEngine) or history (CommandStack).
 */

import { eventBus } from './EventBus.js';

/** @type {AppState} */
const INITIAL_STATE = {
  documentStatus: 'idle',   // 'idle' | 'loading' | 'ready' | 'error'
  currentPage: 1,
  pageCount: 0,
  zoom: 1.0,
  zoomMode: 'custom',       // 'custom' | 'fitWidth' | 'fitPage'
  selectedTool: 'select',   // 'select' | 'highlight' | 'underline' | 'draw' | 'text' | 'rect'
  toolHubTab: 'all-tools',
  sidebarOpen: true,
  inspectorOpen: true,
  theme: 'light',           // 'light' | 'dark'
  selectedAnnotationIds: [],
  selectedPageNumbers: [],
  exportDialogOpen: false,
  sessionRestored: false,
  errorMessage: null,
  passwordRequired: false,
};

class StateManager {
  #state = { ...INITIAL_STATE };
  #subscribers = new Set();

  get state() {
    return { ...this.#state }; // return shallow copy — state is read-only outside
  }

  /**
   * Shallow-merge partial state. Emits 'state:changed' with { prev, next, changed }.
   * Transient UI actions (zoom, page navigate) go through patch() but do NOT
   * go through CommandStack — this is intentional.
   */
  patch(partial) {
    const prev = this.#state;
    const next = { ...this.#state, ...partial };
    const changed = Object.keys(partial).filter(k => prev[k] !== next[k]);

    if (changed.length === 0) return;

    this.#state = next;

    for (const sub of this.#subscribers) {
      try {
        sub({ prev, next, changed });
      } catch (err) {
        console.error('[StateManager] subscriber error:', err);
      }
    }

    eventBus.emit('state:changed', { prev, next, changed });
  }

  subscribe(handler) {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  unsubscribe(handler) {
    this.#subscribers.delete(handler);
  }

  reset() {
    this.patch({ ...INITIAL_STATE });
  }
}

export const stateManager = new StateManager();
export default StateManager;
