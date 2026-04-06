function estimateTextWidth(text, fontSize, ratio = 0.6) {
  return String(text).length * fontSize * ratio;
}

export function resolvePageNumberLayout({
  pageWidth,
  pageHeight,
  position = 'bottom-center',
  text = '1',
  fontSize = 10,
  marginPt = 20,
  timestampText = '',
  includeTimestamp = false,
}) {
  const textWidth = estimateTextWidth(text, fontSize);
  const timestampSize = Math.max(8, Math.round(fontSize * 0.8));
  const timestampWidth = estimateTextWidth(timestampText, timestampSize, 0.55);
  const gap = includeTimestamp ? 4 : 0;
  const blockWidth = Math.max(textWidth, includeTimestamp ? timestampWidth : 0);
  const blockHeight = fontSize + (includeTimestamp ? timestampSize + gap : 0);

  let x = marginPt;
  let y = marginPt;

  if (position === 'center') {
    x = (pageWidth - blockWidth) / 2;
    y = (pageHeight - blockHeight) / 2;
  } else {
    if (position.includes('top')) {
      y = pageHeight - marginPt - blockHeight;
    }
    if (position.includes('center')) {
      x = (pageWidth - blockWidth) / 2;
    } else if (position.includes('right')) {
      x = pageWidth - marginPt - blockWidth;
    }
  }

  const textX = x + ((blockWidth - textWidth) / 2);
  const timestampX = x + ((blockWidth - timestampWidth) / 2);
  const textY = includeTimestamp ? y + timestampSize + gap : y;
  const timestampY = y;

  return {
    block: { x, y, width: blockWidth, height: blockHeight },
    text: { x: textX, y: textY, width: textWidth, height: fontSize, fontSize },
    timestamp: includeTimestamp ? {
      x: timestampX,
      y: timestampY,
      width: timestampWidth,
      height: timestampSize,
      fontSize: timestampSize,
    } : null,
  };
}

export function resolveWatermarkLayout({
  pageWidth,
  pageHeight,
  position = 'center',
  text = '草稿',
  fontSize = 60,
}) {
  const lines = String(text).split('\n');
  const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
  const blockWidth = longestLine * fontSize * 0.6;
  const blockHeight = lines.length * fontSize * 0.9;
  const margin = 36;

  let x = pageWidth / 2 - blockWidth / 2;
  let y = pageHeight / 2 - blockHeight / 2;

  if (position === 'top-left') { x = margin; y = pageHeight - margin - blockHeight; }
  if (position === 'top-center') { x = (pageWidth - blockWidth) / 2; y = pageHeight - margin - blockHeight; }
  if (position === 'top-right') { x = pageWidth - margin - blockWidth; y = pageHeight - margin - blockHeight; }
  if (position === 'bottom-left') { x = margin; y = margin; }
  if (position === 'bottom-center') { x = (pageWidth - blockWidth) / 2; y = margin; }
  if (position === 'bottom-right') { x = pageWidth - margin - blockWidth; y = margin; }
  if (position === 'left') { x = margin; y = pageHeight / 2 - blockHeight / 2; }
  if (position === 'right') { x = pageWidth - margin - blockWidth; y = pageHeight / 2 - blockHeight / 2; }

  return {
    x,
    y,
    width: blockWidth,
    height: blockHeight,
    lineHeight: fontSize * 0.9,
  };
}

export function resolveImageWatermarkLayout({
  pageWidth,
  pageHeight,
  position = 'center',
  imageWidth,
  imageHeight,
  scale = 0.28,
  marginPt = 36,
}) {
  const safeScale = Math.min(Math.max(Number(scale) || 0.28, 0.1), 0.9);
  const maxWidth = Math.max(48, pageWidth * safeScale);
  const aspectRatio = Math.max(0.05, Number(imageWidth) || 1) / Math.max(0.05, Number(imageHeight) || 1);
  const width = maxWidth;
  const height = width / aspectRatio;

  let x = pageWidth / 2 - width / 2;
  let y = pageHeight / 2 - height / 2;

  if (position === 'top-left') { x = marginPt; y = pageHeight - marginPt - height; }
  if (position === 'top-center') { x = (pageWidth - width) / 2; y = pageHeight - marginPt - height; }
  if (position === 'top-right') { x = pageWidth - marginPt - width; y = pageHeight - marginPt - height; }
  if (position === 'bottom-left') { x = marginPt; y = marginPt; }
  if (position === 'bottom-center') { x = (pageWidth - width) / 2; y = marginPt; }
  if (position === 'bottom-right') { x = pageWidth - marginPt - width; y = marginPt; }
  if (position === 'left') { x = marginPt; y = pageHeight / 2 - height / 2; }
  if (position === 'right') { x = pageWidth - marginPt - width; y = pageHeight / 2 - height / 2; }

  return { x, y, width, height };
}
