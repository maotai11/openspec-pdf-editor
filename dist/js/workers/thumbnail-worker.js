/**
 * thumbnail-worker.js
 * Generates PDF page thumbnails as ImageBitmap (off-thread).
 * Loaded via Blob URL for file:// safety.
 *
 * Message protocol (SPEC.md Section 7.3):
 *   Request:  { type: 'GENERATE_THUMBNAIL', id, payload: { pageNumber, pdfBytes } }
 *   Response: { type: 'GENERATE_THUMBNAIL', id, result: { imageBitmap } }  [transfer]
 *   Error:    { type: 'GENERATE_THUMBNAIL', id, error: { message, code } }
 *
 * Note: pdfBytes (ArrayBuffer) should be transferred, not copied.
 */

const THUMB_WIDTH = 96; // px

// pdf.js must be imported inside Worker
// We receive pdfjsLib via importScripts equivalent — loaded as UMD global
// The Worker receives the pdf.js script text from the main thread on first message.

let pdfjsReady = false;
let pdfjsLib = null;
let pdfDocCache = null; // cache the loaded PDFDocumentProxy
let cachedPdfBytes = null;

self.onmessage = async (e) => {
  const { type, id, payload } = e.data;

  if (type === 'INIT_PDFJS') {
    // Main thread sends pdf.js script text; eval it to get the global
    try {
      // Use importScripts with Blob URL sent from main thread
      importScripts(payload.workerScriptBlobUrl);
      pdfjsLib = self.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = ''; // no nested worker
      pdfjsReady = true;
      self.postMessage({ type: 'INIT_PDFJS', id, result: { ok: true } });
    } catch (err) {
      self.postMessage({ type: 'INIT_PDFJS', id, error: { message: err.message, code: 'INIT_FAILED' } });
    }
    return;
  }

  if (type === 'GENERATE_THUMBNAIL') {
    if (!pdfjsReady) {
      self.postMessage({ type, id, error: { message: 'pdf.js not initialized', code: 'NOT_READY' } });
      return;
    }

    const { pageNumber, pdfBytes } = payload;

    try {
      // Re-use loaded document if same bytes
      if (!pdfDocCache || cachedPdfBytes !== pdfBytes) {
        pdfDocCache = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), enableXfa: false }).promise;
        cachedPdfBytes = pdfBytes;
      }

      const page = await pdfDocCache.getPage(pageNumber);
      const naturalVp = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / naturalVp.width;
      const viewport = page.getViewport({ scale });

      const canvas = new OffscreenCanvas(
        Math.round(viewport.width),
        Math.round(viewport.height)
      );
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const imageBitmap = await createImageBitmap(canvas);

      self.postMessage(
        { type, id, result: { imageBitmap, pageNumber } },
        [imageBitmap]  // transfer
      );
    } catch (err) {
      self.postMessage({ type, id, error: { message: err.message, code: 'RENDER_FAILED' } });
    }
    return;
  }

  if (type === 'CLEAR_CACHE') {
    pdfDocCache = null;
    cachedPdfBytes = null;
    self.postMessage({ type, id, result: { ok: true } });
    return;
  }

  self.postMessage({ type, id, error: { message: `Unknown message type: ${type}`, code: 'UNKNOWN' } });
};
