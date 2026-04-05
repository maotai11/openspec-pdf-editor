const POSITION_LABELS = new Map([
  ['top-left', '左上'],
  ['top-center', '上方置中'],
  ['top-right', '右上'],
  ['bottom-left', '左下'],
  ['bottom-center', '下方置中'],
  ['bottom-right', '右下'],
  ['center', '置中'],
  ['left', '左側'],
  ['right', '右側'],
]);

export function formatLocalTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

export function humanizePosition(position) {
  return POSITION_LABELS.get(position) ?? position;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function parsePositionIntent(text = '', fallback = 'bottom-center') {
  const normalized = String(text).toLowerCase();
  if (!normalized.trim()) return fallback;

  const direct = [
    ['top-left', ['左上', '左上角', 'top-left']],
    ['top-center', ['上中', '上方置中', '上方中間', '置中上方', 'top-center']],
    ['top-right', ['右上', '右上角', 'top-right']],
    ['bottom-left', ['左下', '左下角', 'bottom-left']],
    ['bottom-center', ['下中', '下方置中', '下方中間', '置中下方', 'bottom-center']],
    ['bottom-right', ['右下', '右下角', 'bottom-right']],
    ['center', ['正中間', '置中', '中央', 'center']],
  ];

  for (const [position, aliases] of direct) {
    if (aliases.some(alias => normalized.includes(alias))) return position;
  }

  const [fallbackVertical, fallbackHorizontal = 'center'] = fallback.split('-');
  let vertical = fallbackVertical;
  let horizontal = fallbackHorizontal;

  if (/[上頂]/.test(normalized)) vertical = 'top';
  if (/[下底]/.test(normalized)) vertical = 'bottom';
  if (/左/.test(normalized)) horizontal = 'left';
  if (/右/.test(normalized)) horizontal = 'right';
  if (/[中置]/.test(normalized)) horizontal = 'center';

  if (normalized.includes('中央') || normalized.includes('正中')) return 'center';
  return `${vertical}-${horizontal}`;
}

export function parsePageRangeIntent(text = '', pageCount = 1, currentPage = 1) {
  const normalized = String(text).trim();
  if (!normalized || /全部|所有|每一頁/.test(normalized)) {
    return { mode: 'all', fromPage: 1, toPage: pageCount };
  }
  if (/本頁|這一頁|目前頁|當前頁/.test(normalized)) {
    return { mode: 'current', fromPage: currentPage, toPage: currentPage };
  }

  const startToEnd = normalized.match(/第?\s*(\d+)\s*頁\s*(?:到|至|-|~)\s*第?\s*(\d+)\s*頁/);
  if (startToEnd) {
    const fromPage = clamp(Number(startToEnd[1]), 1, pageCount);
    const toPage = clamp(Number(startToEnd[2]), fromPage, pageCount);
    return { mode: 'custom', fromPage, toPage };
  }

  const startOnly = normalized.match(/(?:從|自)\s*第?\s*(\d+)\s*頁\s*(?:開始|起)/);
  if (startOnly) {
    const fromPage = clamp(Number(startOnly[1]), 1, pageCount);
    return { mode: 'custom', fromPage, toPage: pageCount };
  }

  const single = normalized.match(/第?\s*(\d+)\s*頁/);
  if (single) {
    const page = clamp(Number(single[1]), 1, pageCount);
    return { mode: 'custom', fromPage: page, toPage: page };
  }

  return { mode: 'all', fromPage: 1, toPage: pageCount };
}

export function parseStartNumberIntent(text = '', fallback = 1) {
  const match = String(text).match(/(?:從|起始|開始|頁碼)\D*(\d+)/);
  if (match) return Math.max(1, Number(match[1]));
  return fallback;
}

export function parseTimestampIntent(text = '', fallback = false) {
  const normalized = String(text);
  if (/不要.*(時間|日期)|不含.*(時間|日期)|不加.*(時間|日期)/.test(normalized)) return false;
  if (/(製作|建立|輸出).*(時間|日期)|時間戳|timestamp|datetime/i.test(normalized)) return true;
  return fallback;
}

export function parseSplitRanges(text = '', pageCount = 1) {
  const normalized = String(text).trim();
  if (!normalized || /每頁|逐頁|全部分開|一頁一份/.test(normalized)) {
    return Array.from({ length: pageCount }, (_, index) => ({
      from: index + 1,
      to: index + 1,
    }));
  }

  const tokens = normalized
    .split(/[,\n、，]/)
    .map(token => token.trim())
    .filter(Boolean);

  const ranges = [];
  for (const token of tokens) {
    const range = token.match(/^(\d+)\s*[-~到至]\s*(\d+)?$/);
    if (range) {
      const from = clamp(Number(range[1]), 1, pageCount);
      const to = clamp(Number(range[2] ?? pageCount), from, pageCount);
      ranges.push({ from, to });
      continue;
    }

    const single = token.match(/^(\d+)$/);
    if (single) {
      const page = clamp(Number(single[1]), 1, pageCount);
      ranges.push({ from: page, to: page });
    }
  }

  return ranges;
}

export function parseWatermarkIntent(text = '', pageCount = 1, currentPage = 1) {
  const normalized = String(text).trim();
  const range = parsePageRangeIntent(normalized, pageCount, currentPage);
  const position = parsePositionIntent(normalized, 'center');
  const includeTimestamp = parseTimestampIntent(normalized, false);

  let rotation = -45;
  const rotationMatch = normalized.match(/(-?\d+)\s*度/);
  if (rotationMatch) rotation = clamp(Number(rotationMatch[1]), -180, 180);
  else if (/水平|橫向/.test(normalized)) rotation = 0;

  let opacity = 0.15;
  if (/很淡|淡一點|低調|透明一點/.test(normalized)) opacity = 0.1;
  if (/明顯|深一點|加重/.test(normalized)) opacity = 0.25;

  let textValue = '';
  const quoted = normalized.match(/[「"“](.+?)[」"”]/);
  if (quoted) textValue = quoted[1];
  else if (/草稿|draft/i.test(normalized)) textValue = '草稿';
  else if (/機密|confidential/i.test(normalized)) textValue = '機密';

  return {
    text: textValue,
    position,
    rotation,
    opacity,
    includeTimestamp,
    ...range,
  };
}
