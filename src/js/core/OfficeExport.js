import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { groupTextRunsIntoLines } from './TextMarkup.js';

function sanitizeLineText(line) {
  return line.runs.map((run) => String(run.text ?? '')).join('').trim();
}

function textRunsToLineRecords(textRuns = []) {
  return groupTextRunsIntoLines(textRuns)
    .map((line, index) => {
      const text = sanitizeLineText(line);
      if (!text) return null;
      const left = Math.min(...line.runs.map((run) => run.left));
      const right = Math.max(...line.runs.map((run) => run.right));
      const bottom = Math.min(...line.runs.map((run) => run.bottom));
      const top = Math.max(...line.runs.map((run) => run.top));
      return {
        index: index + 1,
        text,
        left,
        right,
        bottom,
        top,
      };
    })
    .filter(Boolean);
}

async function renderPageToPng(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error('Unable to render PDF page preview.'));
    }, 'image/png');
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    bytes,
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  };
}

function styleHeaderRow(worksheet) {
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle' };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function escapeHeaderFooterText(value) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/&/g, '&&')
    .trim();
}

function configureWorksheetPrintLayout(worksheet, pageNumber, title = '') {
  const safeTitle = escapeHeaderFooterText(title || 'OpenSpec Export');
  worksheet.pageSetup = {
    paperSize: 9,
    orientation: 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    firstPageNumber: pageNumber,
    horizontalCentered: true,
    margins: {
      left: 0.4,
      right: 0.4,
      top: 0.55,
      bottom: 0.55,
      header: 0.25,
      footer: 0.25,
    },
  };
  worksheet.headerFooter.oddHeader = `&L${safeTitle}&RPDF 第 ${pageNumber} 頁`;
  worksheet.headerFooter.oddFooter = '&LOpenSpec PDF Editor&C第 &P 頁 / 共 &N 頁';
}

function addWorksheetPreview(workbook, worksheet, png) {
  if (!png?.dataUrl) return;

  const imageId = workbook.addImage({
    base64: png.dataUrl,
    extension: 'png',
  });

  ['H', 'I', 'J', 'K', 'L'].forEach((columnKey) => {
    worksheet.getColumn(columnKey).width = 14;
  });
  worksheet.getCell('H1').value = 'Preview';
  worksheet.getCell('H1').font = { bold: true };

  const maxWidth = 260;
  const scale = Math.min(1, maxWidth / Math.max(1, png.width));
  const width = Math.max(120, Math.round(png.width * scale));
  const height = Math.max(140, Math.round(png.height * scale));
  worksheet.addImage(imageId, {
    tl: { col: 7, row: 1.2 },
    ext: { width, height },
    editAs: 'oneCell',
  });
}

async function renderWorksheetPreview(documentEngine, pageNumber, includePageImages) {
  if (!includePageImages || typeof document === 'undefined' || typeof documentEngine?.getPage !== 'function') {
    return null;
  }

  try {
    const page = await documentEngine.getPage(pageNumber);
    return await renderPageToPng(page, 1.35);
  } catch (error) {
    console.warn(`[OfficeExport] Skipped preview for page ${pageNumber}:`, error);
    return null;
  }
}

export async function exportPdfToDocx(documentEngine, {
  pageNumbers = [],
  title = '',
  includePageImages = true,
  includeExtractedText = true,
} = {}) {
  const children = [];

  for (const pageNumber of pageNumbers) {
    const page = await documentEngine.getPage(pageNumber);
    const textRuns = await documentEngine.getPageTextRuns(pageNumber);
    const lines = textRunsToLineRecords(textRuns);

    children.push(new Paragraph({
      text: `第 ${pageNumber} 頁`,
      heading: HeadingLevel.HEADING_1,
    }));

    if (includePageImages) {
      const png = await renderPageToPng(page, 1.8);
      const maxWidth = 560;
      const ratio = Math.min(1, maxWidth / png.width);
      children.push(new Paragraph({
        children: [
          new ImageRun({
            data: png.bytes,
            transformation: {
              width: Math.max(1, Math.round(png.width * ratio)),
              height: Math.max(1, Math.round(png.height * ratio)),
            },
          }),
        ],
      }));
    }

    if (includeExtractedText) {
      if (lines.length === 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: '未擷取到可用文字。', italics: true })],
        }));
      } else {
        children.push(new Paragraph({
          children: [new TextRun({ text: '文字擷取', bold: true })],
        }));
        lines.forEach((line) => {
          children.push(new Paragraph(line.text));
        });
      }
    }
  }

  const doc = new Document({
    title,
    sections: [{ children }],
  });

  return Packer.toBlob(doc);
}

