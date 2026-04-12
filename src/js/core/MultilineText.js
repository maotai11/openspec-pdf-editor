export function normalizeMultilineText(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

export function splitPreservedLines(value = '') {
  const normalized = normalizeMultilineText(value);
  return normalized.length === 0 ? [] : normalized.split('\n');
}
