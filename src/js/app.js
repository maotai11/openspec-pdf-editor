/**
 * app.js ??PDF 蝺刻摩??Entry Point
 *
 * The ONLY module that holds references to all singletons.
 * Initialization order:
 *   1. Init layers (CanvasLayer, AnnotationLayer) ??main thread only
 *   2. Init layers (CanvasLayer, AnnotationLayer)
 *   3. Init UI chrome + KeyMap ??initial renderShell (user sees UI immediately)
 *   4. Wire all EventBus handlers
 *   5. Background (non-blocking): SessionDB init
 *
 * Singletons communicate ONLY through EventBus.
 * This file is the only exception (holds direct refs for init).
 */

import { eventBus }       from './core/EventBus.js';
import { stateManager }   from './core/StateManager.js';
import { commandStack }   from './core/CommandStack.js';
import { documentEngine } from './core/DocumentEngine.js';
import {
  clamp,
  formatLocalTimestamp,
  humanizePosition,
  parsePageRangeIntent,
  parsePositionIntent,
  parseSplitRanges,
  parseStartNumberIntent,
  parseTimestampIntent,
  parseWatermarkIntent,
} from './core/NaturalLanguage.js';
import { resolveImageWatermarkLayout, resolvePageNumberLayout, resolveWatermarkLayout } from './core/LayoutPresets.js';
import { embedImageFile, isImageLikeFile, readImageDimensions } from './core/ImageAsset.js';
import { resolveImageDrawLayout, resolveMarginPt, resolveTargetPageSize } from './core/ImagePdfLayout.js';
import { getDisplayPageSize, normalizeRotation } from './core/PageGeometry.js';
import { exportPdfToDocx, exportPdfToPptx, exportPdfToXlsx } from './core/OfficeExport.js';
import { protectPdfBytes } from './core/PdfProtection.js';
import { buildTypedSignaturePreset } from './core/SignatureAsset.js';
import { resolveThumbnailViewport } from './core/ThumbnailLayout.js';
import { sessionDB }      from './core/SessionDB.js';
import { keyMap }         from './core/KeyMap.js';
import { canvasLayer }    from './ui/CanvasLayer.js';
import { annotationLayer }from './ui/AnnotationLayer.js';
import { appRenderer }    from './ui/renderApp.js';

// ---- Capability Detection ----
const capabilities = {
  fileSystemAccess: 'showSaveFilePicker' in window,
  openFilePicker: 'showOpenFilePicker' in window,
  indexedDB:        'indexedDB' in window,
};

const SAVE_STATUS_DISPLAY_MS = 2500;
const RECENT_DOCS_KEY = 'openspec.recent-docs';
const MAX_RECENT_DOCS = 8;
let signaturePresetDraft = buildTypedSignaturePreset({
  signerName: '簽署者',
  subtitle: '電子簽署',
  includeDate: true,
  dateText: new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replaceAll('/', '.'),
});
const PAGE_NUMBER_POSITIONS = [
  ['bottom-left', '下方靠左'],
  ['bottom-center', '下方置中'],
  ['bottom-right', '下方靠右'],
  ['top-left', '上方靠左'],
  ['top-center', '上方置中'],
  ['top-right', '上方靠右'],
];
const PAGE_NUMBER_TIME_SOURCES = [
  ['inserted', '新增時間'],
  ['file-modified', '檔案修改時間'],
];
const PAGE_NUMBER_TIME_FORMATS = [
  ['yyyy-mm-dd-hh-mm', '2026-04-05 09:30'],
  ['yyyy/mm/dd-hh-mm', '2026/04/05 09:30'],
  ['yyyy.mm.dd', '2026.04.05'],
  ['zh-full', '2026年04月05日 09:30'],
];
const OFFICE_EXPORT_FORMATS = [
  ['docx', 'Microsoft Word (.docx)'],
  ['pptx', 'Microsoft PowerPoint (.pptx)'],
  ['xlsx', 'Microsoft Excel (.xlsx)'],
];
const WATERMARK_POSITIONS = [
  ['center', '正中央'],
  ['top-left', '上方靠左'],
  ['top-center', '上方置中'],
  ['top-right', '上方靠右'],
  ['left', '左側置中'],
  ['right', '右側置中'],
  ['bottom-left', '下方靠左'],
  ['bottom-center', '下方置中'],
  ['bottom-right', '下方靠右'],
];
const ROTATE_ANGLES = [
  ['90', '順時針 90°'],
  ['180', '旋轉 180°'],
  ['270', '逆時針 90°'],
];
const IMAGE_PAGE_SIZE_OPTIONS = [
  ['a4', 'A4 直式'],
  ['letter', 'Letter 直式'],
  ['fit-page', '符合頁面方向'],
  ['original', '原始尺寸'],
];
const IMAGE_DPI_OPTIONS = [
  ['72', '72 DPI'],
  ['150', '150 DPI'],
  ['300', '300 DPI'],
];
const IMAGE_MARGIN_OPTIONS = [
  ['none', '無邊距'],
  ['standard', '標準 10 mm'],
  ['custom', '自訂'],
];
const DEFAULT_PREVIEW_METRICS = {
  pageWidthPt: 595,
  pageHeightPt: 842,
  rotation: 0,
  displayWidthPt: 595,
  displayHeightPt: 842,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildSelect(options, value) {
  const select = document.createElement('select');
  select.className = 'form-input';
  for (const [optionValue, label] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    if (optionValue === value) option.selected = true;
    select.appendChild(option);
  }
  return select;
}

function buildFormGroup(label, control, hint = '') {
  const wrapper = el('label', 'form-group');
  wrapper.appendChild(el('span', 'form-label', label));
  wrapper.appendChild(control);
  if (hint) wrapper.appendChild(el('span', 'workflow-help', hint));
  return wrapper;
}

function buildCheckbox(labelText, checked = false) {
  const wrapper = el('label', 'workflow-check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  wrapper.appendChild(input);
  wrapper.appendChild(el('span', '', labelText));
  return { wrapper, input };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('無法讀取圖片檔案。'));
    reader.readAsDataURL(file);
  });
}

function setDialogError(message = '') {
  const error = document.getElementById('workflow-modal-error');
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}

async function getWorkflowPreviewMetrics(pageNumber = stateManager.state.currentPage, extraRotation = 0) {
  if (stateManager.state.documentStatus !== 'ready') return { ...DEFAULT_PREVIEW_METRICS };

  try {
    const page = await documentEngine.getPage(pageNumber);
    const [x1, y1, x2, y2] = page.view;
    const pageWidthPt = Math.abs(x2 - x1);
    const pageHeightPt = Math.abs(y2 - y1);
    const rotation = normalizeRotation((page.rotate ?? 0) + extraRotation);
    const viewport = page.getViewport({ scale: 1, rotation });
    const display = {
      width: Math.abs(viewport.width),
      height: Math.abs(viewport.height),
    };
    return {
      pageWidthPt,
      pageHeightPt,
      rotation,
      displayWidthPt: display.width,
      displayHeightPt: display.height,
    };
  } catch {
    return { ...DEFAULT_PREVIEW_METRICS };
  }
}

function fitWorkflowPreviewBox(node, displayWidthPt, displayHeightPt, { maxWidthPx = 360, maxHeightPx = 420 } = {}) {
  const scale = Math.min(maxWidthPx / displayWidthPt, maxHeightPx / displayHeightPt, 1);
  node.style.width = `${Math.round(displayWidthPt * scale)}px`;
  node.style.height = `${Math.round(displayHeightPt * scale)}px`;
  node.style.maxWidth = '100%';
}

function applyWorkflowPreviewAspect(node, metrics) {
  node.style.aspectRatio = `${metrics.displayWidthPt} / ${metrics.displayHeightPt}`;
  fitWorkflowPreviewBox(node, metrics.displayWidthPt, metrics.displayHeightPt);
}

async function renderWorkflowPreviewSurface(node, metrics, pageNumber = stateManager.state.currentPage) {
  const surface = document.createElement('img');
  surface.className = 'workflow-preview-surface';
  surface.alt = '頁面預覽';
  node.appendChild(surface);

  if (stateManager.state.documentStatus !== 'ready') return surface;

  try {
    const page = await documentEngine.getPage(pageNumber);
    const renderScale = clamp(
      Math.min(720 / Math.max(metrics.displayWidthPt, 1), 840 / Math.max(metrics.displayHeightPt, 1)),
      0.8,
      2,
    );
    const viewport = page.getViewport({ scale: renderScale, rotation: metrics.rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(Math.abs(viewport.width)));
    canvas.height = Math.max(1, Math.round(Math.abs(viewport.height)));
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
    }).promise;
    surface.src = canvas.toDataURL('image/png');
  } catch {
    surface.classList.add('hidden');
  }

  return surface;
}

async function createWorkflowPreviewPage(metrics, pageNumber = stateManager.state.currentPage) {
  const node = el('div', 'workflow-preview-page');
  applyWorkflowPreviewAspect(node, metrics);
  await renderWorkflowPreviewSurface(node, metrics, pageNumber);
  return node;
}

async function refreshWorkflowPreviewPage(node, metrics, pageNumber = stateManager.state.currentPage) {
  node.innerHTML = '';
  applyWorkflowPreviewAspect(node, metrics);
  await renderWorkflowPreviewSurface(node, metrics, pageNumber);
}

function applyPreviewPlacement(node, rect, previewWidth, previewHeight, {
  translateX = '0',
  translateY = '0',
  extraTransform = '',
} = {}) {
  const left = clamp((Number(rect.x) / previewWidth) * 100, 0, 100);
  const top = clamp(100 - (((Number(rect.y) || 0) + (Number(rect.height) || 0)) / previewHeight) * 100, 0, 100);

  node.style.left = `${left}%`;
  node.style.top = `${top}%`;
  node.style.right = 'auto';
  node.style.bottom = 'auto';
  node.style.transform = [extraTransform ? `translate(${translateX}, ${translateY}) ${extraTransform}` : `translate(${translateX}, ${translateY})`]
    .join(' ')
    .trim();
}

function padTimestampNumber(value) {
  return String(value).padStart(2, '0');
}

function formatTimestampByPreset(date, formatKey = 'yyyy-mm-dd-hh-mm') {
  const safeDate = date instanceof Date && !Number.isNaN(date.valueOf()) ? date : new Date();
  const year = safeDate.getFullYear();
  const month = padTimestampNumber(safeDate.getMonth() + 1);
  const day = padTimestampNumber(safeDate.getDate());
  const hour = padTimestampNumber(safeDate.getHours());
  const minute = padTimestampNumber(safeDate.getMinutes());

  switch (formatKey) {
    case 'yyyy/mm/dd-hh-mm':
      return `${year}/${month}/${day} ${hour}:${minute}`;
    case 'yyyy.mm.dd':
      return `${year}.${month}.${day}`;
    case 'zh-full':
      return `${year}年${month}月${day}日 ${hour}:${minute}`;
    case 'yyyy-mm-dd-hh-mm':
    default:
      return `${year}-${month}-${day} ${hour}:${minute}`;
  }
}

function resolvePageNumberTimestampText({
  includeTimestamp = false,
  source = 'inserted',
  format = 'yyyy-mm-dd-hh-mm',
} = {}) {
  if (!includeTimestamp) return '';

  const fileModified = documentEngine.fileLastModified ? new Date(documentEngine.fileLastModified) : null;
  const sourceDate = source === 'file-modified' && fileModified ? fileModified : new Date();
  return formatTimestampByPreset(sourceDate, format);
}

function normalizePdfFileName(name, fallbackName = 'document.pdf') {
  const trimmed = String(name ?? '').trim();
  const baseName = trimmed || fallbackName;
  if (/\.[a-z0-9]{2,8}$/i.test(baseName)) return baseName;
  const fallbackExtension = (String(fallbackName ?? '').match(/\.[a-z0-9]{2,8}$/i)?.[0] ?? '.pdf');
  return `${baseName}${fallbackExtension}`;
}

function normalizeOutputNameByFormat(baseName, format) {
  const extension = format === 'pptx' ? '.pptx' : format === 'xlsx' ? '.xlsx' : '.docx';
  return normalizePdfFileName(baseName, `document${extension}`);
}

function loadRecentDocs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_DOCS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentDocs(entries) {
  try {
    localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage quota/security failures in file:// environments.
  }
}

function rememberRecentDoc({ fileHash, fileName, pageCount }) {
  if (!fileHash || !fileName) return;
  const now = new Date().toISOString();
  const next = loadRecentDocs()
    .filter((entry) => entry.fileHash !== fileHash)
    .concat([{ fileHash, fileName, pageCount, lastOpenedAt: now }])
    .sort((left, right) => String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt)))
    .slice(0, MAX_RECENT_DOCS);
  saveRecentDocs(next);
}

function showWorkflowDialog({ title, description = '', submitLabel = '套用', submitClassName = 'btn btn-primary', buildContent }) {
  const modal = document.getElementById('workflow-modal');
  const titleEl = document.getElementById('workflow-modal-title');
  const descriptionEl = document.getElementById('workflow-modal-description');
  const bodyEl = document.getElementById('workflow-modal-body');
  const cancelBtn = document.getElementById('workflow-cancel');
  const submitBtn = document.getElementById('workflow-submit');

  titleEl.textContent = title;
  descriptionEl.textContent = description;
  bodyEl.innerHTML = '';
  submitBtn.textContent = submitLabel;
  submitBtn.className = submitClassName;
  setDialogError('');

  const controller = buildContent(bodyEl) ?? {};

  return new Promise((resolve) => {
    const close = (result) => {
      modal.classList.add('hidden');
      modal.removeEventListener('click', onBackdropClick);
      cancelBtn.removeEventListener('click', onCancel);
      submitBtn.removeEventListener('click', onSubmit);
      document.removeEventListener('keydown', onKeydown, true);
      controller.dispose?.();
      bodyEl.innerHTML = '';
      setDialogError('');
      eventBus.emit('modal:close');
      resolve(result);
    };

    const onCancel = () => close(null);
    const onSubmit = () => {
      const value = controller.getValue?.();
      const validationError = controller.validate?.(value);
      if (validationError) {
        setDialogError(validationError);
        return;
      }
      close(value);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
    };
    const onBackdropClick = (event) => {
      if (event.target === modal) close(null);
    };

    cancelBtn.addEventListener('click', onCancel);
    submitBtn.addEventListener('click', onSubmit);
    document.addEventListener('keydown', onKeydown, true);
    modal.addEventListener('click', onBackdropClick);
    modal.classList.remove('hidden');
    eventBus.emit('modal:open');
    controller.focus?.();
  });
}

