/**
 * EventBus.js
 * Singleton pub/sub event bus. No external dependencies.
 * All inter-module communication must go through this.
 */

class EventBus {
  #handlers = new Map(); // event -> Set<handler>

  on(event, handler) {
    if (!this.#handlers.has(event)) {
      this.#handlers.set(event, new Set());
    }
    this.#handlers.get(event).add(handler);
    return () => this.off(event, handler); // returns unsubscribe fn
  }

  off(event, handler) {
    this.#handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const handlers = this.#handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${event}":`, err);
      }
    }
  }

  /** Remove all handlers for an event (useful for cleanup). */
  clear(event) {
    this.#handlers.delete(event);
  }
}

export const eventBus = new EventBus();
export default EventBus;
