/**
 * app.js — OpenSpec PDF Editor Entry Point
 *
 * The ONLY module that holds references to all singletons.
 * Initialization order:
 *   1. Init DocumentEngine Worker (sync — no fetch needed)
 *   2. Init layers (CanvasLayer, AnnotationLayer)
 *   3. Init UI chrome + KeyMap → initial renderShell (user sees UI immediately)
 *   4. Wire all EventBus handlers
 *   5. Background (non-blocking): SessionDB, ThumbnailWorker
 *
 * Singletons communicate ONLY through EventBus.
 * This file is the only exception (holds direct refs for init).
 */

import { eventBus }       from './core/EventBus.js';
import { stateManager }   from './core/StateManager.js';
import { commandStack }   from './core/CommandStack.js';
import { documentEngine } from './core/DocumentEngine.js';
import { sessionDB }      from './core/SessionDB.js';
import { keyMap }         from './core/KeyMap.js';
import { canvasLayer }    from './ui/CanvasLayer.js';
import { annotationLayer }from './ui/AnnotationLayer.js';
import { appRenderer }    from './ui/renderApp.js';

// ---- Capability Detection ----
const capabilities = {
  fileSystemAccess: 'showSaveFilePicker' in window,
  indexedDB:        'indexedDB' in window,
  offscreenCanvas:  'OffscreenCanvas' in window,
};

const SAVE_STATUS_DISPLAY_MS = 2500;

// ---- Thumbnail Worker Manager ----
class ThumbnailWorkerManager {
  #worker = null;
  #pending = new Map(); // id -> { resolve, reject }
  #crashCount = 0;
  #lastCrashTime = 0;
  #pdfjsScriptUrl = null;

  async init() {
    await this.#spawn();
  }

  async #spawn() {
    try {
      const [scriptText, workerText] = await Promise.all([
        fetch('./lib/pdf.min.js').then(r => r.text()),
        fetch('./js/workers/thumbnail-worker.js').then(r => r.text()),
      ]);

      const blob = new Blob([scriptText], { type: 'application/javascript' });
      this.#pdfjsScriptUrl = URL.createObjectURL(blob);

      const workerBlob = new Blob([workerText], { type: 'application/javascript' });
      const workerUrl  = URL.createObjectURL(workerBlob);

      this.#worker = new Worker(workerUrl);
      this.#worker.onmessage = (e) => this.#onMessage(e);
      this.#worker.onerror   = (e) => this.#onError(e);

      await this.#send('INIT_PDFJS', { workerScriptBlobUrl: this.#pdfjsScriptUrl });
    } catch (err) {
      console.warn('[ThumbnailWorker] Init failed:', err.message);
    }
  }

  async generateThumbnail(pageNumber, pdfBytes) {
    if (!this.#worker) return null;
    const cloned = pdfBytes.slice(0); // clone for transfer
    return this.#send('GENERATE_THUMBNAIL', { pageNumber, pdfBytes: cloned }, [cloned]);
  }

  #send(type, payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error('Worker timeout'));
          this.#respawn();
        }
      }, 30000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage({ type, id, payload }, transfer);
    });
  }

  #onMessage(e) {
    const { type, id, result, error } = e.data;
    const entry = this.#pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    if (error) entry.reject(new Error(error.message));
    else entry.resolve(result);
  }

  #onError(e) {
    console.error('[ThumbnailWorker] Error:', e.message);
    const now = Date.now();
    this.#crashCount = (now - this.#lastCrashTime < 60000) ? this.#crashCount + 1 : 1;
    this.#lastCrashTime = now;

    if (this.#crashCount >= 2) {
      for (const { timer, reject } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error('Worker permanently failed'));
      }
      this.#pending.clear();
      eventBus.emit('worker:crashed', { workerName: 'thumbnail-worker' });
      this.#worker = null;
      return;
    }
    this.#respawn();
  }

  async #respawn() {
    this.#worker?.terminate();
    this.#worker = null;
    // Reject all in-flight requests — they can't be delivered to the dead worker
    for (const { timer, reject } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('Worker respawning'));
    }
    this.#pending.clear();
    await this.#spawn();
  }
}

const thumbWorker = new ThumbnailWorkerManager();

