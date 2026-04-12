function normalizePageNumber(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePageList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizePageNumber(value, -1))
    .filter((value) => value >= 1))]
    .sort((left, right) => left - right);
}

function remapBatchReorderPageNumber(pageNumber, { fromPages = [], toPage = 0 } = {}) {
  const movingPages = normalizePageList(fromPages);
  if (movingPages.length === 0) return pageNumber;

  const targetPage = Math.max(0, normalizePageNumber(toPage, 0));
  const maxPage = Math.max(pageNumber, targetPage, ...movingPages);
  const movingSet = new Set(movingPages);
  const remainingPages = [];

  for (let currentPage = 1; currentPage <= maxPage; currentPage += 1) {
    if (!movingSet.has(currentPage)) remainingPages.push(currentPage);
  }

  const pagesBeforeTarget = movingPages.filter((currentPage) => currentPage <= targetPage).length;
  const insertIndex = Math.max(0, Math.min(remainingPages.length, targetPage - pagesBeforeTarget));
  const reorderedPages = [
    ...remainingPages.slice(0, insertIndex),
    ...movingPages,
    ...remainingPages.slice(insertIndex),
  ];

  const mappedPageNumber = reorderedPages.indexOf(pageNumber);
  return mappedPageNumber === -1 ? pageNumber : mappedPageNumber + 1;
}

export function remapAnnotationPageNumber(pageNumber, change = {}) {
  const currentPageNumber = normalizePageNumber(pageNumber, -1);
  if (currentPageNumber < 1) return null;

  switch (change.type) {
    case 'delete-page': {
      const deletedPage = normalizePageNumber(change.pageNumber, -1);
      if (deletedPage < 1) return currentPageNumber;
      if (currentPageNumber === deletedPage) return null;
      return currentPageNumber > deletedPage ? currentPageNumber - 1 : currentPageNumber;
    }
    case 'insert-page': {
      const afterPageNumber = normalizePageNumber(change.afterPageNumber, -1);
      if (afterPageNumber < 0) return currentPageNumber;
      return currentPageNumber > afterPageNumber ? currentPageNumber + 1 : currentPageNumber;
    }
    case 'reorder-page': {
      const fromPage = normalizePageNumber(change.fromPage, -1);
      const toPage = normalizePageNumber(change.toPage, -1);
      if (fromPage < 1 || toPage < 1 || fromPage === toPage) return currentPageNumber;
      if (currentPageNumber === fromPage) return toPage;
      if (fromPage < toPage && currentPageNumber > fromPage && currentPageNumber <= toPage) {
        return currentPageNumber - 1;
      }
      if (fromPage > toPage && currentPageNumber >= toPage && currentPageNumber < fromPage) {
        return currentPageNumber + 1;
      }
      return currentPageNumber;
    }
    case 'reorder-pages':
      return remapBatchReorderPageNumber(currentPageNumber, change);
    default:
      return currentPageNumber;
  }
}

export function remapAnnotationsForStructureChange(annotations = [], change = {}) {
  return Array.from(annotations ?? []).reduce((result, annotation) => {
    const nextPageNumber = remapAnnotationPageNumber(annotation?.pageNumber, change);
    if (nextPageNumber === null) return result;
    result.push({ ...annotation, pageNumber: nextPageNumber });
    return result;
  }, []);
}
