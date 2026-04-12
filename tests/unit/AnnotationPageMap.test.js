import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  remapAnnotationPageNumber,
  remapAnnotationsForStructureChange,
} from '../../src/js/core/AnnotationPageMap.js';

describe('AnnotationPageMap', () => {
  it('drops annotations on deleted pages and shifts following pages up', () => {
    const result = remapAnnotationsForStructureChange([
      { id: 'a', pageNumber: 2 },
      { id: 'b', pageNumber: 4 },
    ], {
      type: 'delete-page',
      pageNumber: 2,
    });

    assert.deepEqual(result, [
      { id: 'b', pageNumber: 3 },
    ]);
  });

  it('remaps annotations for single-page reorder events', () => {
    assert.equal(remapAnnotationPageNumber(2, {
      type: 'reorder-page',
      fromPage: 2,
      toPage: 5,
    }), 5);
    assert.equal(remapAnnotationPageNumber(4, {
      type: 'reorder-page',
      fromPage: 2,
      toPage: 5,
    }), 3);
  });

  it('remaps annotations for batch page reorder events', () => {
    const result = remapAnnotationsForStructureChange([
      { id: 'move-a', pageNumber: 2 },
      { id: 'move-b', pageNumber: 4 },
      { id: 'stay-a', pageNumber: 3 },
      { id: 'stay-b', pageNumber: 5 },
    ], {
      type: 'reorder-pages',
      fromPages: [2, 4],
      toPage: 5,
    });

    assert.deepEqual(result, [
      { id: 'move-a', pageNumber: 4 },
      { id: 'move-b', pageNumber: 5 },
      { id: 'stay-a', pageNumber: 2 },
      { id: 'stay-b', pageNumber: 3 },
    ]);
  });

  it('supports prepending a moved batch to the front of the document', () => {
    assert.equal(remapAnnotationPageNumber(1, {
      type: 'reorder-pages',
      fromPages: [3, 4],
      toPage: 0,
    }), 3);
    assert.equal(remapAnnotationPageNumber(4, {
      type: 'reorder-pages',
      fromPages: [3, 4],
      toPage: 0,
    }), 2);
  });
});
