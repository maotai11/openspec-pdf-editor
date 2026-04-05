export function isImageLikeFile(file) {
  if (!file) return false;
  return String(file.type ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(String(file.name ?? ''));
}

export async function readImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`無法讀取圖片尺寸：${file.name ?? 'image'}`));
    };

    image.src = url;
  });
}

export async function embedImageFile(pdfDoc, file) {
  const ext = (String(file.name ?? '').split('.').pop() ?? '').toLowerCase();
  const buf = await file.arrayBuffer();

  if (file.type === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') {
    return pdfDoc.embedJpg(buf);
  }
  if (file.type === 'image/png' || ext === 'png') {
    return pdfDoc.embedPng(buf);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('無法轉換圖片格式'));
          return;
        }
        blob.arrayBuffer().then((bytes) => resolve(pdfDoc.embedPng(bytes))).catch(reject);
      }, 'image/png');
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`無法讀取圖片：${file.name ?? 'image'}`));
    };

    image.src = objectUrl;
  });
}
