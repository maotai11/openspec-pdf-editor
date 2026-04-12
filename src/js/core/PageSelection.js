export function resolveTargetPageNumbers(pageCount, options = {}, fallbackCurrentPage = 1) {
  const safePageCount = Math.max(0, Math.trunc(Number(pageCount) || 0));
  if (safePageCount < 1) return [];

  if (Array.isArray(options.pages)) {
    const explicitPages = [...new Set(options.pages
      .map((pageNumber) => Math.trunc(Number(pageNumber)))
      .filter((pageNumber) => pageNumber >= 1 && pageNumber <= safePageCount))]
      .sort((left, right) => left - right);
    if (explicitPages.length > 0) return explicitPages;
    return [];
  }

  const fallbackPage = Math.min(Math.max(Math.trunc(Number(fallbackCurrentPage) || 1), 1), safePageCount);
  const normalizedFrom = Math.trunc(Number(options.fromPage));
  const fromPage = Number.isFinite(normalizedFrom) && normalizedFrom >= 1
    ? Math.min(normalizedFrom, safePageCount)
    : fallbackPage;
  const normalizedTo = Math.trunc(Number(options.toPage));
  const toPage = Number.isFinite(normalizedTo) && normalizedTo >= fromPage
    ? Math.min(normalizedTo, safePageCount)
    : fromPage;
  return Array.from({ length: toPage - fromPage + 1 }, (_, index) => fromPage + index);
}
