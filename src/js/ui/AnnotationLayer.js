/**
 * AnnotationLayer.js
 * Owns #annotation-layer-root (SVG). Handles annotation tools and rendering.
 * All geometry is stored in PDF coordinate space (pts, bottom-left origin).
 */

import { eventBus } from '../core/EventBus.js';
import { stateManager } from '../core/StateManager.js';
import { commandStack } from '../core/CommandStack.js';
import {
  buildArrowHeadSegments,
  getPathBounds,
  normalizeAnnotationRotation,
} from '../core/AnnotationExport.js';
import {
  normalizeRotation,
  pdfPointToScreen,
  pdfRectToScreenRect,
  screenPointToPdf,
  screenRectToPdfRect,
} from '../core/PageGeometry.js';
import { buildSignatureAnnotationContent, buildTypedSignaturePreset } from '../core/SignatureAsset.js';
import { resolveTextMarkupSelection } from '../core/TextMarkup.js';

function uuid() {
  return crypto.randomUUID();
}

const ROTATABLE_ANNOTATION_TYPES = new Set(['text', 'rect', 'draw', 'stamp', 'signature']);
const CONTROLLED_THEME_COLORS = ['#000000', '#666666', '#4472C4', '#5B9BD5', '#70AD47', '#FFC000', '#ED7D31', '#C00000'];
const CONTROLLED_HIGHLIGHT_COLORS = ['#FFF200', '#92D050', '#00B0F0', '#4F81BD', '#FF5050', '#FF66CC'];
const ROTATION_MENU_OPTIONS = [0, 90, 180, 270];

export class AnnotationLayer {
  #root = document.getElementById('annotation-layer-root');
  #svg = null;
  #canvasLayer = null;
  #documentEngine = null;

  #annotations = new Map();
  #currentPage = 1;

  #isDrawing = false;
  #drawStart = null;
  #tempEl = null;
  #activePath = [];

  #selectedIds = new Set();
  #dragState = null;