function expandPageSelection(text, pageCount) {
  const tokens = String(text)
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const pages = new Set();

  for (const token of tokens) {
    const range = token.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (range) {
      const fromPage = clamp(Number(range[1]), 1, pageCount);
      const toPage = clamp(Number(range[2]), fromPage, pageCount);
      for (let page = fromPage; page <= toPage; page++) {
        pages.add(page);
      }
      continue;
    }

    const single = token.match(/^(\d+)$/);
    if (single) {
      pages.add(clamp(Number(single[1]), 1, pageCount));
    }
  }

  return [...pages].sort((left, right) => left - right);
}

function summarizePages(pages = []) {
  if (pages.length === 0) return '尚未選擇頁面';
  if (pages.length === 1) return `第 ${pages[0]} 頁`;

  const segments = [];
  let start = pages[0];
  let previous = pages[0];

  for (let index = 1; index < pages.length; index++) {
    const page = pages[index];
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    segments.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }

  segments.push(start === previous ? `${start}` : `${start}-${previous}`);
  return `第 ${segments.join(', ')} 頁`;
}

function buildPageScopeControls(pageCount, currentPage, defaults) {
  const scopeSelect = buildSelect([
    ['current', `只有目前頁（第 ${currentPage} 頁）`],
    ['all', `全部頁面（1-${pageCount}）`],
    ['range', '連續範圍'],
    ['pages', '指定頁號清單'],
  ], defaults.mode === 'custom' ? 'range' : defaults.mode);

  const fromInput = document.createElement('input');
  fromInput.type = 'number';
  fromInput.className = 'form-input';
  fromInput.min = '1';
  fromInput.max = String(pageCount);
  fromInput.value = String(defaults.fromPage);

  const toInput = document.createElement('input');
  toInput.type = 'number';
  toInput.className = 'form-input';
  toInput.min = '1';
  toInput.max = String(pageCount);
  toInput.value = String(defaults.toPage);

  const pagesInput = document.createElement('input');
  pagesInput.type = 'text';
  pagesInput.className = 'form-input';
  pagesInput.placeholder = '例如 1, 3, 5-8';
  if (defaults.mode === 'pages' && Array.isArray(defaults.pages)) {
    pagesInput.value = defaults.pages.join(', ');
  }

  const rangeRow = el('div', 'workflow-inline-fields');
  rangeRow.appendChild(buildFormGroup('起始頁', fromInput));
  rangeRow.appendChild(buildFormGroup('結束頁', toInput));

  const pagesRow = el('div', 'workflow-panel-subtle');
  pagesRow.appendChild(buildFormGroup('指定頁號', pagesInput, '支援單頁與區間，例如 1, 3, 5-8。'));

  const summary = el('div', 'workflow-help');

  const read = () => {
    if (scopeSelect.value === 'current') {
      return {
        mode: 'current',
        pages: [currentPage],
        fromPage: currentPage,
        toPage: currentPage,
      };
    }

    if (scopeSelect.value === 'all') {
      return {
        mode: 'all',
        pages: Array.from({ length: pageCount }, (_, index) => index + 1),
        fromPage: 1,
        toPage: pageCount,
      };
    }

    if (scopeSelect.value === 'pages') {
      const pages = expandPageSelection(pagesInput.value, pageCount);
      return {
        mode: 'pages',
        pages,
        fromPage: pages[0] ?? currentPage,
        toPage: pages[pages.length - 1] ?? currentPage,
      };
    }

    const fromPage = clamp(Number(fromInput.value) || 1, 1, pageCount);
    const toPage = clamp(Number(toInput.value) || fromPage, fromPage, pageCount);
    return {
      mode: 'range',
      pages: Array.from({ length: toPage - fromPage + 1 }, (_, index) => fromPage + index),
      fromPage,
      toPage,
    };
  };

  const sync = () => {
    rangeRow.style.display = scopeSelect.value === 'range' ? 'grid' : 'none';
    pagesRow.style.display = scopeSelect.value === 'pages' ? 'block' : 'none';

    if (scopeSelect.value === 'current') {
      fromInput.value = String(currentPage);
      toInput.value = String(currentPage);
    }
    if (scopeSelect.value === 'all') {
      fromInput.value = '1';
      toInput.value = String(pageCount);
    }

    const scope = read();
    summary.textContent = `會套用到 ${scope.pages.length} 頁，範圍：${summarizePages(scope.pages)}。`;
  };

  scopeSelect.addEventListener('change', sync);
  fromInput.addEventListener('input', sync);
  toInput.addEventListener('input', sync);
  pagesInput.addEventListener('input', sync);
  sync();

  return {
    scopeSelect,
    row: rangeRow,
    rangeRow,
    pagesRow,
    pagesInput,
    fromInput,
    toInput,
    summary,
    read,
    validate() {
      if (scopeSelect.value === 'range') {
        const fromPage = Number(fromInput.value);
        const toPage = Number(toInput.value);
        if (!fromPage || !toPage) return '請輸入完整的頁面範圍。';
        if (fromPage > toPage) return '頁面範圍需要由小到大。';
      }

      if (scopeSelect.value === 'pages' && read().pages.length === 0) {
        return '請輸入至少一個有效頁碼，例如 1, 3, 5-8。';
      }

      return '';
    },
    setFromIntent(range) {
      scopeSelect.value = range.mode === 'custom' ? 'range' : range.mode;
      fromInput.value = String(range.fromPage);
      toInput.value = String(range.toPage);
      pagesInput.value = range.mode === 'custom' && range.fromPage === range.toPage
        ? String(range.fromPage)
        : `${range.fromPage}-${range.toPage}`;
      sync();
    },
  };
}

function getSelectedPageScope(state) {
  const selectedPages = [...new Set((state.selectedPageNumbers ?? []).filter((pageNumber) => pageNumber >= 1 && pageNumber <= state.pageCount))]
    .sort((left, right) => left - right);
  if (selectedPages.length > 1) {
    return {
      mode: 'pages',
      pages: selectedPages,
      fromPage: selectedPages[0],
      toPage: selectedPages[selectedPages.length - 1],
    };
  }
  return {
    mode: 'current',
    pages: [state.currentPage],
    fromPage: state.currentPage,
    toPage: state.currentPage,
  };
}
async function openDeleteConfirmDialog(pageNumber) {
  const result = await showWorkflowDialog({
    title: '刪除頁面',
    description: `你要刪除的是第 ${pageNumber} 頁。這個操作可以透過復原找回。`,
    submitLabel: '刪除頁面',
    submitClassName: 'btn btn-danger',
    buildContent(body) {
      body.appendChild(el('p', 'workflow-help', '確認後會立即重算頁數、縮圖與標注頁碼。'));
      return {};
    },
  });
  return Boolean(result !== null);
}

async function openSplitDialog(pageCount) {
  return showWorkflowDialog({
    title: '拆分 PDF',
    description: '直接輸入頁面範圍即可，例如 1-3, 4-7, 8-12。',
    submitLabel: '開始拆分',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');
      const intent = document.createElement('textarea');
      intent.className = 'form-input inspector-textarea';
      intent.rows = 5;
      intent.placeholder = '例如 1-3, 4-7, 8-12';
      const summary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      const details = el('div', 'workflow-help');

      const update = () => {
        const ranges = parseSplitRanges(intent.value, pageCount);
        chips.innerHTML = '';
        if (ranges.length === 0) {
          details.textContent = '目前還沒有辨識到可用的頁面範圍。';
          return;
        }
        details.textContent = `將輸出 ${ranges.length} 份 PDF。`;
        ranges.slice(0, 8).forEach((range) => {
          const chip = el('span', 'workflow-chip', range.from === range.to ? `第 ${range.from} 頁` : `${range.from}-${range.to}`);
          chips.appendChild(chip);
        });
      };

      left.appendChild(el('div', 'workflow-section-title', '拆分設定'));
      left.appendChild(buildFormGroup('頁面範圍', intent, '支援單頁與區間，使用逗號分隔。'));
      right.appendChild(el('div', 'workflow-section-title', '輸出預覽'));
      summary.appendChild(details);
      summary.appendChild(chips);
      right.appendChild(summary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      intent.addEventListener('input', update);
      update();

      return {
        focus() { intent.focus(); },
        getValue() {
          return parseSplitRanges(intent.value, pageCount);
        },
        validate(value) {
          return value.length === 0 ? '請描述要拆分的頁面範圍。' : '';
        },
      };
    },
  });
}

async function openPageNumberDialog(state) {
  const previewMetrics = await getWorkflowPreviewMetrics(state.currentPage);
  const previewWidth = previewMetrics.displayWidthPt;
  const previewHeight = previewMetrics.displayHeightPt;
  const defaultScope = getSelectedPageScope(state);
  const previewShell = await createWorkflowPreviewPage(previewMetrics, state.currentPage);
  return showWorkflowDialog({
    title: '插入頁碼',
    description: '你可以直接描述需求，也可以手動調整。右側會即時預覽位置與內容。',
    submitLabel: '插入頁碼',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');
      const intent = document.createElement('textarea');
      intent.className = 'form-input inspector-textarea';
      intent.rows = 4;
      intent.placeholder = '例如：從第 5 頁開始編號，放在右下角，附上製作時間';
      const positionSelect = buildSelect(PAGE_NUMBER_POSITIONS, 'bottom-center');
      const startNumber = document.createElement('input');
      startNumber.type = 'number';
      startNumber.className = 'form-input';
      startNumber.min = '1';
      startNumber.value = '1';
      const timeSourceSelect = buildSelect(PAGE_NUMBER_TIME_SOURCES, 'inserted');
      const timeFormatSelect = buildSelect(PAGE_NUMBER_TIME_FORMATS, 'yyyy-mm-dd-hh-mm');
      const scopeControls = buildPageScopeControls(state.pageCount, state.currentPage, {
        mode: defaultScope.mode,
        fromPage: defaultScope.fromPage,
        toPage: defaultScope.toPage,
        pages: defaultScope.pages,
      });
      const { wrapper: includeTimeWrapper, input: includeTimeInput } = buildCheckbox('附上製作時間', false);

      const previewLabel = el('div', 'workflow-preview-label bottom-center');
      previewShell.appendChild(previewLabel);
      const previewSummary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      previewSummary.appendChild(chips);
      const timeSourceGroup = buildFormGroup('時間來源', timeSourceSelect, '可選插入當下時間，或取用目前 PDF 的最後修改時間。');
      const timeFormatGroup = buildFormGroup('顯示格式', timeFormatSelect);

      const updateTimeControlState = () => {
        const enabled = includeTimeInput.checked;
        timeSourceSelect.disabled = !enabled;
        timeFormatSelect.disabled = !enabled;
        timeSourceGroup.classList.toggle('muted', !enabled);
        timeFormatGroup.classList.toggle('muted', !enabled);
      };

      const updatePreview = () => {
        updateTimeControlState();
        const scope = scopeControls.read();
        const timestampText = resolvePageNumberTimestampText({
          includeTimestamp: includeTimeInput.checked,
          source: timeSourceSelect.value,
          format: timeFormatSelect.value,
        });
        const content = includeTimeInput.checked
          ? `${startNumber.value || '1'}\n${timestampText}`
          : `${startNumber.value || '1'}`;
        const pageNumberLayout = resolvePageNumberLayout({
          pageWidth: previewWidth,
          pageHeight: previewHeight,
          position: positionSelect.value,
          text: String(startNumber.value || '1'),
          fontSize: 10,
          marginPt: 20,
          timestampText,
          includeTimestamp: includeTimeInput.checked,
        });
        previewLabel.replaceChildren();
        const stack = el('div', 'workflow-preview-page-number-stack');
        stack.appendChild(el('span', 'workflow-preview-page-number-line', String(startNumber.value || '1')));
        if (includeTimeInput.checked) {
          stack.appendChild(el('span', 'workflow-preview-page-number-line secondary', timestampText));
        }
        previewLabel.appendChild(stack);
        previewLabel.className = 'workflow-preview-label';
        previewLabel.style.display = 'inline-flex';
        previewLabel.style.alignItems = 'center';
        previewLabel.style.justifyContent = 'center';
        previewLabel.style.minWidth = '2.25rem';
        applyPreviewPlacement(previewLabel, pageNumberLayout.block ?? pageNumberLayout.text, previewWidth, previewHeight, {
          translateX: positionSelect.value.includes('center') ? '-50%' : '0',
          translateY: '0',
        });
        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', humanizePosition(positionSelect.value)));
        chips.appendChild(el('span', 'workflow-chip', summarizePages(scope.pages)));
        if (includeTimeInput.checked) chips.appendChild(el('span', 'workflow-chip', '附帶製作時間'));
        if (includeTimeInput.checked) chips.appendChild(el('span', 'workflow-chip', PAGE_NUMBER_TIME_SOURCES.find(([value]) => value === timeSourceSelect.value)?.[1] ?? timeSourceSelect.value));
        if (includeTimeInput.checked) chips.appendChild(el('span', 'workflow-chip', PAGE_NUMBER_TIME_FORMATS.find(([value]) => value === timeFormatSelect.value)?.[1] ?? timeFormatSelect.value));
      };

      const applyIntent = () => {
        const text = intent.value;
        positionSelect.value = parsePositionIntent(text, positionSelect.value);
        startNumber.value = String(parseStartNumberIntent(text, Number(startNumber.value) || 1));
        scopeControls.setFromIntent(parsePageRangeIntent(text, state.pageCount, state.currentPage));
        includeTimeInput.checked = parseTimestampIntent(text, includeTimeInput.checked);
        updatePreview();
      };

      left.appendChild(el('div', 'workflow-section-title', '自然語言設定'));
      left.appendChild(buildFormGroup('描述你的需求', intent, '例如：右下角開始、從第 3 頁算起、附上製作時間。'));
      left.appendChild(buildFormGroup('頁碼位置', positionSelect));
      left.appendChild(buildFormGroup('起始編號', startNumber));
      left.appendChild(includeTimeWrapper);
      left.appendChild(timeSourceGroup);
      left.appendChild(timeFormatGroup);
      left.appendChild(buildFormGroup('套用範圍', scopeControls.scopeSelect));
      left.appendChild(scopeControls.rangeRow);
      left.appendChild(scopeControls.pagesRow);
      left.appendChild(scopeControls.summary);

      right.appendChild(el('div', 'workflow-section-title', '即時預覽'));
      right.appendChild(previewShell);
      right.appendChild(previewSummary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      intent.addEventListener('input', applyIntent);
      positionSelect.addEventListener('change', updatePreview);
      startNumber.addEventListener('input', updatePreview);
      scopeControls.scopeSelect.addEventListener('change', updatePreview);
      scopeControls.fromInput.addEventListener('input', updatePreview);
      scopeControls.toInput.addEventListener('input', updatePreview);
      scopeControls.pagesInput.addEventListener('input', updatePreview);
      includeTimeInput.addEventListener('change', updatePreview);
      timeSourceSelect.addEventListener('change', updatePreview);
      timeFormatSelect.addEventListener('change', updatePreview);
      updatePreview();

      return {
        focus() { intent.focus(); },
        getValue() {
          const timestampText = resolvePageNumberTimestampText({
            includeTimestamp: includeTimeInput.checked,
            source: timeSourceSelect.value,
            format: timeFormatSelect.value,
          });
          return {
            position: positionSelect.value,
            startNumber: Math.max(1, Number(startNumber.value) || 1),
            includeTimestamp: includeTimeInput.checked,
            timestampText,
            timestampSource: timeSourceSelect.value,
            timestampFormat: timeFormatSelect.value,
            ...scopeControls.read(),
          };
        },
        validate() {
          return scopeControls.validate();
        },
      };
    },
  });
}

