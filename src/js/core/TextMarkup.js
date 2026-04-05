function pointBounds(points = []) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    bottom: Math.min(...ys),
    top: Math.max(...ys),
  };
}

function rectsIntersect(left, right) {
  const leftRect = {
    x: Number(left.x ?? left.left) || 0,
    y: Number(left.y ?? left.bottom) || 0,
    width: Math.max(0, Number(left.width) || 0),
    height: Math.max(0, Number(left.height) || 0),
  };
  const rightRect = {
    x: Number(right.x ?? right.left) || 0,
    y: Number(right.y ?? right.bottom) || 0,
    width: Math.max(0, Number(right.width) || 0),
    height: Math.max(0, Number(right.height) || 0),
  };
  return (
    leftRect.x < rightRect.x + rightRect.width &&
    leftRect.x + leftRect.width > rightRect.x &&
    leftRect.y < rightRect.y + rightRect.height &&
    leftRect.y + leftRect.height > rightRect.y
  );
}

export function normalizeTextRun(item, style = {}) {
  const transform = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
  const [a, b, c, d, e, f] = transform.map((value) => Number(value) || 0);
  const width = Math.max(0, Number(item?.width) || 0);
  const xAxisLength = Math.hypot(a, b) || 1;
  const yAxisLength = Math.hypot(c, d);
  const fontHeight = Math.max(Number(item?.height) || 0, yAxisLength || xAxisLength, 1);

  const ux = { x: a / xAxisLength, y: b / xAxisLength };
  const uy = yAxisLength > 0
    ? { x: c / yAxisLength, y: d / yAxisLength }
    : { x: -ux.y, y: ux.x };

  const ascent = Number.isFinite(style?.ascent) ? style.ascent : 0.82;
  const descent = Number.isFinite(style?.descent) ? style.descent : -0.18;
  const baselineStart = { x: e, y: f };
  const baselineEnd = {
    x: e + (ux.x * width),
    y: f + (ux.y * width),
  };
  const bottomOffset = fontHeight * Math.min(descent, -0.1);
  const topOffset = fontHeight * Math.max(ascent, 0.6);

  const bottomStart = {
    x: baselineStart.x + (uy.x * bottomOffset),
    y: baselineStart.y + (uy.y * bottomOffset),
  };
  const bottomEnd = {
    x: baselineEnd.x + (uy.x * bottomOffset),
    y: baselineEnd.y + (uy.y * bottomOffset),
  };
  const topStart = {
    x: baselineStart.x + (uy.x * topOffset),
    y: baselineStart.y + (uy.y * topOffset),
  };
  const topEnd = {
    x: baselineEnd.x + (uy.x * topOffset),
    y: baselineEnd.y + (uy.y * topOffset),
  };
  const bounds = pointBounds([bottomStart, bottomEnd, topStart, topEnd]);

  return {
    text: String(item?.str ?? ''),
    left: bounds.left,
    right: bounds.right,
    bottom: bounds.bottom,
    top: bounds.top,
    x: bounds.left,
    y: bounds.bottom,
    width: Math.max(0, bounds.right - bounds.left),
    height: Math.max(0, bounds.top - bounds.bottom),
    baselineStart,
    baselineEnd,
    fontHeight,
    centerY: (bounds.bottom + bounds.top) / 2,
  };
}

export function groupTextRunsIntoLines(textRuns = []) {
  const sortedRuns = [...textRuns]
    .filter((run) => run.width > 0 && run.height > 0)
    .sort((left, right) => {
      if (Math.abs(right.centerY - left.centerY) > 0.5) return right.centerY - left.centerY;
      return left.left - right.left;
    });

  const lines = [];
  for (const run of sortedRuns) {
    const threshold = Math.max(4, run.height * 0.45);
    const targetLine = lines.find((line) => Math.abs(line.centerY - run.centerY) <= threshold);
    if (targetLine) {
      targetLine.runs.push(run);
      targetLine.centerY = (targetLine.centerY + run.centerY) / 2;
      continue;
    }
    lines.push({
      centerY: run.centerY,
      runs: [run],
    });
  }

  return lines.map((line) => ({
    ...line,
    runs: [...line.runs].sort((left, right) => left.left - right.left),
  }));
}

export function resolveTextMarkupSelection(textRuns = [], selectionRect, kind = 'highlight') {
  if (!selectionRect?.width || !selectionRect?.height) return [];
  const overlappingRuns = textRuns.filter((run) => rectsIntersect(run, selectionRect));
  if (overlappingRuns.length === 0) return [];

  return groupTextRunsIntoLines(overlappingRuns).map((line) => {
    const left = Math.min(...line.runs.map((run) => run.left));
    const right = Math.max(...line.runs.map((run) => run.right));
    const bottom = Math.min(...line.runs.map((run) => run.bottom));
    const top = Math.max(...line.runs.map((run) => run.top));
    const height = Math.max(1, top - bottom);

    if (kind === 'underline') {
      const y = bottom + Math.max(0.75, height * 0.12);
      return {
        kind,
        geometry: {
          x1: left,
          y1: y,
          x2: right,
          y2: y,
        },
        strokeWidth: Math.max(1, height * 0.08),
      };
    }

    return {
      kind,
      geometry: {
        x: left,
        y: bottom,
        width: Math.max(1, right - left),
        height,
      },
    };
  });
}
