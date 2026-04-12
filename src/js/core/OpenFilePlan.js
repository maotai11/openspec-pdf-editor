export function planOpenFiles(files = [], { isImageFile }) {
  const allFiles = Array.from(files ?? []).filter(Boolean);
  const imageFiles = allFiles.filter((file) => isImageFile(file));
  const pdfFiles = allFiles.filter((file) => !isImageFile(file));

  if (imageFiles.length > 0 && pdfFiles.length === 0) {
    return { mode: 'images-only', imageFiles, pdfFiles };
  }

  if (pdfFiles.length > 0 && imageFiles.length === 0) {
    return {
      mode: pdfFiles.length === 1 ? 'single-pdf' : 'multi-pdf',
      imageFiles,
      pdfFiles,
    };
  }

  if (pdfFiles.length > 0 && imageFiles.length > 0) {
    return { mode: 'mixed', imageFiles, pdfFiles };
  }

  return { mode: 'empty', imageFiles, pdfFiles };
}