async function openWatermarkDialog(state) {
  const createdAt = formatLocalTimestamp();
  const previewMetrics = await getWorkflowPreviewMetrics(state.currentPage);
  const previewWidth = previewMetrics.displayWidthPt;
  const previewHeight = previewMetrics.displayHeightPt;
  const defaultScope = getSelectedPageScope(state);
  const previewShell = await createWorkflowPreviewPage(previewMetrics, state.currentPage);
  return showWorkflowDialog({
    title: '加入浮水印',
    description: '支援自然語言設定，例如「把草稿放在中央，透明一點，附上製作時間」。',
    submitLabel: '加入浮水印',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');
      const sourceSelect = buildSelect([
        ['text', '文字浮水印'],
        ['image', '圖片浮水印'],
      ], 'text');
      const intent = document.createElement('textarea');
      intent.className = 'form-input inspector-textarea';
      intent.rows = 4;
      intent.placeholder = '例如：把「草稿」放在中央，旋轉 -35 度，透明一點，附上製作時間';
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.className = 'form-input';
      textInput.value = '草稿';
      const imagePickerBtn = el('button', 'btn', '選擇圖片…');
      imagePickerBtn.type = 'button';
      const imageStatus = el('span', 'workflow-help', '尚未選擇圖片');
      const imageInput = document.createElement('input');
      imageInput.type = 'file';
      imageInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
      imageInput.hidden = true;
      const positionSelect = buildSelect(WATERMARK_POSITIONS, 'center');
      const opacityInput = document.createElement('input');
      opacityInput.type = 'range';
      opacityInput.min = '0.05';
      opacityInput.max = '0.5';
      opacityInput.step = '0.01';
      opacityInput.value = '0.15';
      const scaleInput = document.createElement('input');
      scaleInput.type = 'range';
      scaleInput.min = '0.12';
      scaleInput.max = '0.6';
      scaleInput.step = '0.01';
      scaleInput.value = '0.28';
      const rotationInput = document.createElement('input');
      rotationInput.type = 'number';
      rotationInput.className = 'form-input';
      rotationInput.min = '-180';
      rotationInput.max = '180';
      rotationInput.value = '-45';
      const scopeControls = buildPageScopeControls(state.pageCount, state.currentPage, {
        mode: defaultScope.mode,
        fromPage: defaultScope.fromPage,
        toPage: defaultScope.toPage,
        pages: defaultScope.pages,
      });
      const { wrapper: includeTimeWrapper, input: includeTimeInput } = buildCheckbox('附上製作時間', false);
      const previewText = el('div', 'workflow-preview-watermark');
      const previewImage = document.createElement('img');
      previewImage.className = 'workflow-preview-watermark-image hidden';
      previewImage.alt = '圖片浮水印預覽';
      previewShell.appendChild(previewText);
      previewShell.appendChild(previewImage);
      const previewSummary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      previewSummary.appendChild(chips);
      let selectedImageFile = null;
      let selectedImageUrl = '';
      let selectedImageDimensions = { width: 1, height: 1 };

      const updatePreview = async () => {
        const sourceType = sourceSelect.value;
        const textValue = textInput.value.trim() || '草稿';
        const stamp = includeTimeInput.checked ? `${textValue}\n${createdAt}` : textValue;
        const isImage = sourceType === 'image';

        previewText.classList.toggle('hidden', isImage);
        previewImage.classList.toggle('hidden', !isImage);

        if (!isImage) {
          const watermarkLayout = resolveWatermarkLayout({
            pageWidth: previewWidth,
            pageHeight: previewHeight,
            position: positionSelect.value,
            text: stamp,
            fontSize: 60,
          });
          previewText.textContent = stamp;
          previewText.style.opacity = opacityInput.value;
          previewText.style.width = `${(watermarkLayout.width / previewWidth) * 100}%`;
          previewText.style.minHeight = `${(watermarkLayout.height / previewHeight) * 100}%`;
          applyPreviewPlacement(previewText, watermarkLayout, previewWidth, previewHeight, {
            extraTransform: `rotate(${rotationInput.value}deg)`,
          });
        } else if (selectedImageFile) {
          selectedImageDimensions = await readImageDimensions(selectedImageFile);
          const imageLayout = resolveImageWatermarkLayout({
            pageWidth: previewWidth,
            pageHeight: previewHeight,
            position: positionSelect.value,
            imageWidth: selectedImageDimensions.width,
            imageHeight: selectedImageDimensions.height,
            scale: Number(scaleInput.value),
          });
          previewImage.style.opacity = opacityInput.value;
          previewImage.style.width = `${(imageLayout.width / previewWidth) * 100}%`;
          previewImage.style.height = `${(imageLayout.height / previewHeight) * 100}%`;
          applyPreviewPlacement(previewImage, imageLayout, previewWidth, previewHeight, {
            extraTransform: `rotate(${rotationInput.value}deg)`,
          });
        }

        const scope = scopeControls.read();
        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', isImage ? '圖片浮水印' : '文字浮水印'));
        chips.appendChild(el('span', 'workflow-chip', humanizePosition(positionSelect.value)));
        chips.appendChild(el('span', 'workflow-chip', `透明度 ${Number(opacityInput.value).toFixed(2)}`));
        chips.appendChild(el('span', 'workflow-chip', `旋轉 ${rotationInput.value}°`));
        if (isImage) chips.appendChild(el('span', 'workflow-chip', `尺寸 ${Math.round(Number(scaleInput.value) * 100)}%`));
        chips.appendChild(el('span', 'workflow-chip', summarizePages(scope.pages)));
        if (includeTimeInput.checked) chips.appendChild(el('span', 'workflow-chip', '附帶製作時間'));
      };

      const applyIntent = () => {
        const parsed = parseWatermarkIntent(intent.value, state.pageCount, state.currentPage);
        if (parsed.text) textInput.value = parsed.text;
        positionSelect.value = parsed.position;
        rotationInput.value = String(parsed.rotation);
        opacityInput.value = String(parsed.opacity);
        includeTimeInput.checked = parsed.includeTimestamp;
        scopeControls.setFromIntent(parsed);
        updatePreview();
      };

      const opacityShell = el('div', 'form-group');
      opacityShell.appendChild(el('span', 'form-label', '透明度'));
      const opacityRow = el('div', 'inspector-range-row');
      const opacityValue = el('output', '', Number(opacityInput.value).toFixed(2));
      opacityRow.appendChild(opacityInput);
      opacityRow.appendChild(opacityValue);
      opacityShell.appendChild(opacityRow);

      const scaleShell = el('div', 'form-group');
      scaleShell.appendChild(el('span', 'form-label', '圖片尺寸'));
      const scaleRow = el('div', 'inspector-range-row');
      const scaleValue = el('output', '', `${Math.round(Number(scaleInput.value) * 100)}%`);
      scaleRow.appendChild(scaleInput);
      scaleRow.appendChild(scaleValue);
      scaleShell.appendChild(scaleRow);

      const imagePickerGroup = el('div', 'form-group');
      imagePickerGroup.appendChild(el('span', 'form-label', '浮水印圖片'));
      imagePickerGroup.appendChild(imagePickerBtn);
      imagePickerGroup.appendChild(imageStatus);
      imagePickerGroup.appendChild(imageInput);

      const updateFieldState = () => {
        const isImage = sourceSelect.value === 'image';
        intent.disabled = isImage;
        textInput.disabled = isImage;
        includeTimeInput.disabled = isImage;
        imagePickerBtn.disabled = !isImage;
        scaleInput.disabled = !isImage;
        imagePickerGroup.classList.toggle('hidden', !isImage);
        scaleShell.classList.toggle('hidden', !isImage);
      };

      left.appendChild(el('div', 'workflow-section-title', '自然語言設定'));
      left.appendChild(buildFormGroup('浮水印類型', sourceSelect));
      left.appendChild(buildFormGroup('描述你的需求', intent));
      left.appendChild(buildFormGroup('浮水印文字', textInput));
      left.appendChild(imagePickerGroup);
      left.appendChild(buildFormGroup('位置', positionSelect));
      left.appendChild(opacityShell);
      left.appendChild(scaleShell);
      left.appendChild(buildFormGroup('旋轉角度', rotationInput));
      left.appendChild(buildFormGroup('套用範圍', scopeControls.scopeSelect));
      left.appendChild(scopeControls.rangeRow);
      left.appendChild(scopeControls.pagesRow);
      left.appendChild(scopeControls.summary);
      left.appendChild(includeTimeWrapper);

      right.appendChild(el('div', 'workflow-section-title', '即時預覽'));
      right.appendChild(previewShell);
      right.appendChild(previewSummary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      intent.addEventListener('input', applyIntent);
      sourceSelect.addEventListener('change', () => {
        updateFieldState();
        void updatePreview();
      });
      textInput.addEventListener('input', () => { void updatePreview(); });
      positionSelect.addEventListener('change', () => { void updatePreview(); });
      opacityInput.addEventListener('input', () => {
        opacityValue.textContent = Number(opacityInput.value).toFixed(2);
        void updatePreview();
      });
      scaleInput.addEventListener('input', () => {
        scaleValue.textContent = `${Math.round(Number(scaleInput.value) * 100)}%`;
        void updatePreview();
      });
      rotationInput.addEventListener('input', () => { void updatePreview(); });
      includeTimeInput.addEventListener('change', () => { void updatePreview(); });
      scopeControls.scopeSelect.addEventListener('change', () => { void updatePreview(); });
      scopeControls.fromInput.addEventListener('input', () => { void updatePreview(); });
      scopeControls.toInput.addEventListener('input', () => { void updatePreview(); });
      scopeControls.pagesInput.addEventListener('input', () => { void updatePreview(); });
      imagePickerBtn.addEventListener('click', () => imageInput.click());
      imageInput.addEventListener('change', async () => {
        selectedImageFile = imageInput.files?.[0] ?? null;
        imageStatus.textContent = selectedImageFile ? selectedImageFile.name : '尚未選擇圖片';
        if (selectedImageUrl) URL.revokeObjectURL(selectedImageUrl);
        selectedImageUrl = '';
        if (selectedImageFile) {
          selectedImageUrl = URL.createObjectURL(selectedImageFile);
          previewImage.src = selectedImageUrl;
        } else {
          previewImage.removeAttribute('src');
        }
        await updatePreview();
      });
      updateFieldState();
      void updatePreview();

      return {
        focus() { intent.focus(); },
        getValue() {
          return {
            sourceType: sourceSelect.value,
            text: textInput.value.trim() || '草稿',
            imageFile: selectedImageFile,
            position: positionSelect.value,
            rotation: clamp(Number(rotationInput.value) || -45, -180, 180),
            opacity: clamp(Number(opacityInput.value) || 0.15, 0.05, 0.5),
            scale: clamp(Number(scaleInput.value) || 0.28, 0.12, 0.6),
            includeTimestamp: includeTimeInput.checked,
            timestampText: createdAt,
            ...scopeControls.read(),
          };
        },
        validate(value) {
          if (value.sourceType === 'image' && !value.imageFile) return '請先選擇圖片浮水印。';
          if (value.sourceType === 'image') return scopeControls.validate();
          if (!value.text.trim()) return '請輸入浮水印文字。';
          return scopeControls.validate();
        },
        dispose() {
          if (selectedImageUrl) URL.revokeObjectURL(selectedImageUrl);
        },
      };
    },
  });
}

