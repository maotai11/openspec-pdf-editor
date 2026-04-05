/**
 * CanvasLayer.js
 * Owns #canvas-layer-root. Renders PDF pages via pdf.js.
 * Canvas Pool: up to 5 canvases, LRU eviction.
 * Never touched by renderApp.js or AnnotationLayer.
 */

import { eventBus } from '../core/EventBus.js';
import { stateManager } from '../core/StateManager.js';

const POOL_SIZE = 5;

export class CanvasLayer {
  #root       = document.getElementById('canvas-layer-root');
  #layerHost  = document.getElementById('layer-host');
  #engine     = null;   // DocumentEngine ref (set via init)

  // Pool: Map<pageNumber, { canvas, ctx, renderTask }>
  #pool       = new Map();
  #lruOrder   = [];     // array of pageNumbers, oldest first

  #currentPage = 1;
  #zoom        = 1.0;
  #dpr         = window.devicePixelRatio || 1;

  init(documentEngine) {
    this.#engine = documentEngine;

    eventBus.on('document:loaded', ({ pageCount }) => {
      this.#pool.clear();
      this.#lruOrder = [];
      this.#currentPage = 1;
      this.#zoom = stateManager.state.zoom;
      this.render(1);
    });

    eventBus.on('page:navigate', ({ targetPage }) => {
      this.#currentPage = targetPage;
      this.render(targetPage);
    });

    eventBus.on('state:changed', ({ changed, next }) => {
      if (changed.includes('zoom') || changed.includes('zoomMode')) {
        this.#zoom = next.zoom;
        this.#clearPool();
        this.render(this.#currentPage);
      }
    });

    // Rerender on resize
    const resizeObserver = new ResizeObserver(() => {
      if (stateManager.state.documentStatus === 'ready') {
        this.#dpr = window.devicePixelRatio || 1;
        this.#clearPool();
        this.render(this.#currentPage);
      }
    });
    resizeObserver.observe(document.getElementById('editor-stage'));
  }

  async render(pageNumber) {
    if (!this.#engine || this.#engine.pageCount === 0) return;

    const t0 = performance.now();

    try {
      const page = await this.#engine.getPage(pageNumber);
      const canvas = this.#getOrCreateCanvas(pageNumber);
      await this.#renderPageToCanvas(page, canvas);

      // Update layer-host size to match canvas
      this.#layerHost.style.width  = canvas.style.width;
      this.#layerHost.style.height = canvas.style.height;

      // Show correct canvas, hide others
      for (const [pn, entry] of this.#pool) {
        entry.canvas.style.display = pn === pageNumber ? 'block' : 'none';
      }

      const renderTime = Math.round(performance.now() - t0);
      eventBus.emit('page:rendered', { pageNumber, renderTime });
    } catch (err) {
      console.error('[CanvasLayer] Render failed:', err);
    }

    // Pre-render adjacent pages (low priority)
    requestIdleCallback(() => {
      const prev = pageNumber - 1;
      const next = pageNumber + 1;
      if (prev >= 1 && !this.#pool.has(prev)) this.#prerender(prev);
      if (next <= this.#engine.pageCount && !this.#pool.has(next)) this.#prerender(next);
    });
  }

  async #prerender(pageNumber) {
    if (!this.#engine || this.#pool.has(pageNumber)) return;
    try {
      const page = await this.#engine.getPage(pageNumber);
      const canvas = this.#getOrCreateCanvas(pageNumber);
      canvas.style.display = 'none';
      await this.#renderPageToCanvas(page, canvas);
    } catch {
      // Pre-render failure is non-fatal
    }
  }

  async #renderPageToCanvas(page, canvas) {
    const viewport = this.#getViewport(page);
    const { width, height } = viewport;

    // Set physical pixel size
    canvas.width  = Math.round(width  * this.#dpr);
    canvas.height = Math.round(height * this.#dpr);

    // Set CSS display size
    canvas.style.width  = `${Math.round(width)}px`;
    canvas.style.height = `${Math.round(height)}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(this.#dpr, this.#dpr);

    const renderContext = { canvasContext: ctx, viewport };
    const task = page.render(renderContext);

    // Store task so it can be cancelled on pool eviction
    const entry = this.#pool.get(this.#getPageFromCanvas(canvas));
    if (entry) entry.renderTask = task;

    await task.promise;
  }

  #getViewport(page) {
    const state = stateManager.state;
    let scale = state.zoom;

    if (state.zoomMode === 'fitWidth') {
      const stageWidth = document.getElementById('editor-stage').clientWidth - 48;
      const naturalVp = page.getViewport({ scale: 1 });
      scale = stageWidth / naturalVp.width;
    } else if (state.zoomMode === 'fitPage') {
      const stage = document.getElementById('editor-stage');
      const stageW = stage.clientWidth - 48;
      const stageH = stage.clientHeight - 48;
      const naturalVp = page.getViewport({ scale: 1 });
      scale = Math.min(stageW / naturalVp.width, stageH / naturalVp.height);
    }

    return page.getViewport({ scale });
  }

  #getOrCreateCanvas(pageNumber) {
    if (this.#pool.has(pageNumber)) {
      // Refresh LRU position
      this.#lruOrder = this.#lruOrder.filter(p => p !== pageNumber);
      this.#lruOrder.push(pageNumber);
      return this.#pool.get(pageNumber).canvas;
    }

    // Evict if at capacity
    if (this.#pool.size >= POOL_SIZE) {
      const evictPage = this.#lruOrder.shift();
      const evicted = this.#pool.get(evictPage);
      evicted?.renderTask?.cancel?.();
      evicted?.canvas?.remove();
      this.#pool.delete(evictPage);
    }

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:none; border-radius:4px; box-shadow:0 2px 12px oklch(0% 0 0/0.15)';
    this.#root.appendChild(canvas);

    this.#pool.set(pageNumber, { canvas, ctx: null, renderTask: null });
    this.#lruOrder.push(pageNumber);

    return canvas;
  }

  #getPageFromCanvas(canvas) {
    for (const [pn, entry] of this.#pool) {
      if (entry.canvas === canvas) return pn;
    }
    return null;
  }

  #clearPool() {
    for (const [, entry] of this.#pool) {
      entry.renderTask?.cancel?.();
      entry.canvas?.remove();
    }
    this.#pool.clear();
    this.#lruOrder = [];
  }

  /** Returns current page dimensions in CSS pixels (for AnnotationLayer sync). */
  getPageDimensions() {
    const entry = this.#pool.get(this.#currentPage);
    if (!entry?.canvas) return { width: 0, height: 0 };
    return {
      width: parseInt(entry.canvas.style.width),
      height: parseInt(entry.canvas.style.height),
    };
  }
}

export const canvasLayer = new CanvasLayer();
