/**
 * AnnotationLayer.js
 * Owns #annotation-layer-root (SVG). Handles annotation tools and rendering.
 * All geometry stored in PDF coordinate space (pts, bottom-left origin).
 * Never touched by renderApp.js or CanvasLayer.
 */

import { eventBus } from '../core/EventBus.js';
import { stateManager } from '../core/StateManager.js';
import { commandStack } from '../core/CommandStack.js';

// UUID v4 (browser-native)
function uuid() {
  return crypto.randomUUID();
}

export class AnnotationLayer {
  #root       = document.getElementById('annotation-layer-root');
  #svg        = null;
  #canvasLayer = null;  // ref for coordinate transforms

  // In-memory store: pageNumber -> AnnotationModel[]
  #annotations = new Map();
  #currentPage = 1;

  // Drawing state
  #isDrawing   = false;
  #drawStart   = null;
  #tempEl      = null;
  #activePath  = [];    // for freehand draw

  // Selection state
  #selectedIds = new Set();

  // Viewport info (updated on each render)
  #viewport    = { scale: 1, offsetX: 0, offsetY: 0, pageWidthPt: 595, pageHeightPt: 842 };

  init(canvasLayer) {
    this.#canvasLayer = canvasLayer;
    this.#buildSVG();
    this.#bindEvents();

    eventBus.on('document:loaded', () => {
      this.#annotations.clear();
      this.#currentPage = 1;
      this.#selectedIds.clear();
      this.#redraw();
    });

    eventBus.on('page:navigate', ({ targetPage }) => {
      this.#currentPage = targetPage;
      this.#selectedIds.clear();
      this.#redraw();
    });

    eventBus.on('page:rendered', ({ pageNumber }) => {
      if (pageNumber === this.#currentPage) {
        this.#syncSize();
        this.#redraw();
      }
    });

    // External annotation changes (from Undo/Redo or SessionDB restore)
    eventBus.on('annotations:replace', ({ pageNumber, annotations }) => {
      this.#annotations.set(pageNumber, annotations);
      if (pageNumber === this.#currentPage) this.#redraw();
    });
  }

  /** Restore annotations from SessionDB. */
  restoreAnnotations(allAnnotations) {
    this.#annotations.clear();
    for (const ann of allAnnotations) {
      if (!this.#annotations.has(ann.pageNumber)) {
        this.#annotations.set(ann.pageNumber, []);
      }
      this.#annotations.get(ann.pageNumber).push(ann);
    }
    this.#redraw();
  }

  /** Returns all annotations across all pages (for save/export). */
  getAllAnnotations() {
    const all = [];
    for (const arr of this.#annotations.values()) all.push(...arr);
    return all;
  }

  // ---- Private: SVG setup ----

  #buildSVG() {
    this.#svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.#svg.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;cursor:crosshair;';
    this.#svg.setAttribute('aria-hidden', 'true');
    this.#root.appendChild(this.#svg);
  }

  #syncSize() {
    const dims = this.#canvasLayer.getPageDimensions();
    this.#svg.style.width  = `${dims.width}px`;
    this.#svg.style.height = `${dims.height}px`;
    this.#svg.setAttribute('viewBox', `0 0 ${dims.width} ${dims.height}`);
  }

  // ---- Private: Event binding ----