async function openCropDialog(state) {
  const previewMetrics = await getWorkflowPreviewMetrics(state.currentPage);
  const previewWidth = previewMetrics.displayWidthPt;
  const previewHeight = previewMetrics.displayHeightPt;
  const pointsPerMm = 72 / 25.4;
  const defaultScope = getSelectedPageScope(state);
  const previewShell = await createWorkflowPreviewPage(previewMetrics, state.currentPage);

  return showWorkflowDialog({
    title: '裁切頁面',
    description: '用四邊裁切做乾淨版面整理。右側會直接顯示保留下來的可視區。',
    submitLabel: '套用裁切',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');
      const intent = document.createElement('textarea');
      intent.className = 'form-input inspector-textarea';
      intent.rows = 4;
      intent.placeholder = '例如：上下各裁 10 mm，左邊 5 mm，只套用第 2, 4-6 頁';

      const topInput = document.createElement('input');
      topInput.type = 'number';
      topInput.className = 'form-input';
      topInput.min = '0';
      topInput.step = '0.5';
      topInput.value = '0';

      const rightInput = document.createElement('input');
      rightInput.type = 'number';
      rightInput.className = 'form-input';
      rightInput.min = '0';
      rightInput.step = '0.5';
      rightInput.value = '0';

      const bottomInput = document.createElement('input');
      bottomInput.type = 'number';
      bottomInput.className = 'form-input';
      bottomInput.min = '0';
      bottomInput.step = '0.5';
      bottomInput.value = '0';

      const leftInput = document.createElement('input');
      leftInput.type = 'number';
      leftInput.className = 'form-input';
      leftInput.min = '0';
      leftInput.step = '0.5';
      leftInput.value = '0';

      const scopeControls = buildPageScopeControls(state.pageCount, state.currentPage, {
        mode: defaultScope.mode,
        fromPage: defaultScope.fromPage,
        toPage: defaultScope.toPage,
        pages: defaultScope.pages,
      });

      const cropInputsTop = el('div', 'workflow-inline-fields');
      cropInputsTop.appendChild(buildFormGroup('上方裁切（mm）', topInput));
      cropInputsTop.appendChild(buildFormGroup('右側裁切（mm）', rightInput));
      const cropInputsBottom = el('div', 'workflow-inline-fields');
      cropInputsBottom.appendChild(buildFormGroup('下方裁切（mm）', bottomInput));
      cropInputsBottom.appendChild(buildFormGroup('左側裁切（mm）', leftInput));

      const cropPreview = el('div', 'workflow-crop-preview');
      const handleModes = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left'];
      const handles = handleModes.map((mode) => {
        const handle = el('button', `workflow-crop-handle ${mode}`);
        handle.type = 'button';
        handle.setAttribute('aria-label', `調整${mode}`);
        handle.dataset.mode = mode;
        cropPreview.appendChild(handle);
        return handle;
      });
      previewShell.appendChild(cropPreview);
      const previewSummary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      previewSummary.appendChild(chips);

      const readMm = () => ({
        top: Math.max(0, Number(topInput.value) || 0),
        right: Math.max(0, Number(rightInput.value) || 0),
        bottom: Math.max(0, Number(bottomInput.value) || 0),
        left: Math.max(0, Number(leftInput.value) || 0),
      });

      const setAllSides = (value) => {
        topInput.value = value;
        rightInput.value = value;
        bottomInput.value = value;
        leftInput.value = value;
      };

      const clampCropPt = (cropPt) => {
        const next = { ...cropPt };
        next.left = clamp(next.left, 0, Math.max(0, previewWidth - 36));
        next.right = clamp(next.right, 0, Math.max(0, previewWidth - 36));
        next.top = clamp(next.top, 0, Math.max(0, previewHeight - 36));
        next.bottom = clamp(next.bottom, 0, Math.max(0, previewHeight - 36));
        if (next.left + next.right > previewWidth - 36) {
          const overflow = next.left + next.right - (previewWidth - 36);
          if (next.right >= next.left) next.right -= overflow;
          else next.left -= overflow;
        }
        if (next.top + next.bottom > previewHeight - 36) {
          const overflow = next.top + next.bottom - (previewHeight - 36);
          if (next.bottom >= next.top) next.bottom -= overflow;
          else next.top -= overflow;
        }
        return next;
      };

      const writeCropPt = (cropPt) => {
        const safe = clampCropPt(cropPt);
        topInput.value = (safe.top / pointsPerMm).toFixed(1);
        rightInput.value = (safe.right / pointsPerMm).toFixed(1);
        bottomInput.value = (safe.bottom / pointsPerMm).toFixed(1);
        leftInput.value = (safe.left / pointsPerMm).toFixed(1);
      };

      const applyIntent = () => {
        const text = String(intent.value);
        const allMatch = text.match(/四邊各\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i);
        if (allMatch) setAllSides(allMatch[1]);

        const verticalMatch = text.match(/上下各\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i);
        if (verticalMatch) {
          topInput.value = verticalMatch[1];
          bottomInput.value = verticalMatch[1];
        }

        const horizontalMatch = text.match(/左右各\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i);
        if (horizontalMatch) {
          leftInput.value = horizontalMatch[1];
          rightInput.value = horizontalMatch[1];
        }

        const mappings = [
          { input: topInput, pattern: /(?:上方|上邊|頂部)\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i },
          { input: rightInput, pattern: /(?:右側|右邊)\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i },
          { input: bottomInput, pattern: /(?:下方|下邊|底部)\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i },
          { input: leftInput, pattern: /(?:左側|左邊)\s*(\d+(?:\.\d+)?)\s*(?:mm|毫米)?/i },
        ];
        mappings.forEach(({ input, pattern }) => {
          const match = text.match(pattern);
          if (match) input.value = match[1];
        });

        scopeControls.setFromIntent(parsePageRangeIntent(text, state.pageCount, state.currentPage));
        updatePreview();
      };

      let stopDrag = null;
      const startCropDrag = (mode, pointerEvent) => {
        pointerEvent.preventDefault();
        pointerEvent.stopPropagation();
        const move = (event) => {
          const rect = previewShell.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const xPt = clamp(((event.clientX - rect.left) / rect.width) * previewWidth, 0, previewWidth);
          const yPt = clamp(((event.clientY - rect.top) / rect.height) * previewHeight, 0, previewHeight);
          const current = clampCropPt({
            top: readMm().top * pointsPerMm,
            right: readMm().right * pointsPerMm,
            bottom: readMm().bottom * pointsPerMm,
            left: readMm().left * pointsPerMm,
          });

          if (mode.includes('top')) current.top = yPt;
          if (mode.includes('right')) current.right = previewWidth - xPt;
          if (mode.includes('bottom')) current.bottom = previewHeight - yPt;
          if (mode.includes('left')) current.left = xPt;

          writeCropPt(current);
          updatePreview();
        };
        const end = () => {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', end, true);
          stopDrag = null;
        };
        stopDrag?.();
        stopDrag = end;
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', end, true);
      };

      const updatePreview = () => {
        const cropMm = readMm();
        const cropPt = clampCropPt({
          top: cropMm.top * pointsPerMm,
          right: cropMm.right * pointsPerMm,
          bottom: cropMm.bottom * pointsPerMm,
          left: cropMm.left * pointsPerMm,
        });
        cropPreview.style.left = `${(cropPt.left / previewWidth) * 100}%`;
        cropPreview.style.right = `${(cropPt.right / previewWidth) * 100}%`;
        cropPreview.style.top = `${(cropPt.top / previewHeight) * 100}%`;
        cropPreview.style.bottom = `${(cropPt.bottom / previewHeight) * 100}%`;

        const scope = scopeControls.read();
        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', `上 ${cropMm.top} mm`));
        chips.appendChild(el('span', 'workflow-chip', `右 ${cropMm.right} mm`));
        chips.appendChild(el('span', 'workflow-chip', `下 ${cropMm.bottom} mm`));
        chips.appendChild(el('span', 'workflow-chip', `左 ${cropMm.left} mm`));
        chips.appendChild(el('span', 'workflow-chip', summarizePages(scope.pages)));
      };

      left.appendChild(el('div', 'workflow-section-title', '裁切設定'));
      left.appendChild(buildFormGroup('自然語言設定', intent, '可直接寫：上下各裁 10 mm、左右各裁 5 mm、只套用第 3-6 頁。'));
      left.appendChild(cropInputsTop);
      left.appendChild(cropInputsBottom);
      left.appendChild(buildFormGroup('套用範圍', scopeControls.scopeSelect));
      left.appendChild(scopeControls.rangeRow);
      left.appendChild(scopeControls.pagesRow);
      left.appendChild(scopeControls.summary);
      left.appendChild(el('p', 'workflow-help', '可直接拖曳右側裁切框的四角或邊線；保留下來的區域會同步反映到毫米設定。'));

      right.appendChild(el('div', 'workflow-section-title', '裁切預覽'));
      right.appendChild(previewShell);
      right.appendChild(previewSummary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      intent.addEventListener('input', applyIntent);
      [topInput, rightInput, bottomInput, leftInput].forEach((input) => input.addEventListener('input', updatePreview));
      handles.forEach((handle) => handle.addEventListener('pointerdown', (event) => startCropDrag(handle.dataset.mode ?? '', event)));
      scopeControls.scopeSelect.addEventListener('change', updatePreview);
      scopeControls.fromInput.addEventListener('input', updatePreview);
      scopeControls.toInput.addEventListener('input', updatePreview);
      scopeControls.pagesInput.addEventListener('input', updatePreview);
      updatePreview();

      return {
        focus() { intent.focus(); },
        getValue() {
          const cropMm = readMm();
          return {
            trimTopPt: cropMm.top * pointsPerMm,
            trimRightPt: cropMm.right * pointsPerMm,
            trimBottomPt: cropMm.bottom * pointsPerMm,
            trimLeftPt: cropMm.left * pointsPerMm,
            ...scopeControls.read(),
          };
        },
        validate(value) {
          if (value.trimLeftPt + value.trimRightPt >= previewWidth - 36) return '左右裁切後頁面寬度太小。';
          if (value.trimTopPt + value.trimBottomPt >= previewHeight - 36) return '上下裁切後頁面高度太小。';
          return scopeControls.validate();
        },
        dispose() {
          stopDrag?.();
        },
      };
    },
  });
}

async function openRotateDialog(state, defaultAngle = 90) {
  const baseMetrics = await getWorkflowPreviewMetrics(state.currentPage);
  const defaultScope = getSelectedPageScope(state);
  const previewPage = await createWorkflowPreviewPage(baseMetrics, state.currentPage);
  return showWorkflowDialog({
    title: '旋轉頁面',
    description: '設定旋轉角度與頁面範圍。可一次套用到目前頁、指定範圍或全部頁面。',
    submitLabel: '套用旋轉',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');
      const angleSelect = buildSelect(ROTATE_ANGLES, String(defaultAngle));
      const scopeControls = buildPageScopeControls(state.pageCount, state.currentPage, {
        mode: defaultScope.mode,
        fromPage: defaultScope.fromPage,
        toPage: defaultScope.toPage,
        pages: defaultScope.pages,
      });
      const summary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      summary.appendChild(chips);
      let previewGeneration = 0;

      const updatePreview = async () => {
        const scope = scopeControls.read();
        const generation = ++previewGeneration;
        const rotatedMetrics = await getWorkflowPreviewMetrics(state.currentPage, Number(angleSelect.value));
        if (generation !== previewGeneration) return;
        await refreshWorkflowPreviewPage(previewPage, rotatedMetrics, state.currentPage);
        if (generation !== previewGeneration) return;
        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', `角度 ${angleSelect.value}°`));
        chips.appendChild(el('span', 'workflow-chip', summarizePages(scope.pages)));
      };

      left.appendChild(el('div', 'workflow-section-title', '旋轉設定'));
      left.appendChild(buildFormGroup('旋轉角度', angleSelect));
      left.appendChild(buildFormGroup('套用範圍', scopeControls.scopeSelect));
      left.appendChild(scopeControls.rangeRow);
      left.appendChild(scopeControls.pagesRow);
      left.appendChild(scopeControls.summary);
      left.appendChild(el('p', 'workflow-help', '90° 代表順時針一格，270° 代表逆時針一格。'));

      right.appendChild(el('div', 'workflow-section-title', '視覺預覽'));
      right.appendChild(previewPage);
      right.appendChild(summary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      angleSelect.addEventListener('change', () => { void updatePreview(); });
      scopeControls.scopeSelect.addEventListener('change', () => { void updatePreview(); });
      scopeControls.fromInput.addEventListener('input', () => { void updatePreview(); });
      scopeControls.toInput.addEventListener('input', () => { void updatePreview(); });
      scopeControls.pagesInput.addEventListener('input', () => { void updatePreview(); });
      void updatePreview();

      return {
        focus() { angleSelect.focus(); },
        getValue() {
          return {
            degrees: Number(angleSelect.value),
            ...scopeControls.read(),
          };
        },
        validate() {
          return scopeControls.validate();
        },
      };
    },
  });
}