export async function exportPdfToPptx(documentEngine, {
  pageNumbers = [],
  title = '',
} = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'OpenSpec PDF Editor';
  pptx.subject = title;
  pptx.title = title;
  pptx.company = 'OpenSpec';
  pptx.lang = 'zh-TW';

  for (const pageNumber of pageNumbers) {
    const page = await documentEngine.getPage(pageNumber);
    const png = await renderPageToPng(page, 1.8);
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(`第 ${pageNumber} 頁`, {
      x: 0.35,
      y: 0.15,
      w: 2,
      h: 0.3,
      fontFace: 'Arial',
      fontSize: 16,
      bold: true,
      color: '1F2937',
    });

    const slideWidth = 12.6;
    const slideHeight = 6.6;
    const scale = Math.min(slideWidth / png.width, slideHeight / png.height);
    const width = png.width * scale;
    const height = png.height * scale;
    const x = 0.35 + ((slideWidth - width) / 2);
    const y = 0.55 + ((slideHeight - height) / 2);

    slide.addImage({
      data: png.dataUrl,
      x,
      y,
      w: width,
      h: height,
    });
  }

  const arrayBuffer = await pptx.write({ outputType: 'arraybuffer' });
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}

export async function exportPdfToXlsx(documentEngine, {
  pageNumbers = [],
  title = '',
  includePageImages = true,
} = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OpenSpec PDF Editor';
  workbook.company = 'OpenSpec';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.subject = 'PDF text extraction';
  if (title) workbook.title = title;

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Page', key: 'pageNumber', width: 12 },
    { header: 'Worksheet', key: 'worksheetName', width: 18 },
    { header: 'Extracted Lines', key: 'lineCount', width: 18 },
  ];
  styleHeaderRow(summarySheet);
  configureWorksheetPrintLayout(summarySheet, 1, title);

  for (const pageNumber of pageNumbers) {
    const textRuns = await documentEngine.getPageTextRuns(pageNumber);
    const lines = textRunsToLineRecords(textRuns);
    summarySheet.addRow({
      pageNumber,
      worksheetName: `Page ${pageNumber}`,
      lineCount: lines.length,
    });

    const worksheet = workbook.addWorksheet(`Page ${pageNumber}`.slice(0, 31));
    worksheet.columns = [
      { header: 'Line', key: 'index', width: 10 },
      { header: 'Text', key: 'text', width: 48 },
      { header: 'Left', key: 'left', width: 12 },
      { header: 'Right', key: 'right', width: 12 },
      { header: 'Bottom', key: 'bottom', width: 12 },
      { header: 'Top', key: 'top', width: 12 },
    ];
    styleHeaderRow(worksheet);
    configureWorksheetPrintLayout(worksheet, pageNumber, title);

    const preview = await renderWorksheetPreview(documentEngine, pageNumber, includePageImages);
    addWorksheetPreview(workbook, worksheet, preview);

    for (const line of lines) {
      worksheet.addRow({
        index: line.index,
        text: line.text,
        left: Number(line.left.toFixed(2)),
        right: Number(line.right.toFixed(2)),
        bottom: Number(line.bottom.toFixed(2)),
        top: Number(line.top.toFixed(2)),
      });
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
