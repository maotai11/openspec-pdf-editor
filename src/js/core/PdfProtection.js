import { encryptPDF } from '@pdfsmaller/pdf-encrypt-lite';

export async function protectPdfBytes(inputBytes, {
  userPassword = '',
  ownerPassword = '',
} = {}) {
  const normalizedUserPassword = String(userPassword ?? '').trim();
  const normalizedOwnerPassword = String(ownerPassword ?? '').trim();

  if (!normalizedUserPassword) {
    return inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  }

  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  return encryptPDF(
    bytes,
    normalizedUserPassword,
    normalizedOwnerPassword || normalizedUserPassword,
  );
}

