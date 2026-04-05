const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;

export const PAGE_SIZE_PRESETS = {
  a4: { width: 595.28, height: 841.89, label: 'A4 直式' },
  letter: { width: 612, height: 792, label: 'Letter 直式' },
};

export function mmToPt(mm = 0) {
  return (Number(mm) || 0) * POINTS_PER_INCH / MM_PER_INCH;
}

export function pxToPt(px = 0, dpi = 150) {
  return (Number(px) || 0) * POINTS_PER_INCH / Math.max(1, Number(dpi) || 150);
}

export function resolveMarginPt({ preset = 'standard', customMm = 10 } = {}) {
  if (preset === 'none') return 0;
  if (preset === 'custom') return mmToPt(customMm);
  return mmToPt(10);
}

export function resolveTargetPageSize({
  pageSize = 'a4',
  imageWidthPx,
  imageHeightPx,
  dpi = 150,
  marginPt = 0,
}) {
  if (pageSize === 'original') {
    return {
      width: pxToPt(imageWidthPx, dpi) + marginPt * 2,
      height: pxToPt(imageHeightPx, dpi) + marginPt * 2,
    };
  }

  if (pageSize === 'fit-page') {
    const base = PAGE_SIZE_PRESETS.a4;
    const isLandscape = Number(imageWidthPx) > Number(imageHeightPx);
    return isLandscape
      ? { width: base.height, height: base.width }
      : { width: base.width, height: base.height };
  }

  return PAGE_SIZE_PRESETS[pageSize] ?? PAGE_SIZE_PRESETS.a4;
}

export function resolveImageDrawLayout({
  pageWidthPt,
  pageHeightPt,
  imageWidthPx,
  imageHeightPx,
  dpi = 150,
  marginPt = 0,
}) {
  const intrinsicWidthPt = pxToPt(imageWidthPx, dpi);
  const intrinsicHeightPt = pxToPt(imageHeightPx, dpi);
  const maxWidth = Math.max(1, pageWidthPt - marginPt * 2);
  const maxHeight = Math.max(1, pageHeightPt - marginPt * 2);
  const scale = Math.min(maxWidth / intrinsicWidthPt, maxHeight / intrinsicHeightPt, 1);
  const width = intrinsicWidthPt * scale;
  const height = intrinsicHeightPt * scale;

  return {
    x: (pageWidthPt - width) / 2,
    y: (pageHeightPt - height) / 2,
    width,
    height,
    scale,
  };
}
