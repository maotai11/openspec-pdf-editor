function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function cleanNumber(value) {
  if (Math.abs(value) < 1e-9) return 0;
  return Number(value.toFixed(4));
}

export function normalizeAnnotationRotation(rotation = 0) {
  const normalized = Number(rotation) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function getPdfRotationForScreenRotation(rotation = 0) {
  return normalizeAnnotationRotation(-rotation);
}

export function clampPointGeometry(point, pageWidth, pageHeight, originX = 0, originY = 0, paddingX = 0, paddingY = paddingX) {
  const minX = originX + paddingX;
  const maxX = originX + Math.max(pageWidth - paddingX, paddingX);
  const minY = originY + paddingY;
  const maxY = originY + Math.max(pageHeight - paddingY, paddingY);

  return {
    x: clamp(Number(point?.x) || 0, minX, maxX),
    y: clamp(Number(point?.y) || 0, minY, maxY),
  };
}

export function normalizeRectGeometry(geometry, pageWidth, pageHeight, originX = 0, originY = 0) {
  const maxX = originX + pageWidth;
  const maxY = originY + pageHeight;
  const x1 = clamp(Number(geometry?.x) || 0, originX, maxX);
  const y1 = clamp(Number(geometry?.y) || 0, originY, maxY);
  const x2 = clamp((Number(geometry?.x) || 0) + (Number(geometry?.width) || 0), originX, maxX);
  const y2 = clamp((Number(geometry?.y) || 0) + (Number(geometry?.height) || 0), originY, maxY);

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.max(0, Math.abs(x2 - x1)),
    height: Math.max(0, Math.abs(y2 - y1)),
  };
}

export function normalizeLineGeometry(geometry, pageWidth, pageHeight, originX = 0, originY = 0) {
  const maxX = originX + pageWidth;
  const maxY = originY + pageHeight;
  return {
    x1: clamp(Number(geometry?.x1) || 0, originX, maxX),
    y1: clamp(Number(geometry?.y1) || 0, originY, maxY),
    x2: clamp(Number(geometry?.x2) || 0, originX, maxX),
    y2: clamp(Number(geometry?.y2) || 0, originY, maxY),
  };
}

export function parsePathData(pathData = '') {
  const points = [];
  const matcher = /([ML])\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g;
  let match;

  while ((match = matcher.exec(pathData)) !== null) {
    points.push({
      command: match[1],
      x: Number(match[2]),
      y: Number(match[3]),
    });
  }

  return points;
}