async function openExportDialog(defaults = {}) {
  const annotationCount = annotationLayer.getAllAnnotations().length;
  const baseName = documentEngine.fileName?.replace(/\.pdf$/i, '') ?? 'document';

  return showWorkflowDialog({
    title: '另存新檔',
    description: '設定輸出檔名、標註保存方式與文件資訊。離線版會優先使用系統存檔視窗。',
    submitLabel: '開始匯出',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');

      const fileNameInput = document.createElement('input');
      fileNameInput.type = 'text';
      fileNameInput.className = 'form-input';
      fileNameInput.value = normalizePdfFileName(`${baseName}_annotated.pdf`);

      const { wrapper: flattenWrapper, input: flattenInput } = buildCheckbox('將標註扁平化寫入 PDF', defaults.flattenAnnotations ?? (annotationCount > 0));
      const { wrapper: metadataWrapper, input: metadataInput } = buildCheckbox('編輯輸出文件資訊', defaults.editMetadata ?? false);
      const { wrapper: protectionWrapper, input: protectionInput } = buildCheckbox('加入開啟密碼保護', defaults.enableProtection ?? false);

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'form-input';
      titleInput.placeholder = '標題（選填）';
      titleInput.value = defaults.metadata?.title ?? '';

      const authorInput = document.createElement('input');
      authorInput.type = 'text';
      authorInput.className = 'form-input';
      authorInput.placeholder = '作者（選填）';
      authorInput.value = defaults.metadata?.author ?? '';

      const subjectInput = document.createElement('input');
      subjectInput.type = 'text';
      subjectInput.className = 'form-input';
      subjectInput.placeholder = '主題（選填）';
      subjectInput.value = defaults.metadata?.subject ?? '';

      const keywordsInput = document.createElement('textarea');
      keywordsInput.className = 'form-input inspector-textarea';
      keywordsInput.rows = 3;
      keywordsInput.placeholder = '關鍵字（使用逗號分隔，例如：合約, 草稿, 內部）';
      keywordsInput.value = Array.isArray(defaults.metadata?.keywords) ? defaults.metadata.keywords.join(', ') : '';

      const userPasswordInput = document.createElement('input');
      userPasswordInput.type = 'password';
      userPasswordInput.className = 'form-input';
      userPasswordInput.placeholder = '開啟 PDF 時要輸入的密碼';
      userPasswordInput.value = defaults.protection?.userPassword ?? '';

      const ownerPasswordInput = document.createElement('input');
      ownerPasswordInput.type = 'password';
      ownerPasswordInput.className = 'form-input';
      ownerPasswordInput.placeholder = '擁有者密碼（可選，留空會與開啟密碼相同）';
      ownerPasswordInput.value = defaults.protection?.ownerPassword ?? '';

      const metadataFields = [titleInput, authorInput, subjectInput, keywordsInput];
      const protectionFields = [userPasswordInput, ownerPasswordInput];
      const summary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      const notes = el('div', 'workflow-preview-summary');
      summary.appendChild(chips);
      summary.appendChild(notes);

      const updateSummary = () => {
        metadataFields.forEach((field) => {
          field.disabled = !metadataInput.checked;
        });
        protectionFields.forEach((field) => {
          field.disabled = !protectionInput.checked;
        });

        const normalizedName = normalizePdfFileName(fileNameInput.value, `${baseName}_annotated.pdf`);
        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', capabilities.fileSystemAccess ? '系統存檔視窗' : '瀏覽器下載'));
        chips.appendChild(el('span', 'workflow-chip', flattenInput.checked ? `輸出 ${annotationCount} 個標註` : '只輸出 PDF 本體'));
        if (metadataInput.checked) chips.appendChild(el('span', 'workflow-chip', '附帶文件資訊'));
        if (protectionInput.checked) chips.appendChild(el('span', 'workflow-chip', '匯出後需密碼開啟'));

        notes.innerHTML = '';
        notes.appendChild(el('p', 'workflow-help', `輸出檔名：${normalizedName}`));
        if (!flattenInput.checked && annotationCount > 0) {
          notes.appendChild(el('p', 'workflow-help', '未勾選扁平化時，標註圖層不會一起寫入 PDF。'));
        }
        if (metadataInput.checked) {
          notes.appendChild(el('p', 'workflow-help', '可設定標題、作者、主題與關鍵字，方便離線文件管理。'));
        }
        if (protectionInput.checked) {
          notes.appendChild(el('p', 'workflow-help', '會在輸出後套用 PDF 開啟密碼保護。'));
        }
      };

      left.appendChild(el('div', 'workflow-section-title', '輸出設定'));
      left.appendChild(buildFormGroup('檔名', fileNameInput));
      left.appendChild(flattenWrapper);
      left.appendChild(metadataWrapper);
      left.appendChild(protectionWrapper);
      left.appendChild(buildFormGroup('標題', titleInput));
      left.appendChild(buildFormGroup('作者', authorInput));
      left.appendChild(buildFormGroup('主題', subjectInput));
      left.appendChild(buildFormGroup('關鍵字', keywordsInput));
      left.appendChild(buildFormGroup('開啟密碼', userPasswordInput));
      left.appendChild(buildFormGroup('擁有者密碼', ownerPasswordInput, '可選。若留空，會自動使用相同密碼。'));

      right.appendChild(el('div', 'workflow-section-title', '輸出摘要'));
      right.appendChild(summary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      fileNameInput.addEventListener('input', updateSummary);
      flattenInput.addEventListener('change', updateSummary);
      metadataInput.addEventListener('change', updateSummary);
      protectionInput.addEventListener('change', updateSummary);
      titleInput.addEventListener('input', updateSummary);
      authorInput.addEventListener('input', updateSummary);
      subjectInput.addEventListener('input', updateSummary);
      keywordsInput.addEventListener('input', updateSummary);
      userPasswordInput.addEventListener('input', updateSummary);
      ownerPasswordInput.addEventListener('input', updateSummary);
      updateSummary();

      return {
        focus() { fileNameInput.focus(); fileNameInput.select(); },
        getValue() {
          return {
            fileName: normalizePdfFileName(fileNameInput.value, `${baseName}_annotated.pdf`),
            flattenAnnotations: flattenInput.checked,
            metadata: metadataInput.checked ? {
              title: titleInput.value.trim(),
              author: authorInput.value.trim(),
              subject: subjectInput.value.trim(),
              keywords: keywordsInput.value
                .split(/[,\n，、]/)
                .map((keyword) => keyword.trim())
                .filter(Boolean),
            } : {},
            protection: protectionInput.checked ? {
              userPassword: userPasswordInput.value,
              ownerPassword: ownerPasswordInput.value,
            } : null,
          };
        },
        validate(value) {
          if (!value.fileName.trim()) return '請輸入輸出檔名。';
          if (value.protection && !String(value.protection.userPassword ?? '').trim()) {
            return '請輸入 PDF 開啟密碼。';
          }
          return '';
        },
      };
    },
  });
}

function openRecentDialog() {
  const recentDocs = loadRecentDocs();
  return showWorkflowDialog({
    title: '最近開啟',
    description: '離線版會記住最近處理過的文件名稱與時間；重新開啟同一份 PDF 時，既有工作階段會自動還原。',
    submitLabel: recentDocs.length > 0 ? '清除紀錄' : '關閉',
    submitClassName: recentDocs.length > 0 ? 'btn btn-danger' : 'btn',
    buildContent(body) {
      const panel = el('section', 'workflow-panel');
      if (recentDocs.length === 0) {
        panel.appendChild(el('p', 'workflow-help', '目前沒有最近開啟紀錄。'));
      } else {
        recentDocs.forEach((entry) => {
          const card = el('div', 'inspector-card');
          card.appendChild(el('div', 'inspector-section-title', entry.fileName));
          card.appendChild(el('p', 'workflow-help', `頁數：${entry.pageCount ?? '未知'} ｜ 最近開啟：${String(entry.lastOpenedAt ?? '').replace('T', ' ').replace(/\.\d+Z?$/, '')}`));
          panel.appendChild(card);
        });
      }
      panel.appendChild(el('p', 'workflow-help', '瀏覽器安全限制下，最近清單不會直接重開本機檔案；請重新選取同一份 PDF。'));
      body.appendChild(panel);

      return {
        getValue() {
          return { clear: recentDocs.length > 0 };
        },
      };
    },
  });
}

function openOfficeExportDialog(state) {
  const baseName = documentEngine.fileName?.replace(/\.pdf$/i, '') ?? 'document';
  return showWorkflowDialog({
    title: '轉換為 Office',
    description: '離線版會輸出真正的 DOCX / PPTX / XLSX 檔案。內容以頁面影像與可擷取文字為主，適合後續整理與再編輯。',
    submitLabel: '開始轉換',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');

      const formatSelect = buildSelect(OFFICE_EXPORT_FORMATS, 'docx');
      const fileNameInput = document.createElement('input');
      fileNameInput.type = 'text';
      fileNameInput.className = 'form-input';
      fileNameInput.value = normalizeOutputNameByFormat(`${baseName}_converted`, 'docx');

      const scopeControls = buildPageScopeControls(state.pageCount, state.currentPage, {
        mode: 'all',
        fromPage: 1,
        toPage: state.pageCount,
        pages: Array.from({ length: state.pageCount }, (_, index) => index + 1),
      });
      const { wrapper: includeImagesWrapper, input: includeImagesInput } = buildCheckbox('保留頁面影像', true);
      const { wrapper: includeTextWrapper, input: includeTextInput } = buildCheckbox('附帶文字擷取', true);
      const summary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      const notes = el('div', 'workflow-preview-summary');
      summary.appendChild(chips);
      summary.appendChild(notes);

      const sync = () => {
        const format = formatSelect.value;
        const extension = format === 'pptx' ? '.pptx' : format === 'xlsx' ? '.xlsx' : '.docx';
        fileNameInput.value = normalizeOutputNameByFormat(fileNameInput.value.replace(/\.[a-z0-9]{2,8}$/i, ''), format);

        includeImagesWrapper.style.display = format === 'xlsx' ? 'none' : 'block';
        includeTextWrapper.style.display = 'block';
        includeImagesInput.disabled = format === 'xlsx';
        if (format === 'pptx') includeTextInput.checked = false;

        const scope = scopeControls.read();
        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', OFFICE_EXPORT_FORMATS.find(([value]) => value === format)?.[1] ?? format));
        chips.appendChild(el('span', 'workflow-chip', summarizePages(scope.pages)));
        if (includeImagesInput.checked && format !== 'xlsx') chips.appendChild(el('span', 'workflow-chip', '包含頁面影像'));
        if (includeTextInput.checked) chips.appendChild(el('span', 'workflow-chip', '包含文字擷取'));

        notes.innerHTML = '';
        notes.appendChild(el('p', 'workflow-help', `輸出檔名：${fileNameInput.value}`));
        if (format === 'docx') notes.appendChild(el('p', 'workflow-help', 'Word 會保留頁面影像，並把可擷取文字附在各頁下方。'));
        if (format === 'pptx') notes.appendChild(el('p', 'workflow-help', 'PowerPoint 會將每一頁放成一張投影片。'));
        if (format === 'xlsx') notes.appendChild(el('p', 'workflow-help', 'Excel 會把每頁文字擷取結果拆成工作表。'));
      };

      left.appendChild(el('div', 'workflow-section-title', '轉換設定'));
      left.appendChild(buildFormGroup('輸出格式', formatSelect));
      left.appendChild(buildFormGroup('檔名', fileNameInput));
      left.appendChild(buildFormGroup('套用範圍', scopeControls.scopeSelect));
      left.appendChild(scopeControls.rangeRow);
      left.appendChild(scopeControls.pagesRow);
      left.appendChild(scopeControls.summary);
      left.appendChild(includeImagesWrapper);
      left.appendChild(includeTextWrapper);

      right.appendChild(el('div', 'workflow-section-title', '轉換摘要'));
      right.appendChild(summary);
      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      formatSelect.addEventListener('change', sync);
      fileNameInput.addEventListener('input', sync);
      scopeControls.scopeSelect.addEventListener('change', sync);
      scopeControls.fromInput.addEventListener('input', sync);
      scopeControls.toInput.addEventListener('input', sync);
      scopeControls.pagesInput.addEventListener('input', sync);
      includeImagesInput.addEventListener('change', sync);
      includeTextInput.addEventListener('change', sync);
      sync();

      return {
        focus() { formatSelect.focus(); },
        getValue() {
          return {
            format: formatSelect.value,
            fileName: fileNameInput.value,
            pages: scopeControls.read().pages,
            includePageImages: includeImagesInput.checked,
            includeExtractedText: includeTextInput.checked,
          };
        },
        validate(value) {
          if (!value.fileName.trim()) return '請輸入輸出檔名。';
          if (!value.pages?.length) return '請選擇至少一頁。';
          if (value.format === 'pptx' && !value.includePageImages) return 'PowerPoint 轉換至少需要頁面影像。';
          return '';
        },
      };
    },
  });
}

async function exportCurrentDocumentToOffice(state) {
  if (state.documentStatus !== 'ready') return;

  const settings = await openOfficeExportDialog(state);
  if (!settings) return;

  appRenderer.toast('正在轉換 Office 檔案…', 'info', 8000);
  try {
    let blob = null;
    if (settings.format === 'pptx') {
      blob = await exportPdfToPptx(documentEngine, {
        pageNumbers: settings.pages,
        title: documentEngine.fileName ?? 'OpenSpec Export',
      });
    } else if (settings.format === 'xlsx') {
      blob = await exportPdfToXlsx(documentEngine, {
        pageNumbers: settings.pages,
      });
    } else {
      blob = await exportPdfToDocx(documentEngine, {
        pageNumbers: settings.pages,
        title: documentEngine.fileName ?? 'OpenSpec Export',
        includePageImages: settings.includePageImages,
        includeExtractedText: settings.includeExtractedText,
      });
    }

    const result = await saveBlobToFile(blob, settings.fileName);
    if (result.cancelled) {
      appRenderer.toast('已取消轉換', 'info');
      return;
    }
    appRenderer.toast(`已輸出 ${settings.format.toUpperCase()} 檔案`, 'success');
  } catch (error) {
    appRenderer.toast(`Office 轉換失敗：${error.message}`, 'error');
  }
}

