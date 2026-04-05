import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = pathToFileURL(join(__dirname, '../../src/js/core/NaturalLanguage.js')).href;
const {
  parsePositionIntent,
  parsePageRangeIntent,
  parseStartNumberIntent,
  parseSplitRanges,
  parseWatermarkIntent,
  parseTimestampIntent,
} = await import(modulePath);

describe('NaturalLanguage', () => {
  it('parses page-number placement intent', () => {
    assert.equal(parsePositionIntent('請放到右下角'), 'bottom-right');
    assert.equal(parsePositionIntent('上方置中顯示'), 'top-center');
  });

  it('parses page range intent', () => {
    assert.deepEqual(parsePageRangeIntent('本頁', 12, 5), { mode: 'current', fromPage: 5, toPage: 5 });
    assert.deepEqual(parsePageRangeIntent('第 3 頁到第 8 頁', 12, 5), { mode: 'custom', fromPage: 3, toPage: 8 });
  });

  it('parses start number and timestamp intent', () => {
    assert.equal(parseStartNumberIntent('從 8 開始編號', 1), 8);
    assert.equal(parseTimestampIntent('附上製作時間', false), true);
    assert.equal(parseTimestampIntent('不要加時間', true), false);
  });

  it('parses split ranges from natural language input', () => {
    assert.deepEqual(parseSplitRanges('每頁一份', 3), [
      { from: 1, to: 1 },
      { from: 2, to: 2 },
      { from: 3, to: 3 },
    ]);
    assert.deepEqual(parseSplitRanges('1-3, 6, 8-10', 12), [
      { from: 1, to: 3 },
      { from: 6, to: 6 },
      { from: 8, to: 10 },
    ]);
  });

  it('parses watermark intent', () => {
    assert.deepEqual(parseWatermarkIntent('把「機密」放在右上角，旋轉 15 度，加上製作時間', 20, 3), {
      text: '機密',
      position: 'top-right',
      rotation: 15,
      opacity: 0.15,
      includeTimestamp: true,
      mode: 'all',
      fromPage: 1,
      toPage: 20,
    });
  });
});
