export function normalizeRotation(rotation = 0) {
  const normalized = Number(rotation) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function getDisplayPageSize(pageWidthPt, pageHeightPt, rotation = 0) {
  const normalized = normalizeRotation(rotation);
  if (normalized === 90 || normalized === 270) {
    return {
      width: pageHeightPt,
      height: pageWidthPt,
    };
  }
  return {
    width: pageWidthPt,
    height: pageHeightPt,
  };
}

export function getVisualViewport({
  pageWidthPt,
  pageHeightPt,
  originXPt = 0,
  originYPt = 0,
  rotation = 0,
}) {
  const normalizedRotation = normalizeRotation(rotation);
  const displaySize = getDisplayPageSize(pageWidthPt, pageHeightPt, normalizedRotation);
  return {
    pageWidthPt,
    pageHeightPt,
    originXPt,
    originYPt,
    rotation: normalizedRotation,
    displayWidthPt: displaySize.width,
    displayHeightPt: displaySize.height,
  };
}

export function visualLayoutPointToPdf(point, viewport) {
  const visualViewport = getVisualViewport(viewport);
  return screenPointToPdf({
    x: point.x,
    y: visualViewport.displayHeightPt - point.y,
  }, {
    ...viewport,
    screenWidth: visualViewport.displayWidthPt,
    screenHeight: visualViewport.displayHeightPt,
  });
}

export function visualEdgeInsetsToPdfEdgeInsets(insets, viewport) {
  const top = Math.max(0, Number(insets?.top) || 0);
  const right = Math.max(0, Number(insets?.right) || 0);
  const bottom = Math.max(0, Number(insets?.bottom) || 0);
  const left = Math.max(0, Number(insets?.left) || 0);
  const normalized = normalizeRotation(viewport?.rotation ?? 0);

  if (normalized === 90) {
    return {
      top: right,
      right: bottom,
      bottom: left,
      left: top,
    };
  }

  if (normalized === 180) {
    return {
      top: bottom,
      right: left,
      bottom: top,
      left: right,
    };
  }

  if (normalized === 270) {
    return {
      top: left,
      right: top,
      bottom: right,
      left: bottom,
    };
  }

  return { top, right, bottom, left };
}

export function pdfPointToScreen(point, viewport) {
  const {
    pageWidthPt,
    pageHeightPt,
    originXPt = 0,
    originYPt = 0,
    rotation = 0,
    screenWidth,
    screenHeight,
  } = viewport;

  if (!screenWidth || !screenHeight) return { x: point.x, y: point.y };

  const normalized = normalizeRotation(rotation);
  const displaySize = getDisplayPageSize(pageWidthPt, pageHeightPt, normalized);

  const localX = point.x - originXPt;
  const localY = point.y - originYPt;
  let rotatedX = localX;
  let rotatedY = localY;

  if (normalized === 90) {
    rotatedX = localY;
    rotatedY = pageWidthPt - localX;
  } else if (normalized === 180) {
    rotatedX = pageWidthPt - localX;
    rotatedY = pageHeightPt - localY;
  } else if (normalized === 270) {
    rotatedX = pageHeightPt - localY;
    rotatedY = localX;
  }

  return {
    x: (rotatedX / displaySize.width) * screenWidth,
    y: screenHeight - ((rotatedY / displaySize.height) * screenHeight),
  };
}

export function screenPointToPdf(point, viewport) {
  const {
    pageWidthPt,
    pageHeightPt,
    originXPt = 0,
    originYPt = 0,
    rotation = 0,
    screenWidth,
    screenHeight,
  } = viewport;

  if (!screenWidth || !screenHeight) return { x: point.x, y: point.y };

  const normalized = normalizeRotation(rotation);
  const displaySize = getDisplayPageSize(pageWidthPt, pageHeightPt, normalized);
  const rotatedX = (point.x / screenWidth) * displaySize.width;
  const rotatedY = ((screenHeight - point.y) / screenHeight) * displaySize.height;

  if (normalized === 90) {
    return {
      x: originXPt + pageWidthPt - rotatedY,
      y: originYPt + rotatedX,
    };
  }

  if (normalized === 180) {
    return {
      x: originXPt + pageWidthPt - rotatedX,
      y: originYPt + pageHeightPt - rotatedY,
    };
  }

  if (normalized === 270) {
    return {
      x: originXPt + rotatedY,
      y: originYPt + pageHeightPt - rotatedX,
    };
  }

  return {
    x: originXPt + rotatedX,
    y: originYPt + rotatedY,
  };
}

export function pdfRectToScreenRect(rect, viewport) {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ].map((point) => pdfPointToScreen(point, viewport));

  const xValues = corners.map((corner) => corner.x);
  const yValues = corners.map((corner) => corner.y);
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

export function screenRectToPdfRect(rect, viewport) {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ].map((point) => screenPointToPdf(point, viewport));

  const xValues = corners.map((corner) => corner.x);
  const yValues = corners.map((corner) => corner.y);
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
