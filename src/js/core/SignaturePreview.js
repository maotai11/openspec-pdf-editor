export async function resolveSignaturePreviewDataUrl({
  mode = 'typed',
  dataUrl = '',
  removeBackground = false,
  removeWhiteBackground,
} = {}) {
  const normalizedDataUrl = String(dataUrl ?? '').trim();
  if (!normalizedDataUrl) return '';

  const shouldRemoveBackground = removeBackground && (mode === 'drawn' || mode === 'image');
  if (!shouldRemoveBackground || typeof removeWhiteBackground !== 'function') {
    return normalizedDataUrl;
  }

  return removeWhiteBackground(normalizedDataUrl);
}

export default {
  resolveSignaturePreviewDataUrl,
};