// ---- Password Modal ----
function setupPasswordModal() {
  const modal    = document.getElementById('password-modal');
  const input    = document.getElementById('password-input');
  const errSpan  = document.getElementById('password-error');
  const cancelBtn= document.getElementById('password-cancel');
  const submitBtn= document.getElementById('password-submit');

  let pendingFile = null;
  let pendingBytes = null;

  eventBus.on('document:password-required', ({ file, arrayBuffer }) => {
    pendingFile  = file;
    pendingBytes = arrayBuffer;
    input.value  = '';
    errSpan.style.display = 'none';
    modal.classList.remove('hidden');
    input.focus();
    eventBus.emit('modal:open');
  });

  eventBus.on('document:password-wrong', () => {
    errSpan.style.display = '';
    input.value = '';
    input.focus();
  });

  const submit = () => {
    const pwd = input.value;
    if (!pwd) return;
    modal.classList.add('hidden');
    eventBus.emit('modal:close');
    documentEngine.openWithPassword(pendingBytes, pwd, pendingFile.name);
  };

  submitBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  cancelBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
    eventBus.emit('modal:close');
  });
}

// ---- File open helper ----
async function openFileDialog() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,application/pdf';
  input.multiple = false;
  input.click();
  return new Promise((resolve) => {
    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);
  });
}

// ---- Save As ----
async function saveAs() {
  if (stateManager.state.documentStatus !== 'ready') return;

  appRenderer.setSaveStatus('saving');
  appRenderer.toast('正在產生 PDF…', 'info', 8000);

  try {
    const blob = await documentEngine.exportToBlob();
    const name = documentEngine.fileName.replace(/\.pdf$/i, '') + '_annotated.pdf';

    if (capabilities.fileSystemAccess) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'PDF 檔案', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    appRenderer.setSaveStatus('saved');
    appRenderer.toast('已儲存', 'success');
  } catch (err) {
    if (err.name === 'AbortError') {
      appRenderer.setSaveStatus('saved');
      return; // user cancelled
    }
    appRenderer.setSaveStatus('error');
    appRenderer.toast(`儲存失敗：${err.message}`, 'error');
  }
}

// ---- Thumbnail generation ----
async function generateAllThumbnails(pageCount) {
  const pdfBytes = documentEngine.getRawBytes();
  if (!pdfBytes) return;
  const panel = document.getElementById('thumbnail-panel');

  for (let i = 1; i <= pageCount; i++) {
    // Build placeholder first
    let item = panel.querySelector(`[data-page="${i}"]`);
    if (!item) {
      item = document.createElement('div');
      item.className = 'thumbnail-item';
      item.setAttribute('data-page', i);
      item.setAttribute('role', 'listitem');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', `第 ${i} 頁`);

      const canvas = document.createElement('canvas');
      canvas.className = 'thumbnail-canvas';
      canvas.width  = 96;
      canvas.height = 128;
      canvas.style.width  = '96px';
      canvas.style.height = '128px';

      const label = document.createElement('span');
      label.className = 'thumbnail-label';
      label.textContent = i;

      item.appendChild(canvas);
      item.appendChild(label);

      item.addEventListener('click', () => {
        eventBus.emit('ui:action', { action: 'page-navigate', page: i });
      });

      panel.appendChild(item);
    }

    // Generate thumbnail asynchronously (yield between pages)
    await new Promise(r => setTimeout(r, 0));

    try {
      const result = await thumbWorker.generateThumbnail(i, pdfBytes);
      if (!result?.imageBitmap) continue;

      const canvas = item.querySelector('canvas');
      canvas.width  = result.imageBitmap.width;
      canvas.height = result.imageBitmap.height;
      canvas.style.width  = '96px';
      canvas.style.height = `${Math.round(96 * result.imageBitmap.height / result.imageBitmap.width)}px`;
      canvas.getContext('2d').drawImage(result.imageBitmap, 0, 0);
      result.imageBitmap.close();
    } catch {
      // Non-fatal: thumbnail stays as placeholder
    }
  }
}

function updateThumbnailHighlight(pageNumber) {
  const panel = document.getElementById('thumbnail-panel');
  panel.querySelector('.thumbnail-item.active')?.classList.remove('active');
  panel.querySelector(`.thumbnail-item[data-page="${pageNumber}"]`)?.classList.add('active');
}

