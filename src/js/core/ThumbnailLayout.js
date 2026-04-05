export function resolveThumbnailViewport({
  pageWidth,
  pageHeight,
  maxWidth,
  maxHeight,
}) {
  const safePageWidth = Math.max(1, Number(pageWidth) || 1);
  const safePageHeight = Math.max(1, Number(pageHeight) || 1);
  const safeMaxWidth = Math.max(1, Number(maxWidth) || 1);
  const safeMaxHeight = Math.max(1, Number(maxHeight) || 1);
  const scale = Math.min(safeMaxWidth / safePageWidth, safeMaxHeight / safePageHeight);

  return {
    scale,
    width: Math.max(1, Math.round(safePageWidth * scale)),
    height: Math.max(1, Math.round(safePageHeight * scale)),
  };
}
