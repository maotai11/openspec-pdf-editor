/**
 * DocumentEngine.js
 * Owns PDF binary state. Dual-loads pdf.js (render) + pdf-lib (edit/export).
 * Runs entirely on the main thread — no Workers (file:// null-origin restriction).
 */

import fontkit from '@pdf-lib/fontkit';
import notoSansTcRegular from '../../assets/fonts/NotoSansTC-Regular.ttf';
import { eventBus } from './EventBus.js';
import {
  buildArrowHeadSegments,
  buildLineSegmentsFromPathData,
  buildRectangleOutlineSegments,
  buildRotatedLineSegmentsFromPathData,
  buildStampExportLayout,
  buildTextLineLayouts,
  clampPointGeometry,
  getPdfRotationForScreenRotation,
  normalizeAnnotationRotation,
  normalizeLineGeometry,
  normalizeRectGeometry,
  rotatePoint,
} from './AnnotationExport.js';
import { resolveImageWatermarkLayout, resolvePageNumberLayout, resolveWatermarkLayout } from './LayoutPresets.js';
import { embedImageFile } from './ImageAsset.js';
import { getVisualViewport, visualEdgeInsetsToPdfEdgeInsets, visualLayoutPointToPdf } from './PageGeometry.js';
import { buildTypedSignaturePreset } from './SignatureAsset.js';
import { normalizeTextRun } from './TextMarkup.js';

const MAGIC_BYTES = '%PDF-';
const MAX_FILE_BYTES  = 150 * 1024 * 1024; // 150 MB hard limit
const WARN_FILE_BYTES = 100 * 1024 * 1024; // 100 MB soft warning

class DocumentEngine {
  #pdfjsDoc  = null;
  #pdfLibDoc = null;
  #pdfBytes  = null;
  #fileHash  = null;
  #fileName  = null;
  #fileLastModified = null;
  #pageTextCache = new Map();

