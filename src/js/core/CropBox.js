const DEFAULT_MIN_CROP_SIZE_PT = 36;

function clampInset(value, maxValue) {
  return Math.min(Math.max(0, Number(value) || 0), maxValue);
}

function resolveAxis(size, startInset, endInset, minSize) {
  const safeSize = Math.max(0, Number(size) || 0);
  const boundedMinSize = Math.max(1, Number(minSize) || DEFAULT_MIN_CROP_SIZE_PT);
  const safeMinSize = Math.min(boundedMinSize, safeSize || boundedMinSize);
  const maxTrim = Math.max(0, safeSize - safeMinSize);
  let start = clampInset(startInset, maxTrim);
  let end = clampInset(endInset, maxTrim);
  const requestedTrim = start + end;

  if (requestedTrim > maxTrim && requestedTrim > 0) {
    const scale = maxTrim / requestedTrim;
    start *= scale;
    end *= scale;
  }

  return {
    offset: start,
    extent: Math.max(safeMinSize, safeSize - start - end),
  };
}

export function resolveSafeCropBox(box = {}, insets = {}, minSize = DEFAULT_MIN_CROP_SIZE_PT) {
  const widthAxis = resolveAxis(box.width, insets.left, insets.right, minSize);
  const heightAxis = resolveAxis(box.height, insets.bottom, insets.top, minSize);

  return {
    x: (Number(box.x) || 0) + widthAxis.offset,
    y: (Number(box.y) || 0) + heightAxis.offset,
    width: widthAxis.extent,
    height: heightAxis.extent,
  };
}

export default {
  resolveSafeCropBox,
};