async function openSignatureDialog() {
  const preview = document.createElement('div');
  preview.className = 'workflow-preview-signature';

  const defaultDateText = signaturePresetDraft?.dateText
    || new Intl.DateTimeFormat('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()).replaceAll('/', '.');

  return showWorkflowDialog({
    title: '建立電子簽署',
    description: '可建立打字簽名、手寫簽名或圖片簽名。確認後回到文件頁面拖曳放置範圍。',
    submitLabel: '使用這個簽名',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');

      const modeSelect = buildSelect([
        ['typed', '打字簽名'],
        ['drawn', '手寫簽名'],
        ['image', '圖片簽名'],
      ], signaturePresetDraft?.mode ?? 'typed');

      const signerInput = document.createElement('input');
      signerInput.type = 'text';
      signerInput.className = 'form-input';
      signerInput.placeholder = '簽署者姓名';
      signerInput.value = signaturePresetDraft?.signerName ?? '';

      const subtitleInput = document.createElement('input');
      subtitleInput.type = 'text';
      subtitleInput.className = 'form-input';
      subtitleInput.placeholder = '副標題（例如：電子簽署）';
      subtitleInput.value = signaturePresetDraft?.subtitle ?? '電子簽署';

      const dateInput = document.createElement('input');
      dateInput.type = 'text';
      dateInput.className = 'form-input';
      dateInput.placeholder = '日期文字';
      dateInput.value = defaultDateText;

      const { wrapper: includeDateWrapper, input: includeDateInput } = buildCheckbox('附帶日期', signaturePresetDraft?.includeDate ?? true);

      const drawCanvas = document.createElement('canvas');
      drawCanvas.width = 520;
      drawCanvas.height = 180;
      drawCanvas.className = 'signature-pad';
      const drawContext = drawCanvas.getContext('2d');
      drawContext.lineCap = 'round';
      drawContext.lineJoin = 'round';
      drawContext.lineWidth = 3;
      drawContext.strokeStyle = '#1F2937';
      let drawing = false;
      let drawn = false;

      const resetDrawCanvas = () => {
        drawContext.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawContext.fillStyle = '#FFFFFF';
        drawContext.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
        drawContext.strokeStyle = '#CBD5E1';
        drawContext.lineWidth = 2;
        drawContext.beginPath();
        drawContext.moveTo(20, drawCanvas.height - 34);
        drawContext.lineTo(drawCanvas.width - 20, drawCanvas.height - 34);
        drawContext.stroke();
        drawContext.strokeStyle = '#1F2937';
        drawContext.lineWidth = 3;
      };
      resetDrawCanvas();

      const canvasPoint = (event) => {
        const rect = drawCanvas.getBoundingClientRect();
        return {
          x: ((event.clientX - rect.left) / rect.width) * drawCanvas.width,
          y: ((event.clientY - rect.top) / rect.height) * drawCanvas.height,
        };
      };

      drawCanvas.addEventListener('pointerdown', (event) => {
        drawing = true;
        drawn = true;
        const point = canvasPoint(event);
        drawContext.beginPath();
        drawContext.moveTo(point.x, point.y);
      });
      drawCanvas.addEventListener('pointermove', (event) => {
        if (!drawing) return;
        const point = canvasPoint(event);
        drawContext.lineTo(point.x, point.y);
        drawContext.stroke();
      });
      const stopDraw = () => { drawing = false; };
      drawCanvas.addEventListener('pointerup', stopDraw);
      drawCanvas.addEventListener('pointerleave', stopDraw);

      const clearDrawButton = el('button', 'btn', '清除手寫簽名');
      clearDrawButton.type = 'button';
      clearDrawButton.addEventListener('click', () => {
        drawn = false;
        resetDrawCanvas();
        syncPreview();
      });

      const imageInput = document.createElement('input');
      imageInput.type = 'file';
      imageInput.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
      imageInput.hidden = true;
      let signatureImageDataUrl = signaturePresetDraft?.mode === 'image' ? signaturePresetDraft.dataUrl ?? '' : '';

      const imageButton = el('button', 'btn', '選擇簽名圖片');
      imageButton.type = 'button';
      imageButton.addEventListener('click', () => imageInput.click());
      imageInput.addEventListener('change', async () => {
        const file = imageInput.files?.[0];
        if (!file) return;
        signatureImageDataUrl = await fileToDataUrl(file);
        syncPreview();
      });

      const modeGroups = {
        typed: el('div', 'workflow-preview-summary'),
        drawn: el('div', 'workflow-preview-summary'),
        image: el('div', 'workflow-preview-summary'),
      };

      modeGroups.typed.appendChild(buildFormGroup('簽署者姓名', signerInput));
      modeGroups.typed.appendChild(buildFormGroup('副標題', subtitleInput));
      modeGroups.typed.appendChild(includeDateWrapper);
      modeGroups.typed.appendChild(buildFormGroup('日期文字', dateInput));

      modeGroups.drawn.appendChild(el('div', 'workflow-help', '直接在下方簽名板手寫。輸出時會保留目前外觀。'));
      modeGroups.drawn.appendChild(drawCanvas);
      modeGroups.drawn.appendChild(clearDrawButton);

      modeGroups.image.appendChild(imageButton);
      modeGroups.image.appendChild(imageInput);
      modeGroups.image.appendChild(el('p', 'workflow-help', '建議使用透明背景 PNG；JPG / WebP 也可。'));

      const updateMode = () => {
        Object.entries(modeGroups).forEach(([mode, node]) => {
          node.classList.toggle('hidden', mode !== modeSelect.value);
        });
        signerInput.disabled = modeSelect.value !== 'typed';
        subtitleInput.disabled = modeSelect.value !== 'typed';
        includeDateInput.disabled = modeSelect.value !== 'typed';
        dateInput.disabled = modeSelect.value !== 'typed' || !includeDateInput.checked;
      };

      const buildPreset = () => {
        if (modeSelect.value === 'drawn') {
          return {
            mode: 'drawn',
            signerName: '手寫簽名',
            includeDate: false,
            dateText: '',
            dataUrl: drawCanvas.toDataURL('image/png'),
          };
        }
        if (modeSelect.value === 'image') {
          return {
            mode: 'image',
            signerName: '圖片簽名',
            includeDate: false,
            dateText: '',
            dataUrl: signatureImageDataUrl,
          };
        }
        return buildTypedSignaturePreset({
          signerName: signerInput.value.trim(),
          subtitle: subtitleInput.value.trim() || '電子簽署',
          includeDate: includeDateInput.checked,
          dateText: dateInput.value.trim(),
        });
      };

      const syncPreview = () => {
        updateMode();
        const preset = buildPreset();
        preview.innerHTML = '';
        const image = document.createElement('img');
        image.className = 'workflow-preview-watermark-image';
        image.alt = '電子簽署預覽';
        image.src = preset.dataUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
        image.style.maxWidth = '100%';
        image.style.maxHeight = '220px';
        image.style.objectFit = 'contain';
        preview.appendChild(image);
      };

      modeSelect.addEventListener('change', syncPreview);
      signerInput.addEventListener('input', syncPreview);
      subtitleInput.addEventListener('input', syncPreview);
      includeDateInput.addEventListener('change', syncPreview);
      dateInput.addEventListener('input', syncPreview);
      drawCanvas.addEventListener('pointerup', syncPreview);

      left.appendChild(el('div', 'workflow-section-title', '簽名來源'));
      left.appendChild(buildFormGroup('簽名模式', modeSelect));
      left.appendChild(modeGroups.typed);
      left.appendChild(modeGroups.drawn);
      left.appendChild(modeGroups.image);

      right.appendChild(el('div', 'workflow-section-title', '簽名預覽'));
      right.appendChild(preview);
      right.appendChild(el('p', 'workflow-help', '確認後切換到簽署工具，回到頁面拖曳放置範圍。'));

      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      syncPreview();

      return {
        focus() { signerInput.focus(); signerInput.select(); },
        getValue() {
          return buildPreset();
        },
        validate(value) {
          if (modeSelect.value === 'typed' && !String(value.signerName ?? '').trim()) {
            return '請輸入簽署者姓名。';
          }
          if (modeSelect.value === 'drawn' && !drawn) {
            return '請先在簽名板上手寫簽名。';
          }
          if (modeSelect.value === 'image' && !String(value.dataUrl ?? '').trim()) {
            return '請先選擇簽名圖片。';
          }
          return '';
        },
      };
    },
  });
}
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
  if (capabilities.openFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        excludeAcceptAllOption: false,
        multiple: false,
        types: [{
          description: 'PDF 與圖片',
          accept: {
            'application/pdf': ['.pdf'],
            'image/png': ['.png'],
            'image/jpeg': ['.jpg', '.jpeg'],
            'image/webp': ['.webp'],
          },
        }],
      });
      return handle ? await handle.getFile() : null;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      console.warn('[OpenSpec] showOpenFilePicker failed, falling back to file input:', error);
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  // Accept PDF + images ??images are auto-converted to PDF before loading
  input.accept = '.pdf,application/pdf,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  input.multiple = false;
  input.click();
  return new Promise((resolve) => {
    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);
  });
}

/** Trigger browser download of a Blob with given filename. */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function saveBlobToFile(blob, suggestedName) {
  const normalizedName = normalizePdfFileName(suggestedName);

  if (capabilities.fileSystemAccess) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: normalizedName,
        types: [{
          description: 'PDF 文件',
          accept: { 'application/pdf': ['.pdf'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { cancelled: false, method: 'picker', fileName: normalizedName };
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { cancelled: true, method: 'picker', fileName: normalizedName };
      }
      console.warn('[OpenSpec] showSaveFilePicker failed, falling back to download:', error);
    }
  }

  downloadBlob(blob, normalizedName);
  return { cancelled: false, method: 'download', fileName: normalizedName };
}

// ---- Image to PDF ----

async function openImageDialog(allowMultiple = true) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  input.multiple = allowMultiple;
  input.click();
  return new Promise((resolve) => {
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
  });
}

async function openImageToPdfDialog(files, { openAfterConvert = false } = {}) {
  const orderedFiles = [...files];
  const dimensionsCache = new Map();

  const ensureDimensions = async (file) => {
    if (!dimensionsCache.has(file.name)) {
      dimensionsCache.set(file.name, await readImageDimensions(file));
    }
    return dimensionsCache.get(file.name);
  };

  return showWorkflowDialog({
    title: openAfterConvert ? '圖片轉 PDF 並開啟' : '圖片轉 PDF',
    description: '可調整頁面尺寸、DPI、邊距與圖片順序。設定完成後會直接產出離線 PDF。',
    submitLabel: openAfterConvert ? '轉成 PDF 並開啟' : '轉成 PDF',
    buildContent(body) {
      const layout = el('div', 'workflow-grid');
      const left = el('section', 'workflow-panel');
      const right = el('section', 'workflow-panel workflow-preview-shell');

      const pageSizeSelect = buildSelect(IMAGE_PAGE_SIZE_OPTIONS, 'fit-page');
      const dpiSelect = buildSelect(IMAGE_DPI_OPTIONS, '150');
      const marginSelect = buildSelect(IMAGE_MARGIN_OPTIONS, 'standard');
      const customMarginInput = document.createElement('input');
      customMarginInput.type = 'number';
      customMarginInput.className = 'form-input';
      customMarginInput.min = '0';
      customMarginInput.step = '1';
      customMarginInput.value = '10';

      const orderList = el('div', 'workflow-preview-summary');
      const summary = el('div', 'workflow-preview-summary');
      const chips = el('div', 'workflow-chip-row');
      summary.appendChild(chips);

      const rerenderList = () => {
        orderList.innerHTML = '';
        orderedFiles.forEach((file, index) => {
          const row = el('div', 'inspector-card');
          row.appendChild(el('div', 'inspector-section-title', `${index + 1}. ${file.name}`));
          const controls = el('div', 'workflow-chip-row');
          const upBtn = el('button', 'btn', '上移');
          const downBtn = el('button', 'btn', '下移');
          upBtn.disabled = index === 0;
          downBtn.disabled = index === orderedFiles.length - 1;
          upBtn.addEventListener('click', () => {
            if (index === 0) return;
            [orderedFiles[index - 1], orderedFiles[index]] = [orderedFiles[index], orderedFiles[index - 1]];
            rerenderList();
            void updateSummary();
          });
          downBtn.addEventListener('click', () => {
            if (index >= orderedFiles.length - 1) return;
            [orderedFiles[index + 1], orderedFiles[index]] = [orderedFiles[index], orderedFiles[index + 1]];
            rerenderList();
            void updateSummary();
          });
          controls.appendChild(upBtn);
          controls.appendChild(downBtn);
          row.appendChild(controls);
          orderList.appendChild(row);
        });
      };

      const updateSummary = async () => {
        customMarginInput.disabled = marginSelect.value !== 'custom';
        const firstFile = orderedFiles[0];
        const dims = firstFile ? await ensureDimensions(firstFile) : { width: 1200, height: 800 };
        const marginPt = resolveMarginPt({
          preset: marginSelect.value,
          customMm: Number(customMarginInput.value) || 0,
        });
        const pageSize = resolveTargetPageSize({
          pageSize: pageSizeSelect.value,
          imageWidthPx: dims.width,
          imageHeightPx: dims.height,
          dpi: Number(dpiSelect.value),
          marginPt,
        });
        const draw = resolveImageDrawLayout({
          pageWidthPt: pageSize.width,
          pageHeightPt: pageSize.height,
          imageWidthPx: dims.width,
          imageHeightPx: dims.height,
          dpi: Number(dpiSelect.value),
          marginPt,
        });

        chips.innerHTML = '';
        chips.appendChild(el('span', 'workflow-chip', `${orderedFiles.length} 張圖片`));
        chips.appendChild(el('span', 'workflow-chip', IMAGE_PAGE_SIZE_OPTIONS.find(([value]) => value === pageSizeSelect.value)?.[1] ?? pageSizeSelect.value));
        chips.appendChild(el('span', 'workflow-chip', `${dpiSelect.value} DPI`));
        chips.appendChild(el('span', 'workflow-chip', marginSelect.value === 'custom'
          ? `邊距 ${customMarginInput.value} mm`
          : IMAGE_MARGIN_OPTIONS.find(([value]) => value === marginSelect.value)?.[1] ?? '標準邊距'));

        right.innerHTML = '';
        right.appendChild(el('div', 'workflow-section-title', '輸出摘要'));
        right.appendChild(summary);
        const preview = el('div', 'workflow-preview-page');
        preview.style.aspectRatio = `${pageSize.width} / ${pageSize.height}`;
        const card = el('div', 'workflow-crop-preview');
        card.style.left = `${(draw.x / pageSize.width) * 100}%`;
        card.style.top = `${100 - ((draw.y + draw.height) / pageSize.height) * 100}%`;
        card.style.width = `${(draw.width / pageSize.width) * 100}%`;
        card.style.height = `${(draw.height / pageSize.height) * 100}%`;
        preview.appendChild(card);
        right.appendChild(preview);
      };

      left.appendChild(el('div', 'workflow-section-title', '版面設定'));
      left.appendChild(buildFormGroup('頁面尺寸', pageSizeSelect));
      left.appendChild(buildFormGroup('圖片 DPI', dpiSelect));
      left.appendChild(buildFormGroup('邊距', marginSelect));
      left.appendChild(buildFormGroup('自訂邊距（mm）', customMarginInput));
      left.appendChild(el('div', 'workflow-section-title', '圖片順序'));
      left.appendChild(orderList);

      layout.appendChild(left);
      layout.appendChild(right);
      body.appendChild(layout);

      pageSizeSelect.addEventListener('change', () => { void updateSummary(); });
      dpiSelect.addEventListener('change', () => { void updateSummary(); });
      marginSelect.addEventListener('change', () => { void updateSummary(); });
      customMarginInput.addEventListener('input', () => { void updateSummary(); });
      rerenderList();
      void updateSummary();

      return {
        focus() { pageSizeSelect.focus(); },
        getValue() {
          return {
            files: [...orderedFiles],
            pageSize: pageSizeSelect.value,
            dpi: Number(dpiSelect.value),
            marginPreset: marginSelect.value,
            customMarginMm: Number(customMarginInput.value) || 0,
          };
        },
        validate(value) {
          if (!value.files.length) return '請先選擇至少一張圖片。';
          if (value.marginPreset === 'custom' && value.customMarginMm < 0) return '自訂邊距不能小於 0。';
          return '';
        },
      };
    },
  });
}