  get pageCount() { return this.#pdfjsDoc?.numPages ?? 0; }
  get fileName()  { return this.#fileName; }
  get fileHash()  { return this.#fileHash; }
  get fileLastModified() { return this.#fileLastModified; }

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
    this.#fileLastModified = Number(file.lastModified) || null;
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
      this.#clearPageTextCache();
      eventBus.emit('document:loaded', {
        pageCount: pdfjsDoc.numPages,
        fileName:  file.name,
        fileHash:  hash,
        currentPage: 1,
        source: 'open',
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
      this.#clearPageTextCache();
      eventBus.emit('document:loaded', {
        pageCount: pdfjsDoc.numPages,
        fileName,
        fileHash: hash,
        currentPage: 1,
        source: 'open',
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

  async createSnapshotBytes() {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    return this.#pdfLibDoc.save();
  }

  async getPageTextRuns(pageNumber) {
    if (!this.#pdfjsDoc) return [];
    const cacheKey = `${this.#fileHash ?? 'live'}:${pageNumber}`;
    if (!this.#pageTextCache.has(cacheKey)) {
      const page = await this.getPage(pageNumber);
      const textContent = await page.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      const styles = textContent.styles ?? {};
      const runs = (textContent.items ?? [])
        .filter((item) => typeof item?.str === 'string' && item.str.trim())
        .map((item) => normalizeTextRun(item, styles[item.fontName] ?? {}))
        .filter((run) => run.width > 0 && run.height > 0);
      this.#pageTextCache.set(cacheKey, runs);
    }

    return this.#pageTextCache.get(cacheKey).map((run) => ({
      ...run,
      baselineStart: { ...run.baselineStart },
      baselineEnd: { ...run.baselineEnd },
    }));
  }

  async restoreFromBytes(bytes, currentPage = 1) {
    if (!bytes) throw new Error('No snapshot bytes provided.');
    const cleanBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const [pdfLibDoc, pdfjsDoc, hash] = await Promise.all([
      this.#loadWithPdfLib(cleanBuf.slice(0)),
      this.#loadWithPdfJs(new Uint8Array(cleanBuf.slice(0))),
      this.#computeHash(cleanBuf),
    ]);

    this.#pdfLibDoc = pdfLibDoc;
    this.#pdfjsDoc = pdfjsDoc;
    this.#pdfBytes = cleanBuf;
    this.#fileHash = hash;
    this.#fileLastModified ??= Date.now();
    this.#clearPageTextCache();

    eventBus.emit('document:loaded', {
      pageCount: pdfjsDoc.numPages,
      fileName: this.#fileName,
      fileHash: hash,
      currentPage: Math.min(Math.max(currentPage, 1), pdfjsDoc.numPages || 1),
      source: 'mutation',
    });
  }

  /**
   * Export to Blob. If annotations array is supplied, embed them into a COPY
   * so the in-memory document is never permanently modified.
   */
  async exportToBlob(annotations = [], options = {}) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const flattenAnnotations = options.flattenAnnotations !== false;
    const metadata = options.metadata ?? {};
    const needsMetadataCopy = this.#hasMetadataOverrides(metadata);

    if ((!flattenAnnotations || annotations.length === 0) && !needsMetadataCopy) {
      const bytes = await this.#pdfLibDoc.save();
      return new Blob([bytes], { type: 'application/pdf' });
    }

    // Work on a temporary copy — keeps the live document clean for repeated exports
    const srcBytes = await this.#pdfLibDoc.save();
    const tmpDoc   = await window.PDFLib.PDFDocument.load(srcBytes);
    this.#applyExportMetadata(tmpDoc, metadata);
    if (flattenAnnotations && annotations.length > 0) {
      await this.#embedAnnotationsInto(tmpDoc, annotations);
    }
    const outBytes = await tmpDoc.save();
    return new Blob([outBytes], { type: 'application/pdf' });
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

  async #loadWithPdfJs(data, password) {
    // Accept both ArrayBuffer and Uint8Array; avoid bytes.buffer which may have padding.
    const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const task = window.pdfjsLib.getDocument({ data: uint8, password, enableXfa: false });
    return task.promise;
  }

  async #loadWithPdfLib(arrayBuffer, password) {
    const opts = password ? { password } : {};
    return window.PDFLib.PDFDocument.load(arrayBuffer, opts);
  }

  async #computeHash(data) {
    // crypto.subtle.digest requires ArrayBuffer; extract correct slice from typed arrays.
    const buf = data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data;
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  #formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  /**
   * Embed annotations into a pdf-lib doc (private helper used by exportToBlob).
   */
  async #embedAnnotationsInto(pdfDoc, annotations) {
    const { degrees, rgb } = window.PDFLib;
    const textFont = await this.#embedAnnotationFont(pdfDoc, annotations);
    const byPage = new Map();
    for (const ann of annotations) {
      if (!byPage.has(ann.pageNumber)) byPage.set(ann.pageNumber, []);
      byPage.get(ann.pageNumber).push(ann);
    }
    for (const [pageNum, anns] of byPage) {
      const pageIndex = pageNum - 1;
      if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;
      const page = pdfDoc.getPage(pageIndex);
      const box = this.#getPageBox(page);
      for (const ann of anns) {
        try {
          if (ann.type === 'highlight') {
            const g = normalizeRectGeometry(ann.geometry, box.width, box.height, box.x, box.y);
            if (!g.width || !g.height) continue;
            const c = this.#hexToRgb(ann.style?.color ?? '#FFFF00');
            page.drawRectangle({
              x: g.x,
              y: g.y,
              width: g.width,
              height: g.height,
              color: rgb(c.r, c.g, c.b),
              opacity: ann.style?.opacity ?? 0.4,
            });
          } else if (ann.type === 'rect') {
            const g = normalizeRectGeometry(ann.geometry, box.width, box.height, box.x, box.y);
            if (!g.width || !g.height) continue;
            const c = this.#hexToRgb(ann.style?.color ?? '#0066CC');
            const rotation = normalizeAnnotationRotation(ann.style?.rotation ?? 0);
            if (rotation === 0) {
              page.drawRectangle({
                x: g.x,
                y: g.y,
                width: g.width,
                height: g.height,
                borderColor: rgb(c.r, c.g, c.b),
                borderWidth: ann.style?.strokeWidth ?? 1.5,
                borderOpacity: ann.style?.opacity ?? 1,
              });
            } else {
              const segments = buildRectangleOutlineSegments(g, box.width, box.height, box.x, box.y, rotation);
              for (const segment of segments) {
                page.drawLine({
                  start: segment.start,
                  end: segment.end,
                  color: rgb(c.r, c.g, c.b),
                  thickness: ann.style?.strokeWidth ?? 1.5,
                  opacity: ann.style?.opacity ?? 1,
                });
              }
            }
          } else if (ann.type === 'circle') {
            const g = normalizeRectGeometry(ann.geometry, box.width, box.height, box.x, box.y);
            if (!g.width || !g.height) continue;
            const c = this.#hexToRgb(ann.style?.color ?? '#4472C4');
            page.drawEllipse({
              x: g.x + (g.width / 2),
              y: g.y + (g.height / 2),
              xScale: g.width / 2,
              yScale: g.height / 2,
              borderColor: rgb(c.r, c.g, c.b),
              borderWidth: ann.style?.strokeWidth ?? 1.5,
              borderOpacity: ann.style?.opacity ?? 1,
            });
          } else if (ann.type === 'line' || ann.type === 'arrow' || ann.type === 'underline') {
            const g = normalizeLineGeometry(ann.geometry, box.width, box.height, box.x, box.y);
            const c = this.#hexToRgb(ann.style?.color ?? '#4472C4');
            page.drawLine({
              start: { x: g.x1, y: g.y1 },
              end: { x: g.x2, y: g.y2 },
              color: rgb(c.r, c.g, c.b),
              thickness: ann.style?.strokeWidth ?? 2,
              opacity: ann.style?.opacity ?? 1,
            });
            if (ann.type === 'arrow') {
              const headSegments = buildArrowHeadSegments(
                { x: g.x1, y: g.y1 },
                { x: g.x2, y: g.y2 },
                Math.max(10, (ann.style?.strokeWidth ?? 2) * 5),
                26,
              );
              for (const segment of headSegments) {
                page.drawLine({
                  start: segment.start,
                  end: segment.end,
                  color: rgb(c.r, c.g, c.b),
                  thickness: ann.style?.strokeWidth ?? 2,
                  opacity: ann.style?.opacity ?? 1,
                });
              }
            }
          } else if (ann.type === 'text') {
            if (await this.#drawTextAnnotationAsImage(pdfDoc, page, ann, box)) {
              continue;
            }
            const text = String(ann.content ?? '');
            if (!text) continue;
            const c = this.#hexToRgb(ann.style?.color ?? '#000000');
            const fontSize = ann.style?.fontSize ?? 12;
            const lineHeight = fontSize * 1.2;
            const anchor = clampPointGeometry(
              ann.geometry,
              box.width,
              box.height,
              box.x,
              box.y,
              0,
              fontSize,
            );
            const lines = text.split(/\r?\n/).filter(Boolean);
            const lineLayouts = buildTextLineLayouts({
              anchor,
              lineWidths: lines.map((line) => textFont.widthOfTextAtSize(line, fontSize)),
              lineHeight,
              rotation: ann.style?.rotation ?? 0,
            });
            lineLayouts.forEach((point, index) => {
              page.drawText(lines[index], {
                x: point.x,
                y: point.y,
                size: fontSize,
                color: rgb(c.r, c.g, c.b),
                font: textFont,
                lineHeight,
                rotate: degrees(point.rotation),
              });
            });
          } else if (ann.type === 'draw') {
            const c = this.#hexToRgb(ann.style?.color ?? '#CC0000');
            const rotation = normalizeAnnotationRotation(ann.style?.rotation ?? 0);
            const segments = rotation === 0
              ? buildLineSegmentsFromPathData(
                ann.geometry?.pathData ?? '',
                box.width,
                box.height,
                box.x,
                box.y,
              )
              : buildRotatedLineSegmentsFromPathData(
              ann.geometry?.pathData ?? '',
              rotation,
              box.width,
              box.height,
              box.x,
              box.y,
            );
            for (const segment of segments) {
              page.drawLine({
                start: segment.start,
                end: segment.end,
                color: rgb(c.r, c.g, c.b),
                thickness: ann.style?.strokeWidth ?? 2,
                opacity: ann.style?.opacity ?? 1,
              });
            }
          } else if (ann.type === 'stamp') {
            if (await this.#drawStampAnnotationAsImage(pdfDoc, page, ann, box)) {
              continue;
            }
            const g = normalizeRectGeometry(ann.geometry, box.width, box.height, box.x, box.y);
            if (!g.width || !g.height) continue;
            const c = this.#hexToRgb(ann.style?.color ?? '#C00000');
            const rotation = normalizeAnnotationRotation(ann.style?.rotation ?? 0);
            const fontSize = ann.style?.fontSize ?? Math.max(11, Math.min(g.width, g.height) * 0.16);
            const lines = String(ann.content ?? '電子印章').split(/\r?\n/).filter(Boolean).slice(0, 2);
            const lineHeight = Math.max(fontSize * 1.2, g.height * 0.32);
            const stampLayout = buildStampExportLayout(g, {
              rotation,
              lineWidths: lines.map((line) => textFont.widthOfTextAtSize(line, fontSize)),
              lineHeight,
            });
            page.drawEllipse({
              x: g.x + (g.width / 2),
              y: g.y + (g.height / 2),
              xScale: g.width / 2,
              yScale: g.height / 2,
              borderColor: rgb(c.r, c.g, c.b),
              borderWidth: ann.style?.strokeWidth ?? 1.5,
              borderOpacity: ann.style?.opacity ?? 1,
              rotate: degrees(getPdfRotationForScreenRotation(rotation)),
            });
            page.drawLine({
              start: stampLayout.divider.start,
              end: stampLayout.divider.end,
              color: rgb(c.r, c.g, c.b),
              thickness: Math.max(1, (ann.style?.strokeWidth ?? 1.5) * 0.8),
              opacity: ann.style?.opacity ?? 1,
            });
            {
            const lines = String(ann.content ?? '電子印章').split(/\r?\n/).filter(Boolean).slice(0, 2);
            const fontSize = ann.style?.fontSize ?? Math.max(11, Math.min(g.width, g.height) * 0.16);
            lines.forEach((line, index) => {
              if (!line) return;
              const point = stampLayout.textLines[index] ?? stampLayout.textLines[stampLayout.textLines.length - 1];
              if (!point) return;
              page.drawText(line, {
                x: point.x,
                y: point.y,
                size: fontSize,
                color: rgb(c.r, c.g, c.b),
                font: textFont,
                lineHeight,
                rotate: degrees(point.rotation),
              });
            });
            }
          } else if (ann.type === 'signature') {
            if (await this.#drawSignatureAnnotationAsImage(pdfDoc, page, ann, box)) {
              continue;
            }
          }
        } catch { /* skip individual annotation errors */ }
      }
    }
  }

  async #drawTextAnnotationAsImage(pdfDoc, page, annotation, box) {
    const text = String(annotation.content ?? '').trim();
    if (!text) return false;

    try {
      const fontSize = annotation.style?.fontSize ?? 12;
      const lineHeight = fontSize * 1.2;
      const rotation = normalizeAnnotationRotation(annotation.style?.rotation ?? 0);
      const opacity = annotation.style?.opacity ?? 1;
      const color = annotation.style?.color ?? '#000000';
      const anchor = clampPointGeometry(
        annotation.geometry,
        box.width,
        box.height,
        box.x,
        box.y,
        0,
        fontSize,
      );
      const lines = text.split(/\r?\n/).filter(Boolean);
      const metrics = this.#measurePreviewTextLines(lines, fontSize);
      const corners = [
        { x: 0, y: -metrics.ascent },
        { x: metrics.maxWidth, y: -metrics.ascent },
        { x: metrics.maxWidth, y: -metrics.ascent + metrics.blockHeight },
        { x: 0, y: -metrics.ascent + metrics.blockHeight },
      ].map((point) => rotatePoint(point, { x: 0, y: 0 }, rotation));
      const bounds = this.#getPointBounds(corners);
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}">`,
        `<g transform="translate(${-bounds.minX} ${-bounds.minY})">`,
        `<g transform="rotate(${rotation} 0 0)">`,
        ...lines.map((line, index) => [
          `<text x="0" y="${index * lineHeight}"`,
          ` fill="${color}"`,
          ` font-size="${fontSize}"`,
          ' font-family="Microsoft JhengHei, PingFang TC, sans-serif"',
          ' xml:space="preserve"',
          `>${this.#escapeSvgText(line)}</text>`,
        ].join('')),
        '</g>',
        '</g>',
        '</svg>',
      ].join('');
      const pngBytes = await this.#svgMarkupToPngBytes(svg, bounds.width, bounds.height, 3);
      const image = await pdfDoc.embedPng(pngBytes);
      page.drawImage(image, {
        x: anchor.x + bounds.minX,
        y: anchor.y - bounds.maxY,
        width: bounds.width,
        height: bounds.height,
        opacity,
      });
      return true;
    } catch (error) {
      console.warn('[DocumentEngine] Text image export fallback failed:', error);
      return false;
    }
  }

