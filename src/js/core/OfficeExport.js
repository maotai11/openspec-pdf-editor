import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';
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
          children: [new TextRun({ text: '此頁沒有可擷取的文字內容。', italics: true })],
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

  const buffer = await Packer.toBuffer(doc);
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
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
} = {}) {
  const workbook = XLSX.utils.book_new();
  const summaryRows = [['頁碼', '文字行數']];

  for (const pageNumber of pageNumbers) {
    const textRuns = await documentEngine.getPageTextRuns(pageNumber);
    const lines = textRunsToLineRecords(textRuns);
    summaryRows.push([pageNumber, lines.length]);

    const rows = [
      ['Line', 'Text', 'Left', 'Right', 'Bottom', 'Top'],
      ...lines.map((line) => [
        line.index,
        line.text,
        Number(line.left.toFixed(2)),
        Number(line.right.toFixed(2)),
        Number(line.bottom.toFixed(2)),
        Number(line.top.toFixed(2)),
      ]),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, `Page ${pageNumber}`.slice(0, 31));
  }

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(summaryRows),
    'Summary',
  );

  const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