export function rotatePoint(point, center, rotation = 0) {
  const normalized = normalizeAnnotationRotation(rotation);
  if (normalized === 0) {
    return {
      x: cleanNumber(Number(point?.x) || 0),
      y: cleanNumber(Number(point?.y) || 0),
    };
  }

  const radians = (normalized * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = (Number(point?.x) || 0) - (Number(center?.x) || 0);
  const dy = (Number(point?.y) || 0) - (Number(center?.y) || 0);

  return {
    x: cleanNumber((Number(center?.x) || 0) + (dx * cos) - (dy * sin)),
    y: cleanNumber((Number(center?.y) || 0) + (dx * sin) + (dy * cos)),
  };
}

export function getPathBounds(pathData = '', pageWidth = Infinity, pageHeight = Infinity, originX = 0, originY = 0) {
  const commands = parsePathData(pathData);
  if (commands.length === 0) return null;

  const points = commands.map((command) => ({
    x: clamp(command.x, originX, originX + pageWidth),
    y: clamp(command.y, originY, originY + pageHeight),
  }));

  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function buildLineSegmentsFromPathData(pathData = '', pageWidth = Infinity, pageHeight = Infinity, originX = 0, originY = 0) {
  const commands = parsePathData(pathData);
  const segments = [];
  let previousPoint = null;

  for (const command of commands) {
    const currentPoint = {
      x: clamp(command.x, originX, originX + pageWidth),
      y: clamp(command.y, originY, originY + pageHeight),
    };

    if (command.command === 'M') {
      previousPoint = currentPoint;
      continue;
    }

    if (command.command === 'L' && previousPoint) {
      segments.push({
        start: previousPoint,
        end: currentPoint,
      });
    }

    previousPoint = currentPoint;
  }

  return segments;
}

export function buildRotatedLineSegmentsFromPathData(pathData = '', rotation = 0, pageWidth = Infinity, pageHeight = Infinity, originX = 0, originY = 0) {
  const segments = buildLineSegmentsFromPathData(pathData, pageWidth, pageHeight, originX, originY);
  const normalized = normalizeAnnotationRotation(rotation);
  if (normalized === 0 || segments.length === 0) return segments;

  const bounds = getPathBounds(pathData, pageWidth, pageHeight, originX, originY);
  if (!bounds) return segments;

  const center = {
    x: bounds.x + (bounds.width / 2),
    y: bounds.y + (bounds.height / 2),
  };

  return segments.map((segment) => ({
    start: rotatePoint(segment.start, center, normalized),
    end: rotatePoint(segment.end, center, normalized),
  }));
}

export function buildRectangleOutlineSegments(geometry, pageWidth, pageHeight, originX = 0, originY = 0, rotation = 0) {
  const rect = normalizeRectGeometry(geometry, pageWidth, pageHeight, originX, originY);
  if (!rect.width || !rect.height) return [];

  const center = {
    x: rect.x + (rect.width / 2),
    y: rect.y + (rect.height / 2),
  };
  const points = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((point) => rotatePoint(point, center, rotation));

  return points.map((point, index) => ({
    start: point,
    end: points[(index + 1) % points.length],
  }));
}

export function buildArrowHeadSegments(start, end, size = 12, spreadDeg = 26) {
  const dx = (Number(end?.x) || 0) - (Number(start?.x) || 0);
  const dy = (Number(end?.y) || 0) - (Number(start?.y) || 0);
  const length = Math.hypot(dx, dy);
  if (!length) return [];

  const angle = Math.atan2(dy, dx);
  const spread = (spreadDeg * Math.PI) / 180;
  const headLength = Math.min(size, length * 0.8);
  const left = {
    x: cleanNumber((Number(end?.x) || 0) - (headLength * Math.cos(angle - spread))),
    y: cleanNumber((Number(end?.y) || 0) - (headLength * Math.sin(angle - spread))),
  };
  const right = {
    x: cleanNumber((Number(end?.x) || 0) - (headLength * Math.cos(angle + spread))),
    y: cleanNumber((Number(end?.y) || 0) - (headLength * Math.sin(angle + spread))),
  };

  return [
    { start: end, end: left },
    { start: end, end: right },
  ];
}

export function buildTextLineLayouts({
  anchor,
  lineWidths = [],
  lineHeight = 14.4,
  rotation = 0,
  align = 'start',
  rotationCenter = anchor,
}) {
  const pdfRotation = getPdfRotationForScreenRotation(rotation);

  return lineWidths.map((width, index) => {
    let x = Number(anchor?.x) || 0;
    if (align === 'center') {
      x -= width / 2;
    } else if (align === 'end') {
      x -= width;
    }

    const y = (Number(anchor?.y) || 0) - (index * lineHeight);
    const origin = rotatePoint({ x, y }, rotationCenter, pdfRotation);

    return {
      x: origin.x,
      y: origin.y,
      rotation: pdfRotation,
      width,
    };
  });
}

export function buildStampExportLayout(rect, {
  rotation = 0,
  lineWidths = [],
  lineHeight = 14.4,
} = {}) {
  const center = {
    x: (Number(rect?.x) || 0) + ((Number(rect?.width) || 0) / 2),
    y: (Number(rect?.y) || 0) + ((Number(rect?.height) || 0) / 2),
  };
  const dividerStart = {
    x: (Number(rect?.x) || 0) + ((Number(rect?.width) || 0) * 0.18),
    y: (Number(rect?.y) || 0) + ((Number(rect?.height) || 0) * 0.44),
  };
  const dividerEnd = {
    x: (Number(rect?.x) || 0) + ((Number(rect?.width) || 0) * 0.82),
    y: (Number(rect?.y) || 0) + ((Number(rect?.height) || 0) * 0.44),
  };
  const textAnchor = {
    x: center.x,
    y: (Number(rect?.y) || 0) + ((Number(rect?.height) || 0) * 0.58),
  };
  const pdfRotation = getPdfRotationForScreenRotation(rotation);

  return {
    center,
    rotation: pdfRotation,
    divider: {
      start: rotatePoint(dividerStart, center, pdfRotation),
      end: rotatePoint(dividerEnd, center, pdfRotation),
    },
    textLines: buildTextLineLayouts({
      anchor: textAnchor,
      lineWidths,
      lineHeight,
      rotation,
      align: 'center',
      rotationCenter: center,
    }),
  };
}
