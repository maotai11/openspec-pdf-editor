/**
 * DocumentEngine.js
 * Owns PDF binary state. Dual-loads pdf.js (render) + pdf-lib (edit/export).
 *
 * file:// 安全策略：
 *   - fetch() 在 Chrome file:// 被 CORS 封鎖，改用直接路徑設定 workerSrc
 *   - pdf.js 內部以 new Worker(workerSrc) 建立 Worker，此方式在 file:// 可正常運作
 */

import { eventBus } from './EventBus.js';

const MAGIC_BYTES = '%PDF-';
const MAX_FILE_BYTES  = 150 * 1024 * 1024; // 150 MB hard limit
const WARN_FILE_BYTES = 100 * 1024 * 1024; // 100 MB soft warning

class DocumentEngine {
  #pdfjsDoc  = null;
  #pdfLibDoc = null;
  #pdfBytes  = null;
  #fileHash  = null;
  #fileName  = null;
  #workerInitialized = false;

  get pageCount() { return this.#pdfjsDoc?.numPages ?? 0; }
  get fileName()  { return this.#fileName; }
  get fileHash()  { return this.#fileHash; }

  /**
   * 初始化 pdf.js Worker（同步，無 fetch）。
   * 直接設定 workerSrc 為相對路徑，pdf.js 內部 new Worker() 在 file:// 可用。
   */
  initWorker() {
    if (this.#workerInitialized) return;
    try {
      // 直接路徑方式，不依賴 fetch()，相容 file:// 協定
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';
      this.#workerInitialized = true;
    } catch (err) {
      // 若 pdf.js 未載入，降級為無 Worker 模式（主線程解析，速度較慢但可用）
      console.warn('[DocumentEngine] pdf.js not available, worker disabled:', err.message);
      this.#workerInitialized = true; // 繼續，不阻塞 UI
    }
  }

  async openFile(file) {
    eventBus.emit('document:open-requested', { file });

    if (!this.#validateMime(file)) {
      eventBus.emit('document:load-failed', {
        reason: `"${file.name}" 不是有效的 PDF 檔案。`,
        code: 'INVALID_FORMAT',
      });
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      eventBus.emit('document:load-failed', {
        reason: `檔案過大（${this.#formatSize(file.size)}），上限 150MB。`,
        code: 'FILE_TOO_LARGE',
      });
      return;
    }

    if (file.size > WARN_FILE_BYTES) {
      eventBus.emit('document:load-warning', {
        message: `檔案較大（${this.#formatSize(file.size)}），大型文件可能影響效能。`,
      });
    }

    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch {
      eventBus.emit('document:load-failed', { reason: '讀取檔案失敗。', code: 'READ_ERROR' });
      return;
    }

    if (!this.#validateMagicBytes(arrayBuffer)) {
      eventBus.emit('document:load-failed', {
        reason: `"${file.name}" 的檔案內容不是有效的 PDF 格式。`,
        code: 'INVALID_FORMAT',
      });
      return;
    }

    this.#fileName = file.name;
    this.#pdfBytes = arrayBuffer;

    try {
      const [pdfjsDoc, pdfLibDoc, hash] = await Promise.all([
        this.#loadWithPdfJs(arrayBuffer),
        this.#loadWithPdfLib(arrayBuffer),
        this.#computeHash(arrayBuffer),
      ]);
      this.#pdfjsDoc  = pdfjsDoc;
      this.#pdfLibDoc = pdfLibDoc;
      this.#fileHash  = hash;
      eventBus.emit('document:loaded', {
        pageCount: pdfjsDoc.numPages,
        fileName:  file.name,
        fileHash:  hash,
      });
    } catch (err) {
      if (err?.name === 'PasswordException') {
        eventBus.emit('document:password-required', { file, arrayBuffer });
        return;
      }
      console.error('[DocumentEngine] Load failed:', err);
      eventBus.emit('document:load-failed', {
        reason: `PDF 載入失敗：${err.message ?? '未知錯誤'}`,
        code: 'PARSE_ERROR',
      });
    }
  }

  async openWithPassword(arrayBuffer, password, fileName) {
    this.#fileName = fileName;
    this.#pdfBytes = arrayBuffer;
    try {
      const [pdfjsDoc, pdfLibDoc, hash] = await Promise.all([
        this.#loadWithPdfJs(arrayBuffer, password),
        this.#loadWithPdfLib(arrayBuffer, password),
        this.#computeHash(arrayBuffer),
      ]);
      this.#pdfjsDoc  = pdfjsDoc;
      this.#pdfLibDoc = pdfLibDoc;
      this.#fileHash  = hash;
      eventBus.emit('document:loaded', {
        pageCount: pdfjsDoc.numPages,
        fileName,
        fileHash: hash,
      });
    } catch (err) {
      if (err?.name === 'PasswordException') {
        eventBus.emit('document:password-wrong', {});
        return;
      }
      eventBus.emit('document:load-failed', {
        reason: `解密失敗：${err.message}`,
        code: 'DECRYPT_ERROR',
      });
    }
  }

  async getPage(pageNumber) {
    if (!this.#pdfjsDoc) throw new Error('No document loaded.');
    return this.#pdfjsDoc.getPage(pageNumber);
  }

  async exportToBlob() {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const bytes = await this.#pdfLibDoc.save();
    return new Blob([bytes], { type: 'application/pdf' });
  }

  getRawBytes() { return this.#pdfBytes; }

  // ---- Private ----

  #validateMime(file) {
    return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  }

  #validateMagicBytes(buf) {
    const header = String.fromCharCode(...new Uint8Array(buf, 0, 5));
    return header === MAGIC_BYTES;
  }

  async #loadWithPdfJs(arrayBuffer, password) {
    const task = window.pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      password,
      enableXfa: false,
    });
    return task.promise;
  }

  async #loadWithPdfLib(arrayBuffer, password) {
    const opts = password ? { password } : {};
    return window.PDFLib.PDFDocument.load(arrayBuffer, opts);
  }

  async #computeHash(arrayBuffer) {
    const buf = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  #formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
}

export const documentEngine = new DocumentEngine();
export default DocumentEngine;