async function imagesToPdfBlob(files, options = {}) {
  const { PDFDocument } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();
  const marginPt = resolveMarginPt({
    preset: options.marginPreset ?? 'standard',
    customMm: options.customMarginMm ?? 10,
  });
  let converted = 0;

  for (const file of files) {
    let image;
    let dimensions;
    try {
      image = await embedImageFile(pdfDoc, file);
      dimensions = await readImageDimensions(file);
    } catch (err) {
      appRenderer.toast(`略過 ${file.name}：${err.message}`, 'info');
      continue;
    }

    const pageSize = resolveTargetPageSize({
      pageSize: options.pageSize ?? 'fit-page',
      imageWidthPx: dimensions.width,
      imageHeightPx: dimensions.height,
      dpi: options.dpi ?? 150,
      marginPt,
    });
    const draw = resolveImageDrawLayout({
      pageWidthPt: pageSize.width,
      pageHeightPt: pageSize.height,
      imageWidthPx: dimensions.width,
      imageHeightPx: dimensions.height,
      dpi: options.dpi ?? 150,
      marginPt,
    });
    const page = pdfDoc.addPage([pageSize.width, pageSize.height]);
    page.drawImage(image, {
      x: draw.x,
      y: draw.y,
      width: draw.width,
      height: draw.height,
    });
    converted += 1;
  }

  if (converted === 0) return null;
  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function imagesToPdf(files) {
  const settings = await openImageToPdfDialog(files);
  if (!settings) return;

  appRenderer.toast('正在將圖片轉成 PDF…', 'info', 10000);
  try {
    const blob = await imagesToPdfBlob(settings.files, settings);
    if (!blob) {
      appRenderer.toast('沒有可轉換的圖片', 'error');
      return;
    }

    const baseName = settings.files[0].name.replace(/\.[^.]+$/, '');
    const suffix = settings.files.length > 1 ? `_${settings.files.length}pages` : '';
    const result = await saveBlobToFile(blob, `${baseName}${suffix}.pdf`);
    if (result.cancelled) {
      appRenderer.toast('已取消匯出', 'info');
      return;
    }
    appRenderer.toast(`已轉換 ${settings.files.length} 張圖片`, 'success');
  } catch (err) {
    appRenderer.toast(`圖片轉 PDF 失敗：${err.message}`, 'error');
  }
}

async function imagesToPdfAndOpen(files) {
  const settings = await openImageToPdfDialog(files, { openAfterConvert: true });
  if (!settings) return;

  appRenderer.toast('正在建立可編輯的 PDF…', 'info', 10000);
  try {
    const blob = await imagesToPdfBlob(settings.files, settings);
    if (!blob) {
      appRenderer.toast('沒有可轉換的圖片', 'error');
      return;
    }

    const baseName = settings.files[0].name.replace(/\.[^.]+$/, '');
    const pdfFile = new File([blob], `${baseName}.pdf`, { type: 'application/pdf' });
    documentEngine.openFile(pdfFile);
  } catch (err) {
    appRenderer.toast(`圖片轉 PDF 失敗：${err.message}`, 'error');
  }
}

// ---- Save As ----
async function saveAs(defaults = {}) {
  if (stateManager.state.documentStatus !== 'ready') return;

  const exportOptions = await openExportDialog(defaults);
  if (!exportOptions) return;

  appRenderer.setSaveStatus('saving');
  appRenderer.toast('正在輸出 PDF…', 'info', 8000);

  try {
    const annotations = exportOptions.flattenAnnotations ? annotationLayer.getAllAnnotations() : [];
    let blob = await documentEngine.exportToBlob(annotations, exportOptions);
    if (exportOptions.protection?.userPassword) {
      const protectedBytes = await protectPdfBytes(await blob.arrayBuffer(), exportOptions.protection);
      blob = new Blob([protectedBytes], { type: 'application/pdf' });
    }
    const result = await saveBlobToFile(blob, exportOptions.fileName);
    if (result.cancelled) {
      appRenderer.setSaveStatus('saved');
      appRenderer.toast('已取消匯出', 'info');
      return;
    }
    appRenderer.setSaveStatus('saved');
    appRenderer.toast(result.method === 'picker' ? '已儲存至本機檔案' : '已完成匯出下載', 'success');
  } catch (err) {
    appRenderer.setSaveStatus('error');
    appRenderer.toast(`匯出失敗：${err.message}`, 'error');
  }
}

// ---- Thumbnail generation (main-thread, yields between pages) ----
const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 136;
let thumbnailGeneration = 0;
let thumbnailSelectionAnchor = 1;

function resetEditorViewport() {
  document.getElementById('editor-stage').scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

function cloneAnnotations(annotations) {
  return JSON.parse(JSON.stringify(annotations));
}

async function captureEditorSnapshot(currentPage = stateManager.state.currentPage) {
  return {
    pdfBytes: await documentEngine.createSnapshotBytes(),
    annotations: cloneAnnotations(annotationLayer.getAllAnnotations()),
    currentPage,
    selectedPageNumbers: [...stateManager.state.selectedPageNumbers],
  };
}

async function restoreEditorSnapshot(snapshot) {
  await documentEngine.restoreFromBytes(snapshot.pdfBytes, snapshot.currentPage);
  annotationLayer.restoreAnnotations(cloneAnnotations(snapshot.annotations));
  stateManager.patch({
    currentPage: snapshot.currentPage,
    selectedAnnotationIds: [],
    selectedPageNumbers: [...(snapshot.selectedPageNumbers ?? [])],
  });
  eventBus.emit('annotations:changed');
}

async function runUndoableDocumentMutation({ description, mutate, successMessage }) {
  const before = await captureEditorSnapshot();
  await mutate();
  const after = await captureEditorSnapshot();
  const estimatedBytes = before.pdfBytes.byteLength + after.pdfBytes.byteLength +
    JSON.stringify(before.annotations).length + JSON.stringify(after.annotations).length;

  commandStack.record({
    execute: () => {
      restoreEditorSnapshot(after).catch((error) => {
        appRenderer.toast(`重做失敗：${error.message}`, 'error');
      });
    },
    undo: () => {
      restoreEditorSnapshot(before).catch((error) => {
        appRenderer.toast(`復原失敗：${error.message}`, 'error');
      });
    },
    description,
    estimatedBytes,
  });

  if (successMessage) {
    appRenderer.toast(successMessage, 'success');
  }
}

function clearThumbnailPanel() {
  thumbnailGeneration++;
  thumbnailSelectionAnchor = 1;
  document.getElementById('thumbnail-panel').innerHTML = '';
}

function cleanupThumbnailDragState() {
  const panel = document.getElementById('thumbnail-panel');
  delete panel.dataset.dragPage;
  panel.querySelectorAll('.thumbnail-item.dragging, .thumbnail-item.drop-target').forEach((item) => {
    item.classList.remove('dragging', 'drop-target');
  });
}

function updateThumbnailSelection(selectedPages = []) {
  const selectedSet = new Set(selectedPages);
  document.querySelectorAll('.thumbnail-item').forEach((item) => {
    const pageNumber = Number(item.getAttribute('data-page'));
    item.classList.toggle('selected', selectedSet.has(pageNumber));
    item.setAttribute('aria-selected', selectedSet.has(pageNumber) ? 'true' : 'false');
  });
}

function buildThumbnailItem(pageNumber) {
  const item = document.createElement('div');
  item.className = 'thumbnail-item';
  item.setAttribute('data-page', pageNumber);
  item.setAttribute('role', 'listitem');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-label', `第 ${pageNumber} 頁縮圖`);
  item.draggable = true;

  const frame = document.createElement('div');
  frame.className = 'thumbnail-frame';

  const canvas = document.createElement('canvas');
  canvas.className = 'thumbnail-canvas';
  canvas.width  = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  canvas.style.width = `${THUMB_WIDTH}px`;
  canvas.style.height = `${THUMB_HEIGHT}px`;

  const label = document.createElement('span');
  label.className = 'thumbnail-label';
  label.textContent = pageNumber;

  frame.appendChild(canvas);
  item.appendChild(frame);
  item.appendChild(label);
  if ((stateManager.state.selectedPageNumbers ?? []).includes(pageNumber)) {
    item.classList.add('selected');
    item.setAttribute('aria-selected', 'true');
  }

  item.addEventListener('click', (event) => {
    eventBus.emit('ui:action', {
      action: 'thumbnail-activate',
      page: pageNumber,
      value: {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      },
    });
  });

  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    eventBus.emit('ui:action', {
      action: 'thumbnail-activate',
      page: pageNumber,
      value: {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      },
    });
  });

  item.addEventListener('dragstart', (event) => {
    const panel = document.getElementById('thumbnail-panel');
    panel.dataset.dragPage = String(pageNumber);
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(pageNumber));
  });

  item.addEventListener('dragover', (event) => {
    const dragPage = Number(document.getElementById('thumbnail-panel').dataset.dragPage || 0);
    if (!dragPage || dragPage === pageNumber) return;
    event.preventDefault();
    item.classList.add('drop-target');
  });

  item.addEventListener('dragleave', () => {
    item.classList.remove('drop-target');
  });

  item.addEventListener('drop', (event) => {
    event.preventDefault();
    const fromPage = Number(event.dataTransfer.getData('text/plain') || document.getElementById('thumbnail-panel').dataset.dragPage || 0);
    item.classList.remove('drop-target');
    cleanupThumbnailDragState();
    if (!fromPage || fromPage === pageNumber) return;
    eventBus.emit('ui:action', { action: 'reorder-page', fromPage, toPage: pageNumber });
  });

  item.addEventListener('dragend', () => {
    cleanupThumbnailDragState();
  });


  return item;
}

async function generateAllThumbnails(pageCount) {
  const panel = document.getElementById('thumbnail-panel');
  const generation = thumbnailGeneration;

  for (let i = 1; i <= pageCount; i++) {
    if (generation !== thumbnailGeneration) return;
    const item = buildThumbnailItem(i);
    panel.appendChild(item);

    // Yield between pages to keep UI responsive
    await new Promise(r => setTimeout(r, 0));
    if (generation !== thumbnailGeneration) return;

    try {
      const page      = await documentEngine.getPage(i);
      if (generation !== thumbnailGeneration) return;
      const naturalVp = page.getViewport({ scale: 1 });
      const layout = resolveThumbnailViewport({
        pageWidth: naturalVp.width,
        pageHeight: naturalVp.height,
        maxWidth: THUMB_WIDTH,
        maxHeight: THUMB_HEIGHT,
      });
      const scale     = layout.scale;
      const viewport  = page.getViewport({ scale });
      const canvas    = item.querySelector('canvas');
      canvas.width    = Math.round(viewport.width);
      canvas.height   = Math.round(viewport.height);
      canvas.style.width  = `${layout.width}px`;
      canvas.style.height = `${layout.height}px`;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } catch {
      // Non-fatal: thumbnail stays as placeholder
    }
  }

  updateThumbnailSelection(stateManager.state.selectedPageNumbers);
  updateThumbnailHighlight(stateManager.state.currentPage);
}