  #bindEvents() {
    this.#svg.addEventListener('pointerdown',  (e) => this.#onPointerDown(e));
    this.#svg.addEventListener('pointermove',  (e) => this.#onPointerMove(e));
    this.#svg.addEventListener('pointerup',    (e) => this.#onPointerUp(e));
    this.#svg.addEventListener('pointerleave', (e) => this.#onPointerUp(e));
  }

  #onPointerDown(e) {
    const tool = stateManager.state.selectedTool;
    if (tool === 'select') {
      this.#handleSelectDown(e);
      return;
    }
    this.#isDrawing = true;
    this.#drawStart = this.#svgPoint(e);
    this.#activePath = [this.#drawStart];

    if (tool === 'draw') {
      this.#tempEl = this.#makeTempPath();
      this.#svg.appendChild(this.#tempEl);
    } else {
      this.#tempEl = this.#makeTempShape(tool);
      this.#svg.appendChild(this.#tempEl);
    }

    this.#svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  #onPointerMove(e) {
    if (!this.#isDrawing || !this.#tempEl) return;
    const pt = this.#svgPoint(e);
    const tool = stateManager.state.selectedTool;

    if (tool === 'draw') {
      this.#activePath.push(pt);
      this.#tempEl.setAttribute('d', this.#buildPathD(this.#activePath));
    } else {
      const x = Math.min(this.#drawStart.x, pt.x);
      const y = Math.min(this.#drawStart.y, pt.y);
      const w = Math.abs(pt.x - this.#drawStart.x);
      const h = Math.abs(pt.y - this.#drawStart.y);

      if (tool === 'highlight' || tool === 'rect') {
        this.#tempEl.setAttribute('x', x);
        this.#tempEl.setAttribute('y', y);
        this.#tempEl.setAttribute('width', w);
        this.#tempEl.setAttribute('height', h);
      }
    }
    e.preventDefault();
  }

  #onPointerUp(e) {
    if (!this.#isDrawing) return;
    this.#isDrawing = false;

    const tool = stateManager.state.selectedTool;
    const end  = this.#svgPoint(e);

    // Ignore tiny movements (accidental clicks)
    const dx = Math.abs(end.x - this.#drawStart.x);
    const dy = Math.abs(end.y - this.#drawStart.y);

    if (this.#tempEl) {
      this.#tempEl.remove();
      this.#tempEl = null;
    }

    const minSize = tool === 'draw' ? 5 : 10;
    if (dx < minSize && dy < minSize && tool !== 'text') return;

    const annotation = this.#buildAnnotation(tool, end);
    if (!annotation) return;

    // Create undoable command
    const cmd = {
      execute: () => this.#addAnnotation(annotation),
      undo:    () => this.#removeAnnotation(annotation.id, annotation.pageNumber),
      description: `新增 ${this.#toolLabel(tool)}`,
      estimatedBytes: JSON.stringify(annotation).length * 2,
    };
    commandStack.execute(cmd);

    // Trigger save
    eventBus.emit('annotations:changed');
    e.preventDefault();
  }

  // ---- Private: Annotation construction ----

  #buildAnnotation(tool, endPt) {
    const now = new Date().toISOString();
    const base = { id: uuid(), type: tool, pageNumber: this.#currentPage, createdAt: now, modifiedAt: now };

    const sx = Math.min(this.#drawStart.x, endPt.x);
    const sy = Math.min(this.#drawStart.y, endPt.y);
    const sw = Math.abs(endPt.x - this.#drawStart.x);
    const sh = Math.abs(endPt.y - this.#drawStart.y);

    const svgToPdf = (sx, sy, sw, sh) => ({
      x: this.#screenToPdfX(sx),
      y: this.#screenToPdfY(sy + sh), // PDF y-axis is flipped
      width:  this.#screenToPdfDim(sw),
      height: this.#screenToPdfDim(sh),
    });

    switch (tool) {
      case 'highlight':
        return { ...base, geometry: svgToPdf(sx, sy, sw, sh), style: { color: '#FFFF00', opacity: 0.4 } };
      case 'rect':
        return { ...base, geometry: svgToPdf(sx, sy, sw, sh), style: { color: '#0066CC', opacity: 1, strokeWidth: 1.5 } };
      case 'draw':
        return {
          ...base,
          geometry: { pathData: this.#buildPathD(this.#activePath) },
          style: { color: '#CC0000', opacity: 1, strokeWidth: 2 },
        };
      case 'text':
        return {
          ...base,
          geometry: { x: this.#screenToPdfX(this.#drawStart.x), y: this.#screenToPdfY(this.#drawStart.y) },
          style: { color: '#000000', opacity: 1, fontSize: 12 },
          content: '文字印章',
        };
      default:
        return null;
    }
  }

  // ---- Private: Annotation management ----

  #addAnnotation(ann) {
    if (!this.#annotations.has(ann.pageNumber)) {
      this.#annotations.set(ann.pageNumber, []);
    }
    this.#annotations.get(ann.pageNumber).push(ann);
    if (ann.pageNumber === this.#currentPage) this.#redraw();
  }

  #removeAnnotation(id, pageNumber) {
    const arr = this.#annotations.get(pageNumber) ?? [];
    const idx = arr.findIndex(a => a.id === id);
    if (idx !== -1) arr.splice(idx, 1);
    if (pageNumber === this.#currentPage) this.#redraw();
  }

  // ---- Private: Rendering ----

  #redraw() {
    // Clear existing annotation elements (keep defs if any)
    while (this.#svg.firstChild) this.#svg.removeChild(this.#svg.firstChild);

    const annotations = this.#annotations.get(this.#currentPage) ?? [];
    for (const ann of annotations) {
      const el = this.#renderAnnotation(ann);
      if (el) this.#svg.appendChild(el);
    }
  }

  #renderAnnotation(ann) {
    const { type, geometry, style, id } = ann;
    const selected = this.#selectedIds.has(id);
    const dims = this.#canvasLayer.getPageDimensions();
    if (!dims.width) return null;

    const pdfToSvgX = (x) => (x / this.#viewport.pageWidthPt)  * dims.width;
    const pdfToSvgY = (y) => dims.height - (y / this.#viewport.pageHeightPt) * dims.height;
    const pdfToSvgDim = (d, axis) => (d / (axis === 'w' ? this.#viewport.pageWidthPt : this.#viewport.pageHeightPt)) * (axis === 'w' ? dims.width : dims.height);

    let el;

    if (type === 'highlight' || type === 'rect') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const x = pdfToSvgX(geometry.x);
      const y = pdfToSvgY(geometry.y + geometry.height);
      const w = pdfToSvgDim(geometry.width, 'w');
      const h = pdfToSvgDim(geometry.height, 'h');
      el.setAttribute('x', x);
      el.setAttribute('y', y);
      el.setAttribute('width', w);
      el.setAttribute('height', h);

      if (type === 'highlight') {
        el.setAttribute('fill', style.color);
        el.setAttribute('fill-opacity', style.opacity);
        el.setAttribute('stroke', 'none');
      } else {
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', style.color);
        el.setAttribute('stroke-width', style.strokeWidth ?? 1.5);
        el.setAttribute('stroke-opacity', style.opacity);
      }
    } else if (type === 'draw') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', geometry.pathData);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', style.color);
      el.setAttribute('stroke-width', style.strokeWidth ?? 2);
      el.setAttribute('stroke-opacity', style.opacity);
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
    } else if (type === 'text') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.setAttribute('x', pdfToSvgX(geometry.x));
      el.setAttribute('y', pdfToSvgY(geometry.y));
      el.setAttribute('fill', style.color);
      el.setAttribute('font-size', style.fontSize ?? 12);
      el.setAttribute('font-family', 'system-ui, sans-serif');
      el.textContent = ann.content ?? '';
    }

    if (el) {
      el.setAttribute('data-id', id);
      el.style.cursor = 'pointer';
      if (selected) el.style.outline = '2px solid var(--color-accent)';

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (stateManager.state.selectedTool === 'select') {
          this.#selectedIds.clear();
          this.#selectedIds.add(id);
          stateManager.patch({ selectedAnnotationIds: [id] });
          this.#redraw();
        }
      });
    }

    return el;
  }

  // ---- Private: Temp shape creation ----

  #makeTempShape(tool) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    if (tool === 'highlight') {
      el.setAttribute('fill', '#FFFF00');
      el.setAttribute('fill-opacity', '0.4');
      el.setAttribute('stroke', 'none');
    } else {
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#0066CC');
      el.setAttribute('stroke-width', '1.5');
      el.setAttribute('stroke-dasharray', '4 2');
    }
    el.setAttribute('x', 0); el.setAttribute('y', 0);
    el.setAttribute('width', 0); el.setAttribute('height', 0);
    return el;
  }

  #makeTempPath() {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', '#CC0000');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    return el;
  }

  // ---- Private: Select tool ----

  #handleSelectDown(e) {
    const target = e.target.closest('[data-id]');
    if (!target) {
      this.#selectedIds.clear();
      stateManager.patch({ selectedAnnotationIds: [] });
      this.#redraw();
    }
  }

  // ---- Private: Coordinate helpers ----

  #svgPoint(e) {
    const rect = this.#svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  #screenToPdfX(x) {
    const dims = this.#canvasLayer.getPageDimensions();
    return dims.width ? (x / dims.width) * (this.#viewport.pageWidthPt ?? 595) : x;
  }

  #screenToPdfY(y) {
    const dims = this.#canvasLayer.getPageDimensions();
    return dims.height ? ((dims.height - y) / dims.height) * (this.#viewport.pageHeightPt ?? 842) : y;
  }

  #screenToPdfDim(d) {
    const dims = this.#canvasLayer.getPageDimensions();
    return dims.width ? (d / dims.width) * (this.#viewport.pageWidthPt ?? 595) : d;
  }

  // ---- Private: Helpers ----

  #buildPathD(points) {
    if (points.length < 2) return '';
    const [first, ...rest] = points;
    return `M ${first.x} ${first.y} ` + rest.map(p => `L ${p.x} ${p.y}`).join(' ');
  }

  #toolLabel(tool) {
    return { highlight: '螢光筆', draw: '手繪', text: '文字印章', rect: '矩形框' }[tool] ?? tool;
  }

  /** Set PDF page dimensions (called after DocumentEngine loads a page). */
  setPageDimensions(widthPt, heightPt) {
    this.#viewport.pageWidthPt  = widthPt;
    this.#viewport.pageHeightPt = heightPt;
  }
}

export const annotationLayer = new AnnotationLayer();
