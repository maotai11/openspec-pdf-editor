import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/OfficeExport.js')).href;
const { exportPdfToXlsx } = await import(modulePath);

describe('OfficeExport', () => {
  it('exports extracted page text into a structured xlsx workbook', async () => {
    const originalDocument = globalThis.document;
    globalThis.document = {
      createElement(tagName) {
        if (tagName !== 'canvas') throw new Error(`Unexpected element request: ${tagName}`);
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              fillStyle: '#FFFFFF',
              fillRect() {},
            };
          },
          toBlob(callback) {
            callback(new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' }));
          },
          toDataURL() {
            return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0p9s8AAAAASUVORK5CYII=';
          },
        };
      },
    };

    const fakeDocumentEngine = {
      async getPage() {
        return {
          getViewport({ scale = 1 }) {
            return {
              width: 200 * scale,
              height: 120 * scale,
            };
          },
          render() {
            return { promise: Promise.resolve() };
          },
        };
      },
      async getPageTextRuns(pageNumber) {
        if (pageNumber === 1) {
          return [
            { text: 'Hello ', left: 10, right: 48, top: 100, bottom: 88, width: 38, height: 12, centerY: 94 },
            { text: 'World', left: 52, right: 96, top: 100, bottom: 88, width: 44, height: 12, centerY: 94 },
            { text: 'OpenSpec', left: 10, right: 74, top: 72, bottom: 60, width: 64, height: 12, centerY: 66 },
          ];
        }
        return [];
      },
    };

    try {
      const blob = await exportPdfToXlsx(fakeDocumentEngine, {
        pageNumbers: [1, 2],
        title: 'Quarterly Review',
      });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await blob.arrayBuffer());

      assert.equal(workbook.creator, 'OpenSpec PDF Editor');
      assert.equal(workbook.title, 'Quarterly Review');
      assert.equal(workbook.subject, 'PDF text extraction');
      assert.deepEqual(
        workbook.worksheets.map((worksheet) => worksheet.name),
        ['Summary', 'Page 1', 'Page 2'],
      );

      const summary = workbook.getWorksheet('Summary');
      assert.deepEqual(summary.getRow(2).values.slice(1), [1, 'Page 1', 2]);
      assert.deepEqual(summary.getRow(3).values.slice(1), [2, 'Page 2', 0]);

      const pageOne = workbook.getWorksheet('Page 1');
      assert.deepEqual(pageOne.getRow(3).values.slice(1), [1, 'Hello World', 10, 96, 88, 100]);
      assert.deepEqual(pageOne.getRow(4).values.slice(1), [2, 'OpenSpec', 10, 74, 60, 72]);
      assert.equal(pageOne.pageSetup.firstPageNumber, 1);
      assert.match(pageOne.headerFooter.oddHeader, /Quarterly Review/);
      assert.equal(pageOne.getImages().length, 1);

      const pageTwo = workbook.getWorksheet('Page 2');
      assert.equal(pageTwo.rowCount, 1);
      assert.equal(pageTwo.pageSetup.firstPageNumber, 2);
      assert.equal(pageTwo.getImages().length, 1);
    } finally {
      globalThis.document = originalDocument;
    }
  });
});