  async #drawStampAnnotationAsImage(pdfDoc, page, annotation, box) {
    const g = normalizeRectGeometry(annotation.geometry, box.width, box.height, box.x, box.y);
    if (!g.width || !g.height) return false;

    try {
      const pageRot = page.getRotation().angle;
      const isRotated = pageRot === 90 || pageRot === 270;
      const rotation = normalizeAnnotationRotation(annotation.style?.rotation ?? 0);
      const opacity = annotation.style?.opacity ?? 1;
      const color = annotation.style?.color ?? '#C00000';
      const strokeWidth = annotation.style?.strokeWidth ?? 1.5;
      const fontSize = annotation.style?.fontSize ?? Math.max(11, Math.min(g.width, g.height) * 0.16);
      const lines = String(annotation.content ?? '電子印章').split(/\r?\n/).filter(Boolean).slice(0, 2);
      const center = { x: g.width / 2, y: g.height / 2 };
      const bounds = this.#getPointBounds([
        { x: 0, y: 0 },
        { x: g.width, y: 0 },
        { x: g.width, y: g.height },
        { x: 0, y: g.height },
      ].map((point) => rotatePoint(point, center, rotation)));
      // Mirror AnnotationLayer#buildStampElement proportions exactly
      const hasDate = lines.length > 1;
      const line1Y = hasDate ? g.height * 0.42 : g.height * 0.54;
      const line2Y = g.height * 0.74;
      const dividerY = g.height * 0.56;
      // SVG 渲染尺寸：旋轉頁時使用視覺尺寸（寬高互換）
      const svgW = isRotated ? bounds.height : bounds.width;
      const svgH = isRotated ? bounds.width : bounds.height;
      const scale = svgW / Math.max(1, bounds.width);
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${bounds.width} ${bounds.height}">`,
        `<g transform="translate(${-bounds.minX} ${-bounds.minY})">`,
        `<g transform="rotate(${rotation} ${center.x} ${center.y})">`,
        `<ellipse cx="${center.x}" cy="${center.y}" rx="${g.width / 2}" ry="${g.height / 2}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>`,
        hasDate ? `<line x1="${g.width * 0.18}" y1="${dividerY}" x2="${g.width * 0.82}" y2="${dividerY}" stroke="${color}" stroke-width="${Math.max(1, strokeWidth * 0.8)}"/>` : '',
        `<text x="${center.x}" y="${line1Y}"`,
        ` fill="${color}"`,
        ` font-size="${fontSize}"`,
        ' font-family="Microsoft JhengHei, PingFang TC, system-ui, sans-serif"',
        ' font-weight="600"',
        ' text-anchor="middle"',
        ' dominant-baseline="middle"',
        ` xml:space="preserve">${this.#escapeSvgText(lines[0])}</text>`,
        hasDate ? [
          `<text x="${center.x}" y="${line2Y}"`,
          ` fill="${color}"`,
          ` font-size="${Math.max(8, fontSize * 0.72)}"`,
          ' font-family="Microsoft JhengHei, PingFang TC, system-ui, sans-serif"',
          ' text-anchor="middle"',
          ' dominant-baseline="middle"',
          ` xml:space="preserve">${this.#escapeSvgText(lines[1])}</text>`,
        ].join('') : '',
        '</g>',
        '</g>',
        '</svg>',
      ].join('');
      const pngBytes = await this.#svgMarkupToPngBytes(svg, svgW, svgH, 3);
      const image = await pdfDoc.embedPng(pngBytes);
      // 錨點依 pageRot 計算
      let ax, ay, drawW, drawH;
      if (pageRot === 0) {
        ax = g.x + bounds.minX;
        ay = g.y + g.height - bounds.maxY;
        drawW = bounds.width;
        drawH = bounds.height;
      } else if (pageRot === 90) {
        ax = g.x + bounds.maxX;
        ay = g.y + g.height - bounds.maxY;
        drawW = bounds.height;
        drawH = bounds.width;
      } else if (pageRot === 180) {
        ax = g.x + bounds.maxX;
        ay = g.y + g.height - bounds.minY;
        drawW = bounds.width;
        drawH = bounds.height;
      } else if (pageRot === 270) {
        ax = g.x + bounds.minX;
        ay = g.y + g.height - bounds.minY;
        drawW = bounds.height;
        drawH = bounds.width;
      }
      page.drawImage(image, {
        x: ax,
        y: ay,
        width: drawW,
        height: drawH,
        opacity,
        rotate: window.PDFLib.degrees(pageRot),
      });
      return true;
    } catch (error) {
      console.warn('[DocumentEngine] Stamp image export fallback failed:', error);
      return false;
    }
  }

  async #drawSignatureAnnotationAsImage(pdfDoc, page, annotation, box) {
    const g = normalizeRectGeometry(annotation.geometry, box.width, box.height, box.x, box.y);
    if (!g.width || !g.height) return false;

    try {
      const pageRot = page.getRotation().angle;
      const isRotated = pageRot === 90 || pageRot === 270;
      const rotation = normalizeAnnotationRotation(annotation.style?.rotation ?? 0);
      const opacity = annotation.style?.opacity ?? 1;
      const dataUrl = annotation.signatureData?.dataUrl ?? buildTypedSignaturePreset({
        signerName: annotation.content ?? '簽署者',
        includeDate: false,
        color: annotation.style?.color ?? '#1F2937',
      }).dataUrl;
      if (!dataUrl) return false;

      const center = { x: g.width / 2, y: g.height / 2 };
      const bounds = this.#getPointBounds([
        { x: 0, y: 0 },
        { x: g.width, y: 0 },
        { x: g.width, y: g.height },
        { x: 0, y: g.height },
      ].map((point) => rotatePoint(point, center, rotation)));
      // SVG 渲染尺寸：旋轉頁時使用視覺尺寸（寬高互換）
      const svgW = isRotated ? bounds.height : bounds.width;
      const svgH = isRotated ? bounds.width : bounds.height;
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${bounds.width} ${bounds.height}">`,
        `<g transform="translate(${-bounds.minX} ${-bounds.minY})">`,
        `<g transform="rotate(${rotation} ${center.x} ${center.y})">`,
        `<image href="${dataUrl}" x="0" y="0" width="${g.width}" height="${g.height}" preserveAspectRatio="xMidYMid meet"/>`,
        '</g>',
        '</g>',
        '</svg>',
      ].join('');
      const pngBytes = await this.#svgMarkupToPngBytes(svg, svgW, svgH, 3);
      const image = await pdfDoc.embedPng(pngBytes);
      // 錨點依 pageRot 計算
      let ax, ay, drawW, drawH;
      if (pageRot === 0) {
        ax = g.x + bounds.minX;
        ay = g.y + g.height - bounds.maxY;
        drawW = bounds.width;
        drawH = bounds.height;
      } else if (pageRot === 90) {
        ax = g.x + bounds.maxX;
        ay = g.y + g.height - bounds.maxY;
        drawW = bounds.height;
        drawH = bounds.width;
      } else if (pageRot === 180) {
        ax = g.x + bounds.maxX;
        ay = g.y + g.height - bounds.minY;
        drawW = bounds.width;
        drawH = bounds.height;
      } else if (pageRot === 270) {
        ax = g.x + bounds.minX;
        ay = g.y + g.height - bounds.minY;
        drawW = bounds.height;
        drawH = bounds.width;
      }
      page.drawImage(image, {
        x: ax,
        y: ay,
        width: drawW,
        height: drawH,
        opacity,
        rotate: window.PDFLib.degrees(pageRot),
      });
      return true;
    } catch (error) {
      console.warn('[DocumentEngine] Signature image export fallback failed:', error);
      return false;
    }
  }

  async #drawPageNumberBlockAsImage(pdfDoc, page, {
    layout,
    text,
    timestampText = '',
    includeTimestamp = false,
    color = '#000000',
    opacity = 1,
    visualViewport,
  }) {
    const block = layout?.block ?? layout?.text;
    if (!block?.width || !block?.height) return false;

    try {
      const numberSize = Math.max(8, layout?.text?.fontSize ?? 10);
      const timestampSize = includeTimestamp && layout?.timestamp
        ? Math.max(8, layout.timestamp.fontSize)
        : Math.max(8, Math.round(numberSize * 0.8));
      const numberLineHeight = Math.max(numberSize * 1.1, numberSize + 2);
      const timestampLineHeight = Math.max(timestampSize * 1.1, timestampSize + 2);
      const gap = includeTimestamp ? Math.max(4, block.height - numberLineHeight - timestampLineHeight) : 0;
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${block.width}" height="${block.height}" viewBox="0 0 ${block.width} ${block.height}">`,
        `<text x="${block.width / 2}" y="0"`,
        ` fill="${color}"`,
        ` font-size="${numberSize}"`,
        ' font-family="Microsoft JhengHei, PingFang TC, sans-serif"',
        ' text-anchor="middle"',
        ' dominant-baseline="hanging"',
        ' xml:space="preserve"',
        `>${this.#escapeSvgText(text)}</text>`,
        includeTimestamp
          ? [
            `<text x="${block.width / 2}" y="${numberLineHeight + gap}"`,
            ` fill="${color}"`,
            ` font-size="${timestampSize}"`,
            ' font-family="Microsoft JhengHei, PingFang TC, sans-serif"',
            ' text-anchor="middle"',
            ' dominant-baseline="hanging"',
            ' xml:space="preserve"',
            `>${this.#escapeSvgText(timestampText)}</text>`,
          ].join('')
          : '',
        '</svg>',
      ].join('');
      const pngBytes = await this.#svgMarkupToPngBytes(svg, block.width, block.height, 3);
      const image = await pdfDoc.embedPng(pngBytes);
      const origin = visualLayoutPointToPdf({
        x: block.x,
        y: block.y,
      }, visualViewport);
      // pdf-lib rotates images around their bottom-left corner.
      // Use the visual origin directly — page rotation is handled by the rotate parameter.
      const pageRot = visualViewport?.rotation ?? 0;
      let px = origin.x;
      let py = origin.y;
      page.drawImage(image, {
        x: px,
        y: py,
        width: block.width,
        height: block.height,
        opacity,
        rotate: window.PDFLib.degrees(pageRot),
      });
      return true;
    } catch (error) {
      console.warn('[DocumentEngine] Page number image export fallback failed:', error);
      return false;
    }
  }

  async #drawTextWatermarkAsImage(pdfDoc, page, {
    layout,
    text,
    fontSize = 60,
    color = '#000000',
    opacity = 0.15,
    rotation = 0,
    visualViewport,
  }) {
    if (!layout?.width || !layout?.height) return false;

    try {
      const lineHeight = layout.lineHeight || (fontSize * 0.9);
      const lines = String(text ?? '').split('\n').filter(Boolean);
      const centerX = layout.width / 2;
      const centerY = layout.height / 2;
      const blockTop = centerY - ((Math.max(lines.length, 1) - 1) * lineHeight / 2);
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
        `<g transform="rotate(${rotation} ${centerX} ${centerY})">`,
        ...lines.map((line, index) => [
          `<text x="${centerX}" y="${blockTop + (index * lineHeight)}"`,
          ` fill="${color}"`,
          ` font-size="${fontSize}"`,
          ' font-family="Microsoft JhengHei, PingFang TC, sans-serif"',
          ' font-weight="700"',
          ' text-anchor="middle"',
          ' dominant-baseline="middle"',
          ' xml:space="preserve"',
          `>${this.#escapeSvgText(line)}</text>`,
        ].join('')),
        '</g>',
        '</svg>',
      ].join('');
      const pngBytes = await this.#svgMarkupToPngBytes(svg, layout.width, layout.height, 3);
      const image = await pdfDoc.embedPng(pngBytes);
      const origin = visualLayoutPointToPdf({
        x: layout.x,
        y: layout.y,
      }, visualViewport);
      // pdf-lib rotates images around their bottom-left corner.
      // Use the visual origin directly — page rotation is handled by the rotate parameter.
      const wmPageRot = visualViewport?.rotation ?? 0;
      let wmX = origin.x;
      let wmY = origin.y;
      page.drawImage(image, {
        x: wmX,
        y: wmY,
        width: layout.width,
        height: layout.height,
        opacity,
        rotate: window.PDFLib.degrees(wmPageRot),
      });
      return true;
    } catch (error) {
      console.warn('[DocumentEngine] Watermark image export fallback failed:', error);
      return false;
    }
  }

  #measurePreviewTextLines(lines, fontSize) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${fontSize}px "Microsoft JhengHei", "PingFang TC", sans-serif`;
    const metrics = lines.map((line) => context.measureText(line || ' '));
    const widths = metrics.map((metric) => Math.max(1, metric.width));
    const ascent = Math.max(
      fontSize * 0.82,
      ...metrics.map((metric) => metric.actualBoundingBoxAscent || 0),
    );
    const descent = Math.max(
      fontSize * 0.22,
      ...metrics.map((metric) => metric.actualBoundingBoxDescent || 0),
    );
    return {
      widths,
      ascent,
      descent,
      maxWidth: Math.max(1, ...widths),
      blockHeight: ascent + descent + ((Math.max(lines.length, 1) - 1) * fontSize * 1.2),
    };
  }

  #getPointBounds(points) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  async #svgMarkupToPngBytes(svgMarkup, width, height, scale = 2) {
    const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);

    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = svgUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(width * scale));
      canvas.height = Math.max(1, Math.ceil(height * scale));
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, width, height);

      const pngBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Unable to create PNG preview.'));
        }, 'image/png');
      });

      return pngBlob.arrayBuffer();
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  }

  #escapeSvgText(value) {
    return String(value ?? '')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // 移除控制字符
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async #embedAnnotationFont(pdfDoc, annotations) {
    if (!annotations.some(annotation => (annotation.type === 'text' || annotation.type === 'stamp') && String(annotation.content ?? '').trim())) {
      return null;
    }

    return this.#embedTextFont(pdfDoc);
  }

  async #embedTextFont(pdfDoc) {
    try {
      pdfDoc.registerFontkit(fontkit);
      return await pdfDoc.embedFont(notoSansTcRegular, { subset: true });
    } catch (error) {
      console.warn('[DocumentEngine] Falling back to Helvetica for text export:', error);
      return pdfDoc.embedFont(window.PDFLib.StandardFonts.Helvetica);
    }
  }

  #hasMetadataOverrides(metadata = {}) {
    const fields = [metadata.title, metadata.author, metadata.subject, metadata.keywords];
    return fields.some((value) => Array.isArray(value)
      ? value.some((item) => String(item ?? '').trim())
      : String(value ?? '').trim());
  }

  #applyExportMetadata(pdfDoc, metadata = {}) {
    const normalizedKeywords = Array.isArray(metadata.keywords)
      ? metadata.keywords
      : String(metadata.keywords ?? '')
        .split(/[,\n，、]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);

    pdfDoc.setProducer('OpenSpec PDF Editor');
    pdfDoc.setCreator('OpenSpec PDF Editor');
    pdfDoc.setModificationDate(new Date());

    if (String(metadata.title ?? '').trim()) pdfDoc.setTitle(String(metadata.title).trim());
    if (String(metadata.author ?? '').trim()) pdfDoc.setAuthor(String(metadata.author).trim());
    if (String(metadata.subject ?? '').trim()) pdfDoc.setSubject(String(metadata.subject).trim());
    if (normalizedKeywords.length > 0) pdfDoc.setKeywords(normalizedKeywords);
  }

  /** Delete a page by 1-based page number. Reloads pdf.js. */
  async deletePage(pageNumber) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const idx = pageNumber - 1;
    if (idx < 0 || idx >= this.#pdfLibDoc.getPageCount()) throw new Error('Page out of range.');
    this.#pdfLibDoc.removePage(idx);
    eventBus.emit('document:structure-changed', { type: 'delete-page', pageNumber });
    await this.#reloadFromPdfLib(Math.min(pageNumber, this.#pdfLibDoc.getPageCount()));
  }

  async deletePages(pageNumbers = [], currentPage = 1) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const count = this.#pdfLibDoc.getPageCount();
    const targets = [...new Set(pageNumbers
      .map((pageNumber) => Math.trunc(Number(pageNumber)))
      .filter((pageNumber) => pageNumber >= 1 && pageNumber <= count))]
      .sort((left, right) => right - left);

    if (targets.length === 0) return;
    if (targets.length >= count) throw new Error('At least one page must remain.');

    for (const pageNumber of targets) {
      this.#pdfLibDoc.removePage(pageNumber - 1);
      eventBus.emit('document:structure-changed', { type: 'delete-page', pageNumber });
    }

    await this.#reloadFromPdfLib(Math.min(currentPage, this.#pdfLibDoc.getPageCount()));
  }

  /** Rotate a page by degrees (90, 180, 270). */
  async rotatePage(pageNumber, degrees) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const idx = pageNumber - 1;
    if (idx < 0 || idx >= this.#pdfLibDoc.getPageCount()) throw new Error('Page out of range.');
    const page = this.#pdfLibDoc.getPage(idx);
    const current = page.getRotation().angle;
    page.setRotation(window.PDFLib.degrees((current + degrees) % 360));
    await this.#reloadFromPdfLib(pageNumber);
  }

  async rotatePages(options = {}, currentPage = 1) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const { degrees = 90 } = options;
    for (const pageNumber of this.#resolveTargetPages(options, currentPage)) {
      const page = this.#pdfLibDoc.getPage(pageNumber - 1);
      const current = page.getRotation().angle;
      page.setRotation(window.PDFLib.degrees((current + degrees) % 360));
    }
    await this.#reloadFromPdfLib(currentPage);
  }

  async cropPages(options = {}, currentPage = 1) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    for (const pageNumber of this.#resolveTargetPages(options, currentPage)) {
      const page = this.#pdfLibDoc.getPage(pageNumber - 1);
      const box = this.#getPageBox(page);
      const visualViewport = this.#getVisualPageViewport(page, box);
      const visualInsets = {
        top: Math.max(0, Number(options.trimTopPt) || 0),
        right: Math.max(0, Number(options.trimRightPt) || 0),
        bottom: Math.max(0, Number(options.trimBottomPt) || 0),
        left: Math.max(0, Number(options.trimLeftPt) || 0),
      };
      const pdfInsets = visualEdgeInsetsToPdfEdgeInsets(visualInsets, visualViewport);
      const trimLeft = pdfInsets.left;
      const trimRight = pdfInsets.right;
      const trimTop = pdfInsets.top;
      const trimBottom = pdfInsets.bottom;
      const width = Math.max(36, box.width - trimLeft - trimRight);
      const height = Math.max(36, box.height - trimTop - trimBottom);
      page.setCropBox(box.x + trimLeft, box.y + trimBottom, width, height);
    }
    await this.#reloadFromPdfLib(currentPage);
  }

  /** Insert a blank A4 page after the given 1-based page number (0 = prepend). */
  async insertBlankPage(afterPageNumber) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const idx = afterPageNumber; // insertPage(idx) inserts BEFORE that index
    this.#pdfLibDoc.insertPage(Math.min(idx, this.#pdfLibDoc.getPageCount()), [595, 842]);
    eventBus.emit('document:structure-changed', { type: 'insert-page', afterPageNumber });
    await this.#reloadFromPdfLib(Math.min(afterPageNumber + 1, this.#pdfLibDoc.getPageCount()));
  }

  /** Move page from one position to another. Both 1-based. */
  async reorderPage(fromPage, toPage) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const count = this.#pdfLibDoc.getPageCount();
    if (fromPage < 1 || fromPage > count || toPage < 1 || toPage > count || fromPage === toPage) return;
    // Copy the page to move
    const [copied] = await this.#pdfLibDoc.copyPages(this.#pdfLibDoc, [fromPage - 1]);
    this.#pdfLibDoc.removePage(fromPage - 1);
    const insertIdx = toPage - 1;
    this.#pdfLibDoc.insertPage(Math.min(insertIdx, this.#pdfLibDoc.getPageCount()), copied);
    eventBus.emit('document:structure-changed', { type: 'reorder-page', fromPage, toPage });
    await this.#reloadFromPdfLib(toPage);
  }

  /**
   * Move a group of pages to a target position. All params are 1-based.
   * @param {number[]} fromPages - Array of page numbers to move (order preserved).
   * @param {number}   toPage    - Insert AFTER this page (0 = prepend before page 1).
   */
  async reorderPages(fromPages, toPage) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const count = this.#pdfLibDoc.getPageCount();

    // Deduplicate, validate, sort ascending
    const sorted = [...new Set(fromPages)]
      .map(Number)
      .filter(p => p >= 1 && p <= count)
      .sort((a, b) => a - b);
    if (sorted.length === 0) return;

    // toPage 0 = prepend; clamp to valid range
    const target = Math.max(0, Math.min(count, Number(toPage) || 0));
    const fromSet = new Set(sorted);

    // Don't move if every selected page is already consecutive at the target
    const firstInsert = target - sorted.filter(p => p <= target).length;
    const alreadyInPlace = sorted.every((p, i) => p === firstInsert + 1 + i);
    if (alreadyInPlace) return;

    // Copy pages in original (ascending) order
    const copies = await this.#pdfLibDoc.copyPages(
      this.#pdfLibDoc,
      sorted.map(p => p - 1),
    );

    // Remove from highest → lowest index to avoid shifting
    for (const p of [...sorted].sort((a, b) => b - a)) {
      this.#pdfLibDoc.removePage(p - 1);
    }

    // Adjusted insert index: target minus how many fromPages were ≤ target
    const pagesBeforeTarget = sorted.filter(p => p <= target).length;
    const insertIdx = target - pagesBeforeTarget;

    for (let i = 0; i < copies.length; i++) {
      this.#pdfLibDoc.insertPage(
        Math.min(insertIdx + i, this.#pdfLibDoc.getPageCount()),
        copies[i],
      );
    }

    const newFirstPage = insertIdx + 1;
    eventBus.emit('document:structure-changed', { type: 'reorder-pages', fromPages: sorted, toPage: target });
    await this.#reloadFromPdfLib(newFirstPage);
  }

  /**
   * Embed electronic-signature metadata into the PDF Info dictionary.
   * Call before exportToBlob when a document has been signed.
   * @param {{ signerName: string, reason: string, location: string, signedAt: string }[]} manifests
   */
  embedSignatureMetadata(manifests = []) {
    if (!this.#pdfLibDoc || !manifests.length) return;
    const latest = manifests[manifests.length - 1];
    try {
      this.#pdfLibDoc.setAuthor(latest.signerName || '');
      this.#pdfLibDoc.setSubject(
        manifests.map(m =>
          `[簽署] ${m.signerName}${m.reason ? ' / ' + m.reason : ''}${m.location ? ' @ ' + m.location : ''} ${m.signedAt}`
        ).join(' | ')
      );
      this.#pdfLibDoc.setKeywords(['電子簽署', 'OpenSpec', ...manifests.map(m => m.signerName)]);
      this.#pdfLibDoc.setModificationDate(new Date());
    } catch {
      // Non-critical; metadata embedding may fail on encrypted docs
    }
  }

  /** Merge another PDF (ArrayBuffer) into this document. */
  async mergePdf(otherBytes, currentPage = 1) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const other = await window.PDFLib.PDFDocument.load(otherBytes);
    const indices = other.getPageIndices();
    const pages = await this.#pdfLibDoc.copyPages(other, indices);
    for (const page of pages) this.#pdfLibDoc.addPage(page);
    await this.#reloadFromPdfLib(currentPage);
  }

  /** Create a brand-new empty PDF document (used by merge from scratch). */
  async createNew() {
    this.#pdfLibDoc = await window.PDFLib.PDFDocument.create();
    this.#pdfjsDoc  = null;
    this.#pdfBytes  = null;
    this.#fileHash  = null;
    this.#fileName  = 'merged.pdf';
    this.#clearPageTextCache();
  }

  /** Reload pdf.js from the current pdf-lib state. Called after structural edits. */
  async #reloadFromPdfLib(currentPage = 1) {
    const bytes = await this.createSnapshotBytes();
    await this.restoreFromBytes(bytes, currentPage);
  }

  #hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }

  #clearPageTextCache() {
    this.#pageTextCache.clear();
  }

  /** Add page numbers to all pages. */
  async addPageNumbers(options = {}, currentPage = 1) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const {
      position = 'bottom-center',
      startNumber = 1,
      fontSize = 10,
      color = '#000000',
      marginPt = 20,
      includeTimestamp = false,
      timestampText = '',
    } = options;
    const { rgb } = window.PDFLib;
    const textFont = await this.#embedTextFont(this.#pdfLibDoc);
    const c = this.#hexToRgb(color);
    const timestamp = includeTimestamp
      ? (timestampText || new Intl.DateTimeFormat('zh-TW', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date()).replace(/\//g, '-'))
      : '';
    const targetPages = this.#resolveTargetPages(options, currentPage);
    let visibleIndex = 0;

    for (const pageNumber of targetPages) {
      const page = this.#pdfLibDoc.getPage(pageNumber - 1);
      const box = this.#getPageBox(page);
      const visualViewport = this.#getVisualPageViewport(page, box);
      const text = String(startNumber + visibleIndex);
      const layout = resolvePageNumberLayout({
        pageWidth: visualViewport.displayWidthPt,
        pageHeight: visualViewport.displayHeightPt,
        position,
        text,
        fontSize,
        marginPt,
        timestampText: timestamp,
        includeTimestamp,
      });
      if (await this.#drawPageNumberBlockAsImage(this.#pdfLibDoc, page, {
        layout,
        text,
        timestampText: timestamp,
        includeTimestamp,
        color,
        visualViewport,
      })) {
        visibleIndex++;
        continue;
      }
      const textPoint = visualLayoutPointToPdf({
        x: layout.text.x,
        y: layout.text.y,
      }, visualViewport);

      page.drawText(text, {
        x: textPoint.x,
        y: textPoint.y,
        size: fontSize,
        color: rgb(c.r, c.g, c.b),
        font: textFont,
        rotate: window.PDFLib.degrees(-visualViewport.rotation),
      });

      if (includeTimestamp && layout.timestamp) {
        const timestampPoint = visualLayoutPointToPdf({
          x: layout.timestamp.x,
          y: layout.timestamp.y,
        }, visualViewport);
        page.drawText(timestamp, {
          x: timestampPoint.x,
          y: timestampPoint.y,
          size: layout.timestamp.fontSize,
          color: rgb(c.r, c.g, c.b),
          font: textFont,
          rotate: window.PDFLib.degrees(-visualViewport.rotation),
        });
      }
      visibleIndex++;
    }

    await this.#reloadFromPdfLib(currentPage);
  }

  /** Add text watermark to all pages. */
  async addWatermark(options = {}, currentPage = 1) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const {
      sourceType = 'text',
      text = '草稿',
      imageFile = null,
      fontSize = 60,
      opacity = 0.15,
      color = '#000000',
      rotation = -45,
      position = 'center',
      includeTimestamp = false,
      timestampText = '',
      scale = 0.28,
    } = options;
    const { rgb, degrees } = window.PDFLib;
    const textFont = sourceType === 'text' ? await this.#embedTextFont(this.#pdfLibDoc) : null;
    const watermarkImage = sourceType === 'image' && imageFile
      ? await embedImageFile(this.#pdfLibDoc, imageFile)
      : null;
    const c = this.#hexToRgb(color);
    const stamp = includeTimestamp
      ? `${text}\n${timestampText || new Intl.DateTimeFormat('zh-TW', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date()).replace(/\//g, '-')}`
      : text;

    for (const pageNumber of this.#resolveTargetPages(options, currentPage)) {
      const page = this.#pdfLibDoc.getPage(pageNumber - 1);
      const box = this.#getPageBox(page);
      const visualViewport = this.#getVisualPageViewport(page, box);
      const pageRotation = visualViewport.rotation;
      if (sourceType === 'image' && watermarkImage) {
        const layout = resolveImageWatermarkLayout({
          pageWidth: visualViewport.displayWidthPt,
          pageHeight: visualViewport.displayHeightPt,
          position,
          imageWidth: watermarkImage.width,
          imageHeight: watermarkImage.height,
          scale,
        });
        const point = visualLayoutPointToPdf({
          x: layout.x,
          y: layout.y,
        }, visualViewport);
        // pdf-lib rotates images around their bottom-left corner.
        // Page rotation is combined with user-specified rotation.
        page.drawImage(watermarkImage, {
          x: point.x,
          y: point.y,
          width: layout.width,
          height: layout.height,
          opacity,
          rotate: degrees(pageRotation + rotation),
        });
        continue;
      }

      const layout = resolveWatermarkLayout({
        pageWidth: visualViewport.displayWidthPt,
        pageHeight: visualViewport.displayHeightPt,
        position,
        text: stamp,
        fontSize,
      });
      if (await this.#drawTextWatermarkAsImage(this.#pdfLibDoc, page, {
        layout,
        text: stamp,
        fontSize,
        color,
        opacity,
        rotation,
        visualViewport,
      })) {
        continue;
      }
      const point = visualLayoutPointToPdf({
        x: layout.x,
        y: layout.y,
      }, visualViewport);

      page.drawText(stamp, {
        x: point.x,
        y: point.y,
        size: fontSize,
        color: rgb(c.r, c.g, c.b),
        font: textFont,
        opacity,
        rotate: degrees(rotation),
        lineHeight: layout.lineHeight,
        maxWidth: box.width - 72,
      });
    }
    await this.#reloadFromPdfLib(currentPage);
  }

  /** Split PDF into page ranges. Returns array of {name, bytes}. */
  async splitToRanges(ranges) {
    if (!this.#pdfLibDoc) throw new Error('No document loaded.');
    const results = [];
    for (const range of ranges) {
      const newDoc = await window.PDFLib.PDFDocument.create();
      const indices = [];
      for (let p = range.from; p <= range.to; p++) {
        const idx = p - 1;
        if (idx >= 0 && idx < this.#pdfLibDoc.getPageCount()) indices.push(idx);
      }
      if (indices.length === 0) continue;
      const pages = await newDoc.copyPages(this.#pdfLibDoc, indices);
      for (const pg of pages) newDoc.addPage(pg);
      const bytes = await newDoc.save();
      const baseName = (this.#fileName ?? 'document').replace(/\.pdf$/i, '');
      results.push({ name: `${baseName}_p${range.from}-${range.to}.pdf`, bytes });
    }
    return results;
  }

  #resolveTargetPages(options = {}, fallbackCurrentPage = 1) {
    const pageCount = this.#pdfLibDoc.getPageCount();
    if (Array.isArray(options.pages) && options.pages.length > 0) {
      return [...new Set(options.pages
        .map((pageNumber) => Math.trunc(Number(pageNumber)))
        .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pageCount))]
        .sort((left, right) => left - right);
    }

    const fromPage = Math.min(Math.max(Math.trunc(Number(options.fromPage) || fallbackCurrentPage), 1), pageCount);
    const toPage = Math.min(Math.max(Math.trunc(Number(options.toPage) || fromPage), fromPage), pageCount);
    return Array.from({ length: toPage - fromPage + 1 }, (_, index) => fromPage + index);
  }

  #getPageBox(page) {
    if (typeof page.getCropBox === 'function') {
      const cropBox = page.getCropBox();
      if (cropBox?.width && cropBox?.height) {
        return cropBox;
      }
    }

    const { width, height } = page.getSize();
    return { x: 0, y: 0, width, height };
  }

  #getVisualPageViewport(page, box = this.#getPageBox(page)) {
    return getVisualViewport({
      pageWidthPt: box.width,
      pageHeightPt: box.height,
      originXPt: box.x,
      originYPt: box.y,
      rotation: page.getRotation().angle,
    });
  }
}

export const documentEngine = new DocumentEngine();
export default DocumentEngine;