// ---- UI Action Router ----
function handleAction({ action, value, page, files, source }) {
  const state = stateManager.state;

  switch (action) {
    // --- File ---
    case 'open':
      openFileDialog().then(f => f && documentEngine.openFile(f));
      break;
    case 'open-files':
      if (files?.length) documentEngine.openFile(files[0]);
      break;
    case 'save-as':
      saveAs();
      break;
    case 'close':
      stateManager.reset();
      commandStack.clear();
      document.getElementById('thumbnail-panel').innerHTML = '';
      break;

    // --- Edit ---
    case 'undo':
    case 'command:undo':
      commandStack.undo();
      break;
    case 'redo':
    case 'command:redo':
      commandStack.redo();
      break;
    case 'select-all':
      break; // TODO v0.5
    case 'delete':
      break; // TODO v0.5

    // --- Tools ---
    case 'tool-select':
    case 'tool-highlight':
    case 'tool-draw':
    case 'tool-text':
    case 'tool-rect': {
      const toolName = action.replace('tool-', '');
      stateManager.patch({ selectedTool: toolName });
      document.getElementById('annotation-layer-root')
        .querySelector('svg')
        ?.style.setProperty('cursor', toolName === 'select' ? 'default' : 'crosshair');
      break;
    }

    // --- View ---
    case 'zoom-in':
      stateManager.patch({ zoom: Math.min(4, state.zoom + 0.1), zoomMode: 'custom' });
      break;
    case 'zoom-out':
      stateManager.patch({ zoom: Math.max(0.25, state.zoom - 0.1), zoomMode: 'custom' });
      break;
    case 'zoom-set':
      if (value > 0) stateManager.patch({ zoom: Math.min(4, Math.max(0.25, value)), zoomMode: 'custom' });
      break;
    case 'fit-width':
      stateManager.patch({ zoomMode: 'fitWidth' });
      break;
    case 'fit-page':
      stateManager.patch({ zoomMode: 'fitPage' });
      break;
    case 'toggle-sidebar':
      stateManager.patch({ sidebarOpen: !state.sidebarOpen });
      // state.sidebarOpen = old value (true=was open → now closing → add 'sidebar-closed')
      document.getElementById('workspace').classList.toggle('sidebar-closed', state.sidebarOpen);
      break;
    case 'toggle-inspector':
      stateManager.patch({ inspectorOpen: !state.inspectorOpen });
      document.getElementById('workspace').classList.toggle('inspector-closed', state.inspectorOpen);
      break;
    case 'dark-mode':
      document.documentElement.setAttribute(
        'data-theme',
        document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      );
      break;

    // --- Navigation ---
    case 'page-prev':
      if (state.currentPage > 1) {
        const p = state.currentPage - 1;
        stateManager.patch({ currentPage: p });
        eventBus.emit('page:navigate', { targetPage: p });
      }
      break;
    case 'page-next':
      if (state.currentPage < state.pageCount) {
        const p = state.currentPage + 1;
        stateManager.patch({ currentPage: p });
        eventBus.emit('page:navigate', { targetPage: p });
      }
      break;
    case 'page-navigate':
      if (page >= 1 && page <= state.pageCount) {
        stateManager.patch({ currentPage: page });
        eventBus.emit('page:navigate', { targetPage: page });
      }
      break;

    // --- Tools menu ---
    case 'clear-sessions':
      sessionDB.clearAll().then(() => appRenderer.toast('Session 資料已清除', 'success'));
      break;

    case 'about':
      appRenderer.toast('OpenSpec PDF Editor v0.1.0-alpha — 離線 PDF 工具', 'info', 5000);
      break;
  }
}