function updateThumbnailHighlight(pageNumber) {
  const panel = document.getElementById('thumbnail-panel');
  panel.querySelector('.thumbnail-item.active')?.classList.remove('active');
  const activeItem = panel.querySelector(`.thumbnail-item[data-page="${pageNumber}"]`);
  activeItem?.classList.add('active');
  activeItem?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function resolveThumbnailSelection(pageNumber, state, modifiers = {}) {
  const additive = !!modifiers.additive;
  const range = !!modifiers.range;
  const currentSelection = [...new Set((state.selectedPageNumbers ?? []).filter((value) => value >= 1 && value <= state.pageCount))]
    .sort((left, right) => left - right);

  if (range) {
    const anchor = clamp(thumbnailSelectionAnchor || state.currentPage || pageNumber, 1, state.pageCount);
    const fromPage = Math.min(anchor, pageNumber);
    const toPage = Math.max(anchor, pageNumber);
    return Array.from({ length: toPage - fromPage + 1 }, (_, index) => fromPage + index);
  }

  if (additive) {
    const next = new Set(currentSelection);
    if (next.has(pageNumber)) next.delete(pageNumber);
    else next.add(pageNumber);
    return [...next].sort((left, right) => left - right);
  }

  return [pageNumber];
}

// ---- UI Action Router ----
async function handleAction({ action, value, page, files, source, fromPage, toPage, patch }) {
  const state = stateManager.state;

  switch (action) {
    // --- File ---
    case 'open':
      openFileDialog().then(f => {
        if (!f) return;
        const isImage = isImageLikeFile(f);
        if (isImage) {
          imagesToPdfAndOpen([f]);
        } else {
          documentEngine.openFile(f);
        }
      });
      break;
    case 'open-files': {
      if (!files?.length) break;
      const f = files[0];
      const isImg = isImageLikeFile(f);
      if (isImg) {
        const imgFiles = files.filter((x) => isImageLikeFile(x));
        imagesToPdfAndOpen(imgFiles);
      } else {
        documentEngine.openFile(f);
      }
      break;
    }
    case 'save-as':
      saveAs();
      break;
    case 'recent': {
      const result = await openRecentDialog();
      if (result?.clear) {
        saveRecentDocs([]);
        appRenderer.toast('已清除最近開啟紀錄', 'success');
      }
      break;
    }
    case 'close':
      stateManager.reset();
      commandStack.clear();
      clearThumbnailPanel();
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
      annotationLayer.selectAllOnCurrentPage();
      break; // TODO v0.5
    case 'delete':
      if (state.selectedAnnotationIds.length > 0) {
        annotationLayer.deleteSelected();
      } else if ((state.selectedPageNumbers?.length ?? 0) > 1) {
        const pages = [...state.selectedPageNumbers].sort((left, right) => left - right);
        if (state.pageCount - pages.length < 1) {
          appRenderer.toast('至少要保留一頁，無法刪除全部選取頁面', 'error');
          break;
        }
        const confirmed = await openDeleteConfirmDialog(pages[0]);
        if (!confirmed) break;
        try {
          await runUndoableDocumentMutation({
            description: `刪除 ${summarizePages(pages)}`,
            mutate: () => documentEngine.deletePages(pages, state.currentPage),
            successMessage: `已刪除 ${summarizePages(pages)}`,
          });
          stateManager.patch({ selectedPageNumbers: [Math.max(1, Math.min(state.currentPage, state.pageCount - pages.length))] });
        } catch (err) {
          appRenderer.toast(`刪除頁面失敗：${err.message}`, 'error');
        }
      } else if (state.documentStatus === 'ready' && state.pageCount > 1) {
        const confirmed = await openDeleteConfirmDialog(state.currentPage);
        if (!confirmed) break;
        try {
          await runUndoableDocumentMutation({
            description: `刪除第 ${state.currentPage} 頁`,
            mutate: () => documentEngine.deletePage(state.currentPage),
            successMessage: `已刪除第 ${state.currentPage} 頁`,
          });
        } catch (err) {
          appRenderer.toast(`刪除頁面失敗：${err.message}`, 'error');
        }
      }
      break;

    case 'delete-page': {
      const cp = stateManager.state.currentPage;
      const selectedPages = [...new Set((stateManager.state.selectedPageNumbers ?? []).filter((pageNumber) => pageNumber >= 1 && pageNumber <= stateManager.state.pageCount))]
        .sort((left, right) => left - right);
      if (stateManager.state.pageCount <= 1) {
        appRenderer.toast('至少要保留一頁，無法再刪除', 'error');
        break;
      }
      const pagesToDelete = selectedPages.length > 1 ? selectedPages : [cp];
      if (stateManager.state.pageCount - pagesToDelete.length < 1) {
        appRenderer.toast('至少要保留一頁，無法刪除全部選取頁面', 'error');
        break;
      }
      const confirmed = await openDeleteConfirmDialog(pagesToDelete[0]);
      if (!confirmed) break;
      try {
        await runUndoableDocumentMutation({
          description: pagesToDelete.length > 1 ? `刪除 ${summarizePages(pagesToDelete)}` : `刪除第 ${cp} 頁`,
          mutate: () => pagesToDelete.length > 1
            ? documentEngine.deletePages(pagesToDelete, cp)
            : documentEngine.deletePage(cp),
          successMessage: pagesToDelete.length > 1 ? `已刪除 ${summarizePages(pagesToDelete)}` : `已刪除第 ${cp} 頁`,
        });
      } catch (err) {
        appRenderer.toast(`刪除頁面失敗：${err.message}`, 'error');
      }
      break;
    }

    case 'rotate-cw': {
      const settings = await openRotateDialog(state, 90);
      if (!settings) break;
      try {
        const scopeLabel = summarizePages(settings.pages);
        await runUndoableDocumentMutation({
          description: `旋轉 ${scopeLabel} ${settings.degrees}°`,
          mutate: () => documentEngine.rotatePages(settings, state.currentPage),
          successMessage: `已旋轉 ${scopeLabel} ${settings.degrees}°`,
        });
      } catch (err) {
        appRenderer.toast(`旋轉失敗：${err.message}`, 'error');
      }
      break;
    }

    case 'rotate-ccw': {
      const settings = await openRotateDialog(state, 270);
      if (!settings) break;
      try {
        const scopeLabel = summarizePages(settings.pages);
        await runUndoableDocumentMutation({
          description: `旋轉 ${scopeLabel} ${settings.degrees}°`,
          mutate: () => documentEngine.rotatePages(settings, state.currentPage),
          successMessage: `已旋轉 ${scopeLabel} ${settings.degrees}°`,
        });
      } catch (err) {
        appRenderer.toast(`旋轉失敗：${err.message}`, 'error');
      }
      break;
    }

    case 'crop-pages': {
      const settings = await openCropDialog(state);
      if (!settings) break;
      try {
        const scopeLabel = summarizePages(settings.pages);
        await runUndoableDocumentMutation({
          description: `裁切 ${scopeLabel}`,
          mutate: () => documentEngine.cropPages(settings, state.currentPage),
          successMessage: `已裁切 ${scopeLabel}`,
        });
      } catch (err) {
        appRenderer.toast(`裁切失敗：${err.message}`, 'error');
      }
      break;
    }
    // --- Tools ---
    case 'tool-select':
    case 'tool-highlight':
    case 'tool-underline':
    case 'tool-draw':
    case 'tool-text':
    case 'tool-rect':
    case 'tool-circle':
    case 'tool-line':
    case 'tool-arrow':
    case 'tool-stamp': {
      const toolName = action.replace('tool-', '');
      stateManager.patch({ selectedTool: toolName });
      document.getElementById('annotation-layer-root')
        .querySelector('svg')
        ?.style.setProperty('cursor', toolName === 'select' ? 'default' : 'crosshair');
      break;
    }
    case 'tool-signature': {
      const preset = await openSignatureDialog();
      if (!preset) break;
      signaturePresetDraft = structuredClone(preset);
      annotationLayer.setSignaturePreset(preset);
      stateManager.patch({ selectedTool: 'signature', toolHubTab: 'esign' });
      document.getElementById('annotation-layer-root')
        .querySelector('svg')
        ?.style.setProperty('cursor', 'crosshair');
      appRenderer.toast('已切換到電子簽署工具，請回到頁面拖曳放置範圍。', 'success');
      break;
    }
    case 'set-tool-hub-tab':
      if (typeof value === 'string') stateManager.patch({ toolHubTab: value });
      break;

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
      // state.sidebarOpen = old value (true=was open ??now closing ??add 'sidebar-closed')
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
        stateManager.patch({ currentPage: page, selectedPageNumbers: [page] });
        eventBus.emit('page:navigate', { targetPage: page });
      }
      break;
    case 'thumbnail-activate': {
      if (page < 1 || page > state.pageCount) break;
      const selectedPageNumbers = resolveThumbnailSelection(page, state, value);
      if (!value?.additive || value?.range || selectedPageNumbers.length > 0) {
        thumbnailSelectionAnchor = page;
      }
      stateManager.patch({
        currentPage: page,
        selectedPageNumbers: selectedPageNumbers.length > 0 ? selectedPageNumbers : [page],
      });
      eventBus.emit('page:navigate', { targetPage: page });
      break;
    }
    case 'reorder-page':
      if (!fromPage || !toPage || fromPage === toPage) break;
      try {
        await runUndoableDocumentMutation({
          description: `移動第 ${fromPage} 頁到第 ${toPage} 頁`,
          mutate: () => documentEngine.reorderPage(fromPage, toPage),
          successMessage: `已將第 ${fromPage} 頁移到第 ${toPage} 頁`,
        });
      } catch (err) {
        appRenderer.toast(`移動頁面失敗：${err.message}`, 'error');
      }
      break;
    case 'update-selected-annotation': {
      const id = state.selectedAnnotationIds[0];
      if (!id || !patch) break;
      annotationLayer.updateAnnotation(id, patch);
      break;
    }

    // --- Tools menu ---
    case 'img2pdf':
      openImageDialog().then(files => { if (files.length) imagesToPdf(files); });
      break;
    case 'convert-office':
      await exportCurrentDocumentToOffice(state);
      break;
    case 'protect-pdf':
      await saveAs({
        enableProtection: true,
        flattenAnnotations: true,
      });
      break;

    case 'merge': {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,application/pdf';
      input.multiple = true;
      input.click();
      input.onchange = async () => {
        const files = Array.from(input.files);
        if (!files.length) return;
        appRenderer.toast(`正在合併 ${files.length} 份 PDF…`, 'info', 8000);
        try {
          if (stateManager.state.documentStatus !== 'ready') {
            await documentEngine.createNew();
            stateManager.patch({ documentStatus: 'loading' });
          }
          for (const file of files) {
            const buf = await file.arrayBuffer();
            await documentEngine.mergePdf(buf, stateManager.state.currentPage);
          }
          appRenderer.toast('PDF 合併完成', 'success');
        } catch (err) {
          appRenderer.toast(`PDF 合併失敗：${err.message}`, 'error');
        }
      };
      break;
    }

    case 'split': {
      if (stateManager.state.documentStatus !== 'ready') break;
      const pageCount = stateManager.state.pageCount;
      const ranges = await openSplitDialog(state.pageCount);
      if (!ranges) break;
      appRenderer.toast('正在拆分 PDF…', 'info', 10000);
      documentEngine.splitToRanges(ranges).then(async results => {
        if (results.length === 0) { appRenderer.toast('沒有可輸出的拆分結果', 'error'); return; }
        if (results.length === 1) {
          const blob = new Blob([results[0].bytes], { type: 'application/pdf' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = results[0].name; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } else {
          const zipFiles = {};
          for (const r of results) zipFiles[r.name] = r.bytes;
          const zipped = window.fflate.zipSync(zipFiles, { level: 0 });
          const blob = new Blob([zipped], { type: 'application/zip' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = 'split.zip'; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        appRenderer.toast(`已輸出 ${results.length} 份 PDF`, 'success');
      }).catch(err => appRenderer.toast(`拆分失敗：${err.message}`, 'error'));
      break;
    }

    case 'page-number': {
      const settings = await openPageNumberDialog(state);
      if (!settings) break;
      try {
        await runUndoableDocumentMutation({
          description: '加入頁碼',
          mutate: () => documentEngine.addPageNumbers(settings, state.currentPage),
          successMessage: '已套用頁碼',
        });
      } catch (err) {
        appRenderer.toast(`頁碼套用失敗：${err.message}`, 'error');
      }
      break;
    }

    case 'watermark': {
      const settings = await openWatermarkDialog(state);
      if (!settings) break;
      try {
        await runUndoableDocumentMutation({
          description: '加入浮水印',
          mutate: () => documentEngine.addWatermark(settings, state.currentPage),
          successMessage: '已套用浮水印',
        });
      } catch (err) {
        appRenderer.toast(`浮水印套用失敗：${err.message}`, 'error');
      }
      break;
    }

    case 'blank-page': {
      const cp = stateManager.state.currentPage;
      try {
        await runUndoableDocumentMutation({
          description: `在第 ${cp} 頁後插入空白頁`,
          mutate: () => documentEngine.insertBlankPage(cp),
          successMessage: `已在第 ${cp} 頁後插入空白頁`,
        });
      } catch (err) {
        appRenderer.toast(`插入空白頁失敗：${err.message}`, 'error');
      }
      break;
    }

    case 'clear-sessions':
      sessionDB.clearAll().then(() => appRenderer.toast('已清除暫存工作階段', 'success'));
      break;

    case 'about':
      appRenderer.toast('OpenSpec PDF Editor v0.1.0-alpha', 'info', 5000);
      break;
  }
}

// ---- Main Init ----
async function main() {
  console.log('[PDF蝺刻摩?沘 Initializing v0.1.0-alpha');

  // 1. Init layers (sync)
  canvasLayer.init(documentEngine);
annotationLayer.init(canvasLayer, documentEngine);

  // 3. Init UI chrome immediately so user sees the shell
  appRenderer.init();
  keyMap.init();
  setupPasswordModal();

  // 4. Wire EventBus handlers

  // Document lifecycle
  eventBus.on('document:open-requested', () => {
    stateManager.patch({ documentStatus: 'loading', errorMessage: null });
    appRenderer.showProgress(10, '正在載入文件…');
    clearThumbnailPanel();
  });

  let selectedAnnotation = null;
  const renderChrome = () => {
    appRenderer.renderShell(stateManager.state, {
      canUndo: commandStack.canUndo,
      canRedo: commandStack.canRedo,
    });
    appRenderer.renderInspector(stateManager.state, selectedAnnotation);
  };

  eventBus.on('document:loaded', async ({ pageCount, fileName, fileHash, source = 'open', currentPage = 1 }) => {
    const isFreshOpen = source === 'open';
    let targetPage = Math.min(Math.max(currentPage, 1), pageCount || 1);
    let targetZoom = isFreshOpen ? 1.0 : stateManager.state.zoom;
    let targetZoomMode = isFreshOpen ? 'fitWidth' : stateManager.state.zoomMode;
    let sessionRestored = false;

    stateManager.patch({
      documentStatus: 'ready',
      pageCount,
      currentPage: targetPage,
      selectedPageNumbers: [targetPage],
      zoom: targetZoom,
      zoomMode: targetZoomMode,
      sessionRestored,
    });
    appRenderer.hideProgress();
    document.getElementById('status-filename').textContent = fileName;
    clearThumbnailPanel();

    if (isFreshOpen) {
      rememberRecentDoc({ fileHash, fileName, pageCount });
    }

    if (isFreshOpen) {
      const session = await sessionDB.load(fileHash);
      if (session) {
        annotationLayer.restoreAnnotations(session.annotations ?? []);
        targetPage = Math.min(Math.max(session.lastPage ?? 1, 1), pageCount || 1);
        targetZoom = session.lastZoom ?? 1.0;
        targetZoomMode = session.lastZoom ? 'custom' : 'fitWidth';
        sessionRestored = true;
        stateManager.patch({
          currentPage: targetPage,
          selectedPageNumbers: [targetPage],
          zoom: targetZoom,
          zoomMode: targetZoomMode,
          sessionRestored,
        });
        appRenderer.toast('已還原上次工作狀態', 'success');
      }
    }

    generateAllThumbnails(pageCount);
    eventBus.emit('page:navigate', { targetPage });
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
    resetEditorViewport();
    updateThumbnailHighlight(targetPage);
    updateThumbnailSelection(stateManager.state.selectedPageNumbers);
  });

  // Annotation changes ??auto-save
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

  // CommandStack changes ??update menu disabled states
  eventBus.on('command:stack-changed', (cmdState) => {
    renderChrome();
  });

  // UI actions from menus, toolbar, keyboard
  eventBus.on('ui:action', handleAction);

  eventBus.on('annotation:selected', ({ annotation }) => {
    selectedAnnotation = annotation;
    if (annotation && !stateManager.state.inspectorOpen) {
      stateManager.patch({ inspectorOpen: true });
      document.getElementById('workspace').classList.remove('inspector-closed');
    }
    renderChrome();
  });

  // State changes ??re-render UI chrome
  stateManager.subscribe(({ changed }) => {
    const uiKeys = ['documentStatus', 'currentPage', 'pageCount', 'zoom', 'zoomMode', 'selectedTool', 'selectedAnnotationIds', 'selectedPageNumbers', 'toolHubTab'];
    if (changed.some(k => uiKeys.includes(k))) {
      renderChrome();
    }
    if (changed.includes('selectedPageNumbers')) {
      updateThumbnailSelection(stateManager.state.selectedPageNumbers);
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

  // 5. Initial render ??UI visible before any async work
  renderChrome();

  // 6. Async background init (non-blocking ??UI already painted)
  sessionDB.init()
    .then(() => sessionDB.cleanOld())
    .catch(err => console.warn('[SessionDB] Init failed:', err.message));

  console.log('[OpenSpec] Ready. Capabilities:', capabilities);
}

main().catch(err => {
  console.error('[OpenSpec] Fatal init error:', err);
  document.getElementById('load-error').innerHTML =
    `<h2>載入失敗</h2><p>${err.message}</p>`;
  document.getElementById('load-error').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
});