  #viewport = {
    pageWidthPt: 595,
    pageHeightPt: 842,
    originXPt: 0,
    originYPt: 0,
    rotation: 0,
  };

  #contextMenu = null;
  #signaturePreset = buildTypedSignaturePreset({
    signerName: '簽署者',
    subtitle: '電子簽署',
    includeDate: true,
    dateText: new Intl.DateTimeFormat('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()).replaceAll('/', '.'),
  });
  #stampPreset = {
    text: '核准',
    color: '#C00000',
    includeDate: true,
  };

  init(canvasLayer, documentEngine) {
    this.#canvasLayer = canvasLayer;
    this.#documentEngine = documentEngine;
    this.#buildSVG();
    this.#bindEvents();

    eventBus.on('document:loaded', ({ source = 'open', currentPage = 1 }) => {
      if (source === 'open') {
        this.#annotations.clear();
      }
      this.#currentPage = currentPage;
      this.#selectedIds.clear();
      this.#hideContextMenu();
      this.#redraw();
      eventBus.emit('annotation:selected', { annotation: null });
    });

    eventBus.on('page:navigate', ({ targetPage }) => {
      this.#currentPage = targetPage;
      this.#selectedIds.clear();
      this.#hideContextMenu();
      this.#redraw();
      eventBus.emit('annotation:selected', { annotation: null });
    });

    eventBus.on('page:rendered', ({ pageNumber }) => {
      if (pageNumber === this.#currentPage) {
        this.#syncSize();
        this.#redraw();
      }
    });

    eventBus.on('page:metrics', ({
      pageNumber,
      widthPt,
      heightPt,
      originXPt = 0,
      originYPt = 0,
      rotation = 0,
    }) => {
      if (pageNumber === this.#currentPage) {
        this.setPageDimensions(widthPt, heightPt, rotation, originXPt, originYPt);
      }
    });

    eventBus.on('annotations:replace', ({ pageNumber, annotations }) => {
      this.#annotations.set(pageNumber, annotations);
      if (pageNumber === this.#currentPage) this.#redraw();
    });

    eventBus.on('document:structure-changed', (payload) => {
      this.#applyStructureChange(payload);
      this.#selectedIds.clear();
      stateManager.patch({ selectedAnnotationIds: [] });
      this.#hideContextMenu();
      this.#redraw();
      eventBus.emit('annotation:selected', { annotation: null });
    });
  }

  restoreAnnotations(allAnnotations) {
    this.#annotations.clear();
    for (const annotation of allAnnotations) {
      if (!this.#annotations.has(annotation.pageNumber)) {
        this.#annotations.set(annotation.pageNumber, []);
      }
      this.#annotations.get(annotation.pageNumber).push(annotation);
    }
    this.#redraw();
  }

  getAllAnnotations() {
    const all = [];
    for (const annotations of this.#annotations.values()) {
      all.push(...annotations);
    }
    return all;
  }

  setSignaturePreset(signaturePreset) {
    if (!signaturePreset) return;
    this.#signaturePreset = structuredClone(signaturePreset);
  }

  setStampPreset(stampPreset) {
    if (!stampPreset) return;
    this.#stampPreset = structuredClone(stampPreset);
  }

  selectAllOnCurrentPage() {
    const annotations = this.#annotations.get(this.#currentPage) ?? [];
    this.#selectedIds = new Set(annotations.map((annotation) => annotation.id));
    stateManager.patch({ selectedAnnotationIds: [...this.#selectedIds] });
    this.#redraw();
    this.#emitSelectionChanged();
  }

  deleteSelected() {
    if (this.#selectedIds.size === 0) return;
    const snapshots = [...this.#selectedIds]
      .map((id) => this.#findAnnotation(id))
      .filter(Boolean)
      .map((annotation) => this.#cloneAnnotation(annotation));
    if (snapshots.length === 0) return;

    const cmd = {
      execute: () => {
        for (const annotation of snapshots) {
          this.#removeAnnotation(annotation.id, annotation.pageNumber);
        }
        this.#selectedIds.clear();
        stateManager.patch({ selectedAnnotationIds: [] });
        this.#redraw();
        eventBus.emit('annotation:selected', { annotation: null });
      },
      undo: () => {
        for (const annotation of snapshots) {
          this.#addAnnotation(annotation);
        }
        this.#redraw();
      },
      description: `刪除 ${snapshots.length} 個標注`,
      estimatedBytes: JSON.stringify(snapshots).length * 2,
    };
    commandStack.execute(cmd);
    eventBus.emit('annotations:changed');
  }

  updateAnnotation(id, patch) {
    const annotation = this.#findAnnotation(id);
    if (!annotation) return;

    const before = this.#cloneAnnotation(annotation);
    const after = this.#cloneAnnotation(annotation);
    this.#applyPatch(after, patch);
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    const cmd = {
      execute: () => this.#replaceAnnotation(after),
      undo: () => this.#replaceAnnotation(before),
      description: `更新 ${this.#toolLabel(annotation.type)}`,
      estimatedBytes: JSON.stringify(before).length + JSON.stringify(after).length,
    };
    commandStack.execute(cmd);
    eventBus.emit('annotations:changed');
    eventBus.emit('annotation:selected', { annotation: this.#cloneAnnotation(after) });
  }

  #findAnnotation(id) {
    for (const annotations of this.#annotations.values()) {
      const found = annotations.find((annotation) => annotation.id === id);
      if (found) return found;
    }
    return null;
  }

  #buildSVG() {
    this.#svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.#svg.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;cursor:crosshair;';
    this.#svg.setAttribute('aria-hidden', 'true');
    this.#root.appendChild(this.#svg);
  }

  #syncSize() {
    const dims = this.#canvasLayer.getPageDimensions();
    this.#svg.style.width = `${dims.width}px`;
    this.#svg.style.height = `${dims.height}px`;
    this.#svg.setAttribute('viewBox', `0 0 ${dims.width} ${dims.height}`);
  }

  #bindEvents() {
    this.#svg.addEventListener('pointerdown', (event) => this.#onPointerDown(event));
    this.#svg.addEventListener('pointermove', (event) => this.#onPointerMove(event));
    this.#svg.addEventListener('pointerup', (event) => this.#onPointerUp(event));
    this.#svg.addEventListener('pointerleave', (event) => this.#onPointerLeave(event));
    this.#svg.addEventListener('contextmenu', (event) => this.#onContextMenu(event));
    this.#svg.addEventListener('dblclick', (event) => this.#onDblClick(event));

    document.addEventListener('pointerdown', (event) => {
      if (this.#contextMenu && !this.#contextMenu.contains(event.target)) {
        this.#hideContextMenu();
      }
    }, true);
  }

  #onPointerDown(event) {
    const annotationTarget = event.target.closest('[data-id]');
    if (annotationTarget) {
      this.#handleSelectDown(event);
      return;
    }

    const tool = stateManager.state.selectedTool;
    if (tool === 'select') {
      this.#handleSelectDown(event);
      return;
    }

    this.#isDrawing = true;
    this.#drawStart = this.#svgPoint(event);
    this.#activePath = [this.#drawStart];

    if (tool === 'draw') {
      this.#tempEl = this.#makeTempPath();
    } else {
      this.#tempEl = this.#makeTempShape(tool);
    }

    if (this.#tempEl) {
      this.#svg.appendChild(this.#tempEl);
    }

    this.#svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #onPointerMove(event) {
    if (this.#dragState) {
      this.#handleDragMove(event);
      return;
    }

    if (!this.#isDrawing || !this.#tempEl) return;
    const point = this.#svgPoint(event);
    const tool = stateManager.state.selectedTool;

    if (tool === 'draw') {
      this.#activePath.push(point);
      this.#tempEl.setAttribute('d', this.#buildPathD(this.#activePath));
    } else if (tool === 'line' || tool === 'arrow' || tool === 'underline') {
      this.#updateTempLine(this.#tempEl, this.#drawStart, point, tool === 'arrow');
    } else if (tool === 'circle') {
      this.#updateTempEllipse(this.#tempEl, this.#drawStart, point);
    } else {
      this.#updateTempRect(this.#tempEl, this.#drawStart, point);
    }

    event.preventDefault();
  }

  async #onPointerUp(event) {
    if (this.#dragState) {
      this.#handleDragEnd(event);
      return;
    }

    if (!this.#isDrawing) return;
    this.#isDrawing = false;

    const tool = stateManager.state.selectedTool;
    const end = this.#svgPoint(event);
    const dx = Math.abs(end.x - this.#drawStart.x);
    const dy = Math.abs(end.y - this.#drawStart.y);

    if (this.#tempEl) {
      this.#tempEl.remove();
      this.#tempEl = null;
    }

    const minSize = tool === 'draw' ? 5 : 10;
    if (tool === 'text') {
      // allow click to place
    } else if (tool === 'line' || tool === 'arrow' || tool === 'underline') {
      if (Math.hypot(dx, dy) < minSize) return;
    } else if (dx < minSize && dy < minSize) {
      return;
    }

    let annotations = [];
    if (tool === 'highlight' || tool === 'underline') {
      annotations = await this.#buildTextMarkupAnnotations(tool, end);
    }
    if (annotations.length === 0) {
      const annotation = this.#buildAnnotation(tool, end);
      if (!annotation) return;
      annotations = [annotation];
    }
    const primaryAnnotation = annotations[0];

    const cmd = {
      execute: () => {
        this.#selectedIds.clear();
        for (const annotation of annotations) {
          this.#addAnnotation(annotation);
          this.#selectedIds.add(annotation.id);
        }
        stateManager.patch({ selectedAnnotationIds: [...this.#selectedIds] });
        this.#redraw();
        this.#emitSelectionChanged();
        if (tool === 'text' && primaryAnnotation) {
          queueMicrotask(() => this.#startTextEdit(primaryAnnotation));
        }
      },
      undo: () => {
        for (const annotation of annotations) {
          this.#removeAnnotation(annotation.id, annotation.pageNumber);
          this.#selectedIds.delete(annotation.id);
        }
        stateManager.patch({ selectedAnnotationIds: [...this.#selectedIds] });
        this.#redraw();
        this.#emitSelectionChanged();
      },
      description: `新增 ${this.#toolLabel(tool)}`,
      estimatedBytes: JSON.stringify(annotations).length * 2,
    };
    commandStack.execute(cmd);
    eventBus.emit('annotations:changed');
    event.preventDefault();
  }

  #onPointerLeave(event) {
    if (this.#isDrawing) {
      this.#onPointerUp(event);
    }
  }

  #onContextMenu(event) {
    event.preventDefault();
    this.#hideContextMenu();

    const target = event.target.closest('[data-id]');
    if (target) {
      const id = target.getAttribute('data-id');
      this.#selectedIds.clear();
      this.#selectedIds.add(id);
      stateManager.patch({ selectedAnnotationIds: [id] });
      this.#redraw();
      this.#emitSelectionChanged();
    }

    const annotation = this.#selectedIds.size === 1
      ? this.#findAnnotation([...this.#selectedIds][0])
      : null;

    const menu = document.createElement('div');
    menu.id = 'ann-context-menu';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const deleteButton = document.createElement('button');
    deleteButton.textContent = '刪除';
    deleteButton.addEventListener('click', () => {
      this.deleteSelected();
      this.#hideContextMenu();
    });
    menu.appendChild(deleteButton);

    if (annotation) {
      const separator = document.createElement('div');
      separator.className = 'menu-sep';
      menu.appendChild(separator);

      const colorSection = document.createElement('div');
      colorSection.style.cssText = 'display:grid;gap:6px;padding:4px 0;';
      const colorLabel = document.createElement('span');
      colorLabel.textContent = '顏色';
      colorLabel.style.cssText = 'font-size:12px;color:#475569;';
      const colorPalette = document.createElement('div');
      colorPalette.style.cssText = 'display:grid;grid-template-columns:repeat(4, 22px);gap:6px;';
      const palette = annotation.type === 'highlight' ? CONTROLLED_HIGHLIGHT_COLORS : CONTROLLED_THEME_COLORS;
      const activeColor = String(annotation.style?.color ?? '#000000').toLowerCase();
      palette.forEach((color) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.title = color;
        swatch.setAttribute('aria-label', color);
        swatch.style.cssText = [
          'width:22px',
          'height:22px',
          'border-radius:999px',
          `border:${color.toLowerCase() === activeColor ? '2px solid #2563EB' : '1px solid rgba(15,23,42,0.15)'}`,
          `background:${color}`,
          'cursor:pointer',
          'padding:0',
        ].join(';');
        swatch.addEventListener('click', () => {
          this.updateAnnotation(annotation.id, {
            style: { ...annotation.style, color },
          });
        });
        colorPalette.appendChild(swatch);
      });
      colorSection.appendChild(colorLabel);
      colorSection.appendChild(colorPalette);
      menu.appendChild(colorSection);

      if (ROTATABLE_ANNOTATION_TYPES.has(annotation.type)) {
        const rotationSeparator = document.createElement('div');
        rotationSeparator.className = 'menu-sep';
        menu.appendChild(rotationSeparator);

        const rotationSection = document.createElement('div');
        rotationSection.style.cssText = 'display:grid;gap:6px;padding:4px 0;';
        const rotationLabel = document.createElement('span');
        rotationLabel.textContent = '旋轉';
        rotationLabel.style.cssText = 'font-size:12px;color:#475569;';
        const rotationRow = document.createElement('div');
        rotationRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
        const currentRotation = normalizeAnnotationRotation(annotation.style?.rotation ?? 0);
        ROTATION_MENU_OPTIONS.forEach((angle) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `${angle}°`;
          button.style.cssText = [
            'padding:4px 8px',
            'border-radius:999px',
            `border:1px solid ${angle === currentRotation ? '#2563EB' : 'rgba(15,23,42,0.12)'}`,
            `background:${angle === currentRotation ? 'rgba(37,99,235,0.1)' : '#FFFFFF'}`,
            'cursor:pointer',
          ].join(';');
          button.addEventListener('click', () => {
            this.updateAnnotation(annotation.id, {
              style: { ...annotation.style, rotation: angle },
            });
          });
          rotationRow.appendChild(button);
        });
        rotationSection.appendChild(rotationLabel);
        rotationSection.appendChild(rotationRow);
        menu.appendChild(rotationSection);
      }

      if (annotation.type === 'text') {
        const textSeparator = document.createElement('div');
        textSeparator.className = 'menu-sep';
        menu.appendChild(textSeparator);

        const editButton = document.createElement('button');
        editButton.textContent = '編輯文字';
        editButton.addEventListener('click', () => {
          this.#hideContextMenu();
          this.#startTextEdit(annotation);
        });
        menu.appendChild(editButton);
      }
    }

    document.body.appendChild(menu);
    this.#contextMenu = menu;
  }

  #hideContextMenu() {
    if (!this.#contextMenu) return;
    this.#contextMenu.remove();
    this.#contextMenu = null;
  }

  #onDblClick(event) {
    const target = event.target.closest('[data-id]');
    if (!target) return;
    const annotation = this.#findAnnotation(target.getAttribute('data-id'));
    if (!annotation || annotation.type !== 'text') return;
    this.#startTextEdit(annotation);
  }

  #startTextEdit(annotation) {
    const el = this.#svg.querySelector(`[data-id="${annotation.id}"]`);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const editor = document.createElement('div');
    editor.style.cssText = [
      'position:fixed',
      `left:${Math.max(12, rect.left)}px`,
      `top:${Math.max(12, rect.top)}px`,
      `min-width:${Math.max(rect.width + 24, 180)}px`,
      'max-width:min(420px, calc(100vw - 24px))',
      'background:rgba(255,255,255,0.96)',
      'border:1px solid #2563EB',
      'border-radius:10px',
      'box-shadow:0 14px 36px rgba(15,23,42,0.18)',
      'padding:10px',
      'z-index:8000',
      'display:grid',
      'gap:8px',
    ].join(';');

    const textarea = document.createElement('textarea');
    textarea.value = annotation.content ?? '';
    textarea.rows = Math.max(2, String(annotation.content ?? '').split(/\r?\n/).length);
    textarea.style.cssText = [
      'width:100%',
      'min-height:72px',
      'resize:vertical',
      `font-size:${annotation.style?.fontSize ?? 12}px`,
      'line-height:1.4',
      'font-family:"Microsoft JhengHei","PingFang TC",sans-serif',
      `color:${annotation.style?.color ?? '#000000'}`,
      'background:#FFFFFF',
      'border:1px solid rgba(37,99,235,0.22)',
      'border-radius:8px',
      'padding:8px 10px',
      'outline:none',
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = '取消';
    cancelButton.className = 'btn';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = '套用文字';
    saveButton.className = 'btn btn-primary';

    actions.appendChild(cancelButton);
    actions.appendChild(saveButton);
    editor.appendChild(textarea);
    editor.appendChild(actions);
    document.body.appendChild(editor);
    textarea.focus();
    textarea.select();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      editor.remove();
    };
    const commit = () => {
      const value = textarea.value;
      close();
      if (value !== annotation.content) {
        this.updateAnnotation(annotation.id, { content: value });
      }
    };

    saveButton.addEventListener('click', commit);
    cancelButton.addEventListener('click', close);
    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
  }

  #handleSelectDown(event) {
    const target = event.target.closest('[data-id]');
    if (!target) {
      if (this.#selectedIds.size > 0) {
        this.#selectedIds.clear();
        stateManager.patch({ selectedAnnotationIds: [] });
        this.#redraw();
        this.#emitSelectionChanged();
      }
      return;
    }

    const annotation = this.#findAnnotation(target.getAttribute('data-id'));
    if (!annotation) return;
    const wasSelected = this.#selectedIds.has(annotation.id) && this.#selectedIds.size === 1;

    this.#selectedIds.clear();
    this.#selectedIds.add(annotation.id);
    stateManager.patch({ selectedAnnotationIds: [annotation.id] });
    this.#redraw();
    this.#emitSelectionChanged();

    if (!wasSelected) {
      event.preventDefault();
      return;
    }

    this.#dragState = {
      ann: annotation,
      startSvgPt: this.#svgPoint(event),
      origGeometry: this.#cloneAnnotation(annotation.geometry),
      hasMoved: false,
    };

    this.#svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  #handleDragMove(event) {
    const { ann, startSvgPt, origGeometry } = this.#dragState;
    const current = this.#svgPoint(event);
    const screenDx = current.x - startSvgPt.x;
    const screenDy = current.y - startSvgPt.y;

    if (Math.abs(screenDx) > 1 || Math.abs(screenDy) > 1) {
      this.#dragState.hasMoved = true;
    }

    const startPdf = this.#screenPointToPdf(startSvgPt);
    const currentPdf = this.#screenPointToPdf(current);
    const dxPdf = currentPdf.x - startPdf.x;
    const dyPdf = currentPdf.y - startPdf.y;

    if (ann.type === 'highlight' || ann.type === 'rect' || ann.type === 'circle' || ann.type === 'stamp') {
      ann.geometry = {
        ...origGeometry,
        x: origGeometry.x + dxPdf,
        y: origGeometry.y + dyPdf,
      };
    } else if (ann.type === 'line' || ann.type === 'arrow' || ann.type === 'underline') {
      ann.geometry = {
        ...origGeometry,
        x1: origGeometry.x1 + dxPdf,
        y1: origGeometry.y1 + dyPdf,
        x2: origGeometry.x2 + dxPdf,
        y2: origGeometry.y2 + dyPdf,
      };
    } else if (ann.type === 'text') {
      ann.geometry = {
        x: origGeometry.x + dxPdf,
        y: origGeometry.y + dyPdf,
      };
    } else if (ann.type === 'draw') {
      ann.geometry = {
        pathData: this.#translatePathData(origGeometry.pathData, dxPdf, dyPdf),
      };
    }

    this.#redraw();
    event.preventDefault();
  }

  #handleDragEnd(event) {
    const { ann, origGeometry, hasMoved } = this.#dragState;
    this.#dragState = null;

    if (hasMoved) {
      const nextGeometry = this.#cloneAnnotation(ann.geometry);
      const cmd = {
        execute: () => {
          const current = this.#findAnnotation(ann.id);
          if (!current) return;
          current.geometry = this.#cloneAnnotation(nextGeometry);
          this.#redraw();
        },
        undo: () => {
          const current = this.#findAnnotation(ann.id);
          if (!current) return;
          current.geometry = this.#cloneAnnotation(origGeometry);
          this.#redraw();
        },
        description: `移動 ${this.#toolLabel(ann.type)}`,
        estimatedBytes: JSON.stringify(nextGeometry).length * 4,
      };
      commandStack.execute(cmd);
      eventBus.emit('annotations:changed');
    }

    event.preventDefault();
  }

  #translatePathData(pathData, dx, dy) {
    return pathData.replace(/([ML])\s+([\d.\-]+)\s+([\d.\-]+)/g, (_, cmd, x, y) => {
      return `${cmd} ${parseFloat(x) + dx} ${parseFloat(y) + dy}`;
    });
  }

  #buildAnnotation(tool, endPt) {
    const now = new Date().toISOString();
    const base = {
      id: uuid(),
      type: tool,
      pageNumber: this.#currentPage,
      createdAt: now,
      modifiedAt: now,
    };

    const x = Math.min(this.#drawStart.x, endPt.x);
    const y = Math.min(this.#drawStart.y, endPt.y);
    const width = Math.abs(endPt.x - this.#drawStart.x);
    const height = Math.abs(endPt.y - this.#drawStart.y);
    const rectGeometry = this.#screenRectToPdfRect({ x, y, width, height });

    switch (tool) {
      case 'highlight':
        return {
          ...base,
          geometry: rectGeometry,
          style: { color: '#FFF200', opacity: 0.4 },
        };
      case 'underline': {
        const underlineY = rectGeometry.y + Math.max(0.75, rectGeometry.height * 0.12);
        return {
          ...base,
          geometry: {
            x1: rectGeometry.x,
            y1: underlineY,
            x2: rectGeometry.x + rectGeometry.width,
            y2: underlineY,
          },
          style: { color: '#C00000', opacity: 1, strokeWidth: Math.max(1, rectGeometry.height * 0.08 || 1.25) },
        };
      }
      case 'rect':
        return {
          ...base,
          geometry: rectGeometry,
          style: { color: '#4472C4', opacity: 1, strokeWidth: 1.5, rotation: 0 },
        };
      case 'circle':
        return {
          ...base,
          geometry: rectGeometry,
          style: { color: '#4472C4', opacity: 1, strokeWidth: 1.5 },
        };
      case 'line': {
        const start = this.#screenPointToPdf(this.#drawStart);
        const end = this.#screenPointToPdf(endPt);
        return {
          ...base,
          geometry: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
          style: { color: '#4472C4', opacity: 1, strokeWidth: 2 },
        };
      }
      case 'arrow': {
        const start = this.#screenPointToPdf(this.#drawStart);
        const end = this.#screenPointToPdf(endPt);
        return {
          ...base,
          geometry: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
          style: { color: '#C00000', opacity: 1, strokeWidth: 2 },
        };
      }
      case 'draw':
        return {
          ...base,
          geometry: { pathData: this.#buildPdfPathD(this.#activePath) },
          style: { color: '#C00000', opacity: 1, strokeWidth: 2, rotation: 0 },
        };
      case 'text': {
        const anchor = this.#screenPointToPdf(this.#drawStart);
        return {
          ...base,
          geometry: { x: anchor.x, y: anchor.y },
          style: { color: '#000000', opacity: 1, fontSize: 12, rotation: 0 },
          content: '文字標註',
        };
      }
      case 'stamp': {
        const preset = this.#stampPreset;
        const dateStr = new Intl.DateTimeFormat('zh-TW', {
          year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date()).replaceAll('/', '.');
        const stampContent = preset.includeDate
          ? `${preset.text ?? '核准'}\n${dateStr}`
          : (preset.text ?? '核准');
        return {
          ...base,
          geometry: rectGeometry,
          style: { color: preset.color ?? '#C00000', opacity: 1, strokeWidth: 1.5, rotation: 0, fontSize: 12 },
          content: stampContent,
        };
      }
      case 'signature': {
        const preset = structuredClone(this.#signaturePreset ?? buildTypedSignaturePreset({
          signerName: '簽署者',
        }));
        return {
          ...base,
          geometry: rectGeometry,
          style: {
            color: preset.color ?? '#1F2937',
            opacity: 1,
            rotation: 0,
          },
          content: buildSignatureAnnotationContent(preset),
          signatureData: preset,
        };
      }
      default:
        return null;
    }
  }

  #addAnnotation(annotation) {
    if (!this.#annotations.has(annotation.pageNumber)) {
      this.#annotations.set(annotation.pageNumber, []);
    }
    this.#annotations.get(annotation.pageNumber).push(annotation);
    if (annotation.pageNumber === this.#currentPage) {
      this.#redraw();
    }
    eventBus.emit('annotation:added', { type: annotation.type, pageNumber: annotation.pageNumber });
  }

  #removeAnnotation(id, pageNumber) {
    const annotations = this.#annotations.get(pageNumber) ?? [];
    const index = annotations.findIndex((annotation) => annotation.id === id);
    if (index !== -1) {
      annotations.splice(index, 1);
    }
    if (pageNumber === this.#currentPage) {
      this.#redraw();
    }
  }

  #redraw() {
    while (this.#svg.firstChild) {
      this.#svg.removeChild(this.#svg.firstChild);
    }

    const annotations = this.#annotations.get(this.#currentPage) ?? [];
    for (const annotation of annotations) {
      const el = this.#renderAnnotation(annotation);
      if (el) {
        this.#svg.appendChild(el);
      }
    }

    for (const id of this.#selectedIds) {
      const annotation = this.#findAnnotation(id);
      if (annotation) {
        this.#renderSelectionHandle(annotation);
      }
    }
  }

  #renderSelectionHandle(annotation) {
    const el = this.#svg.querySelector(`[data-id="${annotation.id}"]`);
    if (!el) return;

    let rect = null;
    try {
      const box = el.getBBox();
      rect = {
        x: box.x - 4,
        y: box.y - 4,
        width: box.width + 8,
        height: box.height + 8,
      };
    } catch {
      return;
    }

    const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    handle.setAttribute('class', 'selection-handle');
    handle.setAttribute('x', rect.x);
    handle.setAttribute('y', rect.y);
    handle.setAttribute('width', rect.width);
    handle.setAttribute('height', rect.height);
    handle.setAttribute('fill', 'none');
    handle.setAttribute('stroke', '#2563EB');
    handle.setAttribute('stroke-width', '1.5');
    handle.setAttribute('stroke-dasharray', '4 2');
    handle.setAttribute('pointer-events', 'none');
    this.#svg.appendChild(handle);
  }

  #getAnnotationRotationCenter(annotation) {
    if (!ROTATABLE_ANNOTATION_TYPES.has(annotation.type)) return null;

    if (annotation.type === 'text') {
      return this.#pdfToScreenPoint(annotation.geometry);
    }

    if (annotation.type === 'rect') {
      return this.#pdfToScreenPoint({
        x: (Number(annotation.geometry?.x) || 0) + ((Number(annotation.geometry?.width) || 0) / 2),
        y: (Number(annotation.geometry?.y) || 0) + ((Number(annotation.geometry?.height) || 0) / 2),
      });
    }

    const bounds = getPathBounds(annotation.geometry?.pathData ?? '');
    if (!bounds) return null;
    return this.#pdfToScreenPoint({
      x: bounds.x + (bounds.width / 2),
      y: bounds.y + (bounds.height / 2),
    });
  }

  #wrapRotatedAnnotation(annotation, el) {
    const rotation = normalizeAnnotationRotation(annotation.style?.rotation ?? 0);
    if (rotation === 0 || !ROTATABLE_ANNOTATION_TYPES.has(annotation.type)) return el;

    const center = this.#getAnnotationRotationCenter(annotation);
    if (!center) return el;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('transform', `rotate(${rotation} ${center.x} ${center.y})`);
    group.appendChild(el);
    return group;
  }

  #measureTextBox(content, fontSize) {
    const lines = String(content ?? '').split(/\r?\n/);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${fontSize}px "Microsoft JhengHei", "PingFang TC", sans-serif`;
    const widths = lines.map((line) => Math.max(1, context.measureText(line || ' ').width));
    const lineHeight = fontSize * 1.35;
    return {
      lines,
      lineHeight,
      width: Math.max(1, ...widths),
      height: Math.max(lineHeight, lines.length * lineHeight),
    };
  }

  #buildTextElement(annotation, point) {
    const fontSize = annotation.style?.fontSize ?? 12;
    const metrics = this.#measureTextBox(annotation.content ?? '', fontSize);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const hitBox = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hitBox.setAttribute('x', point.x - 6);
    hitBox.setAttribute('y', point.y - 4);
    hitBox.setAttribute('width', metrics.width + 12);
    hitBox.setAttribute('height', metrics.height + 8);
    hitBox.setAttribute('rx', 4);
    hitBox.setAttribute('fill', 'rgba(255,255,255,0.001)');
    group.appendChild(hitBox);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', point.x);
    text.setAttribute('y', point.y);
    text.setAttribute('fill', annotation.style?.color ?? '#000000');
    text.setAttribute('font-size', fontSize);
    text.setAttribute('font-family', '"Microsoft JhengHei", "PingFang TC", sans-serif');
    text.setAttribute('dominant-baseline', 'hanging');
    metrics.lines.forEach((lineText, index) => {
      const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      tspan.setAttribute('x', point.x);
      tspan.setAttribute('dy', index === 0 ? '0' : String(metrics.lineHeight));
      tspan.textContent = lineText || ' ';
      text.appendChild(tspan);
    });
    group.appendChild(text);

    const rotation = normalizeAnnotationRotation(annotation.style?.rotation ?? 0);
    if (rotation !== 0) {
      group.setAttribute('transform', `rotate(${rotation} ${point.x} ${point.y})`);
    }
    return group;
  }

  #renderAnnotation(annotation) {
    const { type, geometry, style, id } = annotation;
    const dims = this.#canvasLayer.getPageDimensions();
    if (!dims.width) return null;

    let el = null;
    let rootEl = null;

    if (type === 'highlight' || type === 'rect' || type === 'circle' || type === 'stamp' || type === 'signature') {
      const rect = this.#pdfRectToScreenRect(geometry);
      if (type === 'circle') {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        el.setAttribute('cx', rect.x + (rect.width / 2));
        el.setAttribute('cy', rect.y + (rect.height / 2));
        el.setAttribute('rx', rect.width / 2);
        el.setAttribute('ry', rect.height / 2);
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', style.color);
        el.setAttribute('stroke-width', style.strokeWidth ?? 1.5);
        el.setAttribute('stroke-opacity', style.opacity);
        rootEl = el;
      } else if (type === 'stamp') {
        rootEl = this.#buildStampElement(annotation, rect);
      } else if (type === 'signature') {
        rootEl = this.#buildSignatureElement(annotation, rect);
      } else {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        el.setAttribute('x', rect.x);
        el.setAttribute('y', rect.y);
        el.setAttribute('width', rect.width);
        el.setAttribute('height', rect.height);
      }

      if (type === 'highlight') {
        el.setAttribute('fill', style.color);
        el.setAttribute('fill-opacity', style.opacity);
        el.setAttribute('stroke', 'none');
        rootEl = el;
      } else if (type === 'rect') {
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', style.color);
        el.setAttribute('stroke-width', style.strokeWidth ?? 1.5);
        el.setAttribute('stroke-opacity', style.opacity);
        rootEl = this.#wrapRotatedAnnotation(annotation, el);
      }
    } else if (type === 'draw') {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', this.#pdfPathToSvgPath(geometry.pathData));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', style.color);
      el.setAttribute('stroke-width', style.strokeWidth ?? 2);
      el.setAttribute('stroke-opacity', style.opacity);
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      rootEl = this.#wrapRotatedAnnotation(annotation, el);
    } else if (type === 'line' || type === 'arrow' || type === 'underline') {
      const start = this.#pdfToScreenPoint({ x: geometry.x1, y: geometry.y1 });
      const end = this.#pdfToScreenPoint({ x: geometry.x2, y: geometry.y2 });
      rootEl = this.#buildLineElement(annotation, start, end, type === 'arrow');
    } else if (type === 'text') {
      const point = this.#pdfToScreenPoint(geometry);
      rootEl = this.#buildTextElement(annotation, point);
    }

    rootEl ??= el;
    if (!rootEl) return null;

    rootEl.setAttribute('data-id', id);
    rootEl.style.cursor = this.#selectedIds.has(id) || stateManager.state.selectedTool === 'select' ? 'move' : 'pointer';
    rootEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (stateManager.state.selectedTool !== 'select') return;
      this.#selectedIds.clear();
      this.#selectedIds.add(id);
      stateManager.patch({ selectedAnnotationIds: [id] });
      this.#redraw();
      this.#emitSelectionChanged();
    });
    return rootEl;
  }

  #emitSelectionChanged() {
    const annotation = this.#selectedIds.size === 1
      ? this.#findAnnotation([...this.#selectedIds][0])
      : null;
    eventBus.emit('annotation:selected', {
      annotation: annotation ? this.#cloneAnnotation(annotation) : null,
    });
  }

  #makeTempShape(tool) {
    if (tool === 'line' || tool === 'arrow' || tool === 'underline') {
      return this.#buildLineElement({
        type: tool,
        style: { color: tool === 'arrow' || tool === 'underline' ? '#C00000' : '#4472C4', opacity: 1, strokeWidth: 2 },
      }, { x: 0, y: 0 }, { x: 0, y: 0 }, tool === 'arrow', true);
    }

    if (tool === 'circle') {
      const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      ellipse.setAttribute('cx', 0);
      ellipse.setAttribute('cy', 0);
      ellipse.setAttribute('rx', 0);
      ellipse.setAttribute('ry', 0);
      ellipse.setAttribute('fill', 'none');
      ellipse.setAttribute('stroke', '#4472C4');
      ellipse.setAttribute('stroke-width', '1.5');
      ellipse.setAttribute('stroke-dasharray', '4 2');
      return ellipse;
    }

    if (tool === 'highlight') {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('fill', '#FFFF00');
      el.setAttribute('fill-opacity', '0.4');
      el.setAttribute('stroke', 'none');
      el.setAttribute('x', 0);
      el.setAttribute('y', 0);
      el.setAttribute('width', 0);
      el.setAttribute('height', 0);
      return el;
    }

    if (tool === 'stamp' || tool === 'signature') {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', tool === 'signature' ? '#2563EB' : '#C00000');
      el.setAttribute('stroke-width', '1.5');
      el.setAttribute('stroke-dasharray', '4 2');
      el.setAttribute('x', 0);
      el.setAttribute('y', 0);
      el.setAttribute('width', 0);
      el.setAttribute('height', 0);
      return el;
    }

    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    if (tool === 'rect') {
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#0066CC');
      el.setAttribute('stroke-width', '1.5');
      el.setAttribute('stroke-dasharray', '4 2');
    } else {
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#0066CC');
      el.setAttribute('stroke-width', '1.5');
      el.setAttribute('stroke-dasharray', '4 2');
    }
    el.setAttribute('x', 0);
    el.setAttribute('y', 0);
    el.setAttribute('width', 0);
    el.setAttribute('height', 0);
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

  #svgPoint(event) {
    const rect = this.#svg.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  #getGeometryViewport() {
    const dims = this.#canvasLayer.getPageDimensions();
    return {
      pageWidthPt: this.#viewport.pageWidthPt,
      pageHeightPt: this.#viewport.pageHeightPt,
      originXPt: this.#viewport.originXPt,
      originYPt: this.#viewport.originYPt,
      rotation: this.#viewport.rotation,
      screenWidth: dims.width,
      screenHeight: dims.height,
    };
  }

  #screenPointToPdf(point) {
    return screenPointToPdf(point, this.#getGeometryViewport());
  }

  #screenRectToPdfRect(rect) {
    return screenRectToPdfRect(rect, this.#getGeometryViewport());
  }

  #pdfToScreenPoint(point) {
    return pdfPointToScreen(point, this.#getGeometryViewport());
  }

  #pdfRectToScreenRect(rect) {
    return pdfRectToScreenRect(rect, this.#getGeometryViewport());
  }

  #buildPathD(points) {
    if (points.length < 2) return '';
    const [first, ...rest] = points;
    return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')}`;
  }

  #buildPdfPathD(points) {
    if (points.length < 2) return '';
    const [first, ...rest] = points;
    const firstPdf = this.#screenPointToPdf(first);
    return `M ${firstPdf.x} ${firstPdf.y} ${rest.map((point) => {
      const pdfPoint = this.#screenPointToPdf(point);
      return `L ${pdfPoint.x} ${pdfPoint.y}`;
    }).join(' ')}`;
  }

  #pdfPathToSvgPath(pathData) {
    return pathData.replace(/([ML])\s+([\d.\-]+)\s+([\d.\-]+)/g, (_, cmd, x, y) => {
      const point = this.#pdfToScreenPoint({ x: parseFloat(x), y: parseFloat(y) });
      return `${cmd} ${point.x} ${point.y}`;
    });
  }

  #toolLabel(tool) {
    return {
      highlight: '螢光筆',
      draw: '手繪',
      text: '文字標註',
      rect: '矩形框',
      circle: '圓形',
      line: '線段',
      arrow: '箭頭',
      stamp: '印章',
    }[tool] ?? tool;
  }

  #updateTempRect(el, start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    el.setAttribute('x', x);
    el.setAttribute('y', y);
    el.setAttribute('width', width);
    el.setAttribute('height', height);
  }

  #updateTempEllipse(el, start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    el.setAttribute('cx', x + (width / 2));
    el.setAttribute('cy', y + (height / 2));
    el.setAttribute('rx', width / 2);
    el.setAttribute('ry', height / 2);
  }

  #updateTempLine(group, start, end, withArrow = false) {
    const line = group.querySelector('line[data-role="line"]');
    if (!line) return;
    line.setAttribute('x1', start.x);
    line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x);
    line.setAttribute('y2', end.y);
    if (!withArrow) return;
    const headLines = group.querySelectorAll('line[data-role="arrow-head"]');
    const segments = buildArrowHeadSegments(start, end, 12, 26);
    headLines.forEach((head, index) => {
      const segment = segments[index];
      if (!segment) return;
      head.setAttribute('x1', segment.start.x);
      head.setAttribute('y1', segment.start.y);
      head.setAttribute('x2', segment.end.x);
      head.setAttribute('y2', segment.end.y);
    });
  }

  #buildLineElement(annotation, start, end, withArrow = false, temporary = false) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('data-role', 'line');
    line.setAttribute('x1', start.x);
    line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x);
    line.setAttribute('y2', end.y);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', annotation.style?.color ?? '#4472C4');
    line.setAttribute('stroke-width', annotation.style?.strokeWidth ?? 2);
    line.setAttribute('stroke-opacity', annotation.style?.opacity ?? 1);
    line.setAttribute('stroke-linecap', 'round');
    group.appendChild(line);

    if (withArrow) {
      buildArrowHeadSegments(start, end, 12, 26).forEach((segment) => {
        const head = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        head.setAttribute('data-role', 'arrow-head');
        head.setAttribute('x1', segment.start.x);
        head.setAttribute('y1', segment.start.y);
        head.setAttribute('x2', segment.end.x);
        head.setAttribute('y2', segment.end.y);
        head.setAttribute('fill', 'none');
        head.setAttribute('stroke', annotation.style?.color ?? '#4472C4');
        head.setAttribute('stroke-width', annotation.style?.strokeWidth ?? 2);
        head.setAttribute('stroke-opacity', annotation.style?.opacity ?? 1);
        head.setAttribute('stroke-linecap', 'round');
        group.appendChild(head);
      });
    }

    if (temporary) {
      group.querySelectorAll('line').forEach((part) => {
        part.setAttribute('stroke-dasharray', '4 2');
      });
    }

    return group;
  }

  #buildStampElement(annotation, rect) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const border = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    border.setAttribute('cx', rect.x + (rect.width / 2));
    border.setAttribute('cy', rect.y + (rect.height / 2));
    border.setAttribute('rx', rect.width / 2);
    border.setAttribute('ry', rect.height / 2);
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', annotation.style?.color ?? '#C00000');
    border.setAttribute('stroke-width', annotation.style?.strokeWidth ?? 1.5);
    border.setAttribute('stroke-opacity', annotation.style?.opacity ?? 1);
    group.appendChild(border);

    const divider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    divider.setAttribute('x1', rect.x + (rect.width * 0.18));
    divider.setAttribute('x2', rect.x + (rect.width * 0.82));
    divider.setAttribute('y1', rect.y + (rect.height * 0.56));
    divider.setAttribute('y2', rect.y + (rect.height * 0.56));
    divider.setAttribute('stroke', annotation.style?.color ?? '#C00000');
    divider.setAttribute('stroke-width', annotation.style?.strokeWidth ?? 1.1);
    divider.setAttribute('stroke-opacity', annotation.style?.opacity ?? 1);
    group.appendChild(divider);

    const lines = String(annotation.content ?? '電子印章').split(/\r?\n/).filter(Boolean).slice(0, 2);
    lines.forEach((lineText, index) => {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', rect.x + (rect.width / 2));
      text.setAttribute('y', rect.y + (rect.height * (index === 0 ? 0.42 : 0.74)));
      text.setAttribute('fill', annotation.style?.color ?? '#C00000');
      text.setAttribute('font-size', annotation.style?.fontSize ?? Math.max(11, Math.min(rect.width, rect.height) * 0.16));
      text.setAttribute('font-family', 'system-ui, sans-serif');
      text.setAttribute('text-anchor', 'middle');
      text.textContent = lineText;
      group.appendChild(text);
    });

    return this.#wrapRotatedAnnotation(annotation, group);
  }

  #buildSignatureElement(annotation, rect) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    image.setAttribute('x', rect.x);
    image.setAttribute('y', rect.y);
    image.setAttribute('width', Math.max(1, rect.width));
    image.setAttribute('height', Math.max(1, rect.height));
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    image.setAttribute('opacity', annotation.style?.opacity ?? 1);
    image.setAttribute('href', annotation.signatureData?.dataUrl ?? buildTypedSignaturePreset({
      signerName: annotation.content ?? '簽署者',
      includeDate: false,
      color: annotation.style?.color ?? '#1F2937',
    }).dataUrl);
    group.appendChild(image);

    const hitRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hitRect.setAttribute('x', rect.x);
    hitRect.setAttribute('y', rect.y);
    hitRect.setAttribute('width', Math.max(1, rect.width));
    hitRect.setAttribute('height', Math.max(1, rect.height));
    hitRect.setAttribute('fill', 'transparent');
    hitRect.setAttribute('stroke', this.#selectedIds.has(annotation.id) ? '#2563EB' : 'transparent');
    hitRect.setAttribute('stroke-width', '1.5');
    if (this.#selectedIds.has(annotation.id)) {
      hitRect.setAttribute('stroke-dasharray', '6 3');
    }
    group.appendChild(hitRect);

    return this.#wrapRotatedAnnotation(annotation, group);
  }

  async #buildTextMarkupAnnotations(tool, endPt) {
    if (!this.#documentEngine) return [];

    const x = Math.min(this.#drawStart.x, endPt.x);
    const y = Math.min(this.#drawStart.y, endPt.y);
    const width = Math.max(1, Math.abs(endPt.x - this.#drawStart.x));
    const height = Math.max(1, Math.abs(endPt.y - this.#drawStart.y));
    const selectionRect = this.#screenRectToPdfRect({ x, y, width, height });
    const textRuns = await this.#documentEngine.getPageTextRuns(this.#currentPage);
    const markupRegions = resolveTextMarkupSelection(textRuns, selectionRect, tool);
    if (markupRegions.length === 0) return [];

    return markupRegions.map((region) => {
      const now = new Date().toISOString();
      return {
        id: uuid(),
        type: tool,
        pageNumber: this.#currentPage,
        createdAt: now,
        modifiedAt: now,
        geometry: region.geometry,
        style: tool === 'highlight'
          ? { color: '#FFF200', opacity: 0.4 }
          : { color: '#C00000', opacity: 1, strokeWidth: region.strokeWidth ?? 1.25 },
      };
    });
  }

  #cloneAnnotation(annotation) {
    return JSON.parse(JSON.stringify(annotation));
  }

  #applyPatch(target, patch) {
    const originalStyle = target.style ? { ...target.style } : {};
    Object.assign(target, patch);
    if (patch.style) {
      target.style = { ...originalStyle, ...patch.style };
    }
    if (patch.signatureData) {
      target.signatureData = { ...target.signatureData, ...patch.signatureData };
      target.content = buildSignatureAnnotationContent(target.signatureData);
    }
    target.modifiedAt = new Date().toISOString();
  }

  #replaceAnnotation(snapshot) {
    for (const [pageNumber, annotations] of this.#annotations) {
      const index = annotations.findIndex((annotation) => annotation.id === snapshot.id);
      if (index === -1) continue;
      annotations.splice(index, 1);
      if (annotations.length === 0) {
        this.#annotations.delete(pageNumber);
      }
      break;
    }
    this.#addAnnotation(this.#cloneAnnotation(snapshot));
    this.#selectedIds.clear();
    this.#selectedIds.add(snapshot.id);
    stateManager.patch({ selectedAnnotationIds: [snapshot.id] });
    this.#redraw();
  }

  #applyStructureChange({ type, pageNumber, afterPageNumber, fromPage, toPage }) {
    const next = new Map();
    for (const annotation of this.getAllAnnotations()) {
      const cloned = this.#cloneAnnotation(annotation);

      if (type === 'delete-page') {
        if (cloned.pageNumber === pageNumber) continue;
        if (cloned.pageNumber > pageNumber) cloned.pageNumber -= 1;
      }

      if (type === 'insert-page' && cloned.pageNumber > afterPageNumber) {
        cloned.pageNumber += 1;
      }

      if (type === 'reorder-page') {
        if (cloned.pageNumber === fromPage) {
          cloned.pageNumber = toPage;
        } else if (fromPage < toPage && cloned.pageNumber > fromPage && cloned.pageNumber <= toPage) {
          cloned.pageNumber -= 1;
        } else if (fromPage > toPage && cloned.pageNumber >= toPage && cloned.pageNumber < fromPage) {
          cloned.pageNumber += 1;
        }
      }

      if (!next.has(cloned.pageNumber)) {
        next.set(cloned.pageNumber, []);
      }
      next.get(cloned.pageNumber).push(cloned);
    }
    this.#annotations = next;
  }

  setPageDimensions(widthPt, heightPt, rotation = 0, originXPt = 0, originYPt = 0) {
    this.#viewport.pageWidthPt = widthPt;
    this.#viewport.pageHeightPt = heightPt;
    this.#viewport.originXPt = originXPt;
    this.#viewport.originYPt = originYPt;
    this.#viewport.rotation = normalizeRotation(rotation);
  }
}

export const annotationLayer = new AnnotationLayer();