// ---- Main Init ----
async function main() {
  console.log('[OpenSpec] Initializing v0.1.0-alpha');

  // 1. Init DocumentEngine Worker (sync — no fetch, no await needed)
  documentEngine.initWorker();

  // 2. Init layers (sync)
  canvasLayer.init(documentEngine);
  annotationLayer.init(canvasLayer);

  // 3. Init UI chrome immediately so user sees the shell
  appRenderer.init();
  keyMap.init();
  setupPasswordModal();

  // 4. Wire EventBus handlers

  // Document lifecycle
  eventBus.on('document:open-requested', () => {
    stateManager.patch({ documentStatus: 'loading', errorMessage: null });
    appRenderer.showProgress(10, '讀取檔案...');
    document.getElementById('thumbnail-panel').innerHTML = '';
  });

  eventBus.on('document:loaded', async ({ pageCount, fileName, fileHash }) => {
    stateManager.patch({
      documentStatus: 'ready',
      pageCount,
      currentPage: 1,
      zoom: 1.0,
      zoomMode: 'fitWidth',
      sessionRestored: false,
    });
    appRenderer.hideProgress();
    document.getElementById('status-filename').textContent = fileName;

    // Session restore
    const session = await sessionDB.load(fileHash);
    if (session?.annotations?.length) {
      annotationLayer.restoreAnnotations(session.annotations);
      stateManager.patch({ sessionRestored: true, currentPage: session.lastPage ?? 1 });
      appRenderer.toast('已還原上次工作', 'success');
    }

    // Generate thumbnails (background)
    generateAllThumbnails(pageCount);
    updateThumbnailHighlight(1);
  });

  eventBus.on('document:load-failed', ({ reason }) => {
    stateManager.patch({ documentStatus: 'error', errorMessage: reason });
    appRenderer.hideProgress();
    appRenderer.toast(reason, 'error', 6000);
  });

  eventBus.on('document:load-warning', ({ message }) => {
    appRenderer.toast(message, 'info', 5000);
  });

  // Page navigation
  eventBus.on('page:navigate', ({ targetPage }) => {
    stateManager.patch({ currentPage: targetPage });
    updateThumbnailHighlight(targetPage);
  });

  // Annotation changes → auto-save
  let saveStatusTimer = null;
  eventBus.on('annotations:changed', () => {
    const { documentStatus, currentPage, zoom } = stateManager.state;
    if (documentStatus !== 'ready') return;
    appRenderer.setSaveStatus('saving');
    sessionDB.save(documentEngine.fileHash, {
      annotations: annotationLayer.getAllAnnotations(),
      lastPage: currentPage,
      lastZoom: zoom,
      fileName: documentEngine.fileName,
    });
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => appRenderer.setSaveStatus('saved'), SAVE_STATUS_DISPLAY_MS);
  });

  // CommandStack changes → update menu disabled states
  eventBus.on('command:stack-changed', (cmdState) => {
    appRenderer.renderShell(stateManager.state, cmdState);
  });

  // Worker crashed
  eventBus.on('worker:crashed', ({ workerName }) => {
    appRenderer.toast(`${workerName} 暫時不可用，縮圖功能已停用。`, 'error', 5000);
  });

  // UI actions from menus, toolbar, keyboard
  eventBus.on('ui:action', handleAction);

  // State changes → re-render UI chrome
  stateManager.subscribe(({ changed }) => {
    const uiKeys = ['documentStatus', 'currentPage', 'pageCount', 'zoom', 'zoomMode', 'selectedTool'];
    if (changed.some(k => uiKeys.includes(k))) {
      appRenderer.renderShell(stateManager.state, {
        canUndo: commandStack.canUndo,
        canRedo: commandStack.canRedo,
      });
    }
  });

  // Save on page unload
  window.addEventListener('beforeunload', () => {
    const state = stateManager.state;
    if (state.documentStatus === 'ready' && documentEngine.fileHash) {
      sessionDB.saveNow(documentEngine.fileHash, {
        annotations: annotationLayer.getAllAnnotations(),
        lastPage: state.currentPage,
        lastZoom: state.zoom,
        fileName: documentEngine.fileName,
      });
    }
  });

  // 5. Initial render — UI visible before any async work
  appRenderer.renderShell(stateManager.state, { canUndo: false, canRedo: false });

  // 6. Async background init (non-blocking — UI already painted)
  sessionDB.init()
    .then(() => sessionDB.cleanOld())
    .catch(err => console.warn('[SessionDB] Init failed:', err.message));

  if (capabilities.offscreenCanvas) {
    thumbWorker.init().catch(err => {
      console.warn('[ThumbnailWorker] Init failed:', err.message);
    });
  }

  console.log('[OpenSpec] Ready. Capabilities:', capabilities);
}

main().catch(err => {
  console.error('[OpenSpec] Fatal init error:', err);
  document.getElementById('load-error').innerHTML =
    `<h2>初始化失敗</h2><p>${err.message}</p>`;
  document.getElementById('load-error').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
});
