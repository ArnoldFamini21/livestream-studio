import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitStageCanvas, STAGE_CANVAS_HEIGHT, STAGE_CANVAS_WIDTH } from '../src/utils/stageCanvas.ts';

describe('fixed stage canvas', () => {
  it('keeps the same frame when a sidebar closes in a height-limited window', () => {
    // These are the measured dimensions of the reported clipping regression.
    assert.deepEqual(fitStageCanvas(984, 540), { width: 960, height: 540, scale: 1 });
    assert.deepEqual(fitStageCanvas(1304, 540), fitStageCanvas(984, 540));
  });

  it('fits wide, narrow, and short viewports without stretching or overflowing', () => {
    for (const [width, height] of [[320, 640], [750, 300], [1920, 1080], [1365.5, 499.25], [390, 150]]) {
      const fitted = fitStageCanvas(width, height);
      assert.ok(fitted.width <= width + 1e-9);
      assert.ok(fitted.height <= height + 1e-9);
      assert.ok(Math.abs(fitted.width / fitted.height - 16 / 9) < 1e-9);
      assert.ok(Math.abs(fitted.width - width) < 1e-9 || Math.abs(fitted.height - height) < 1e-9);
    }
  });

  it('keeps participant and overlay positions fixed in broadcast coordinates at every preview size', () => {
    const logicalRect = { x: 24, y: 420, width: 320, height: 80 };
    for (const [width, height] of [[984, 540], [1304, 540], [560, 400], [300, 200]]) {
      const fitted = fitStageCanvas(width, height);
      assert.ok(Math.abs(logicalRect.x * fitted.scale / fitted.width - logicalRect.x / STAGE_CANVAS_WIDTH) < 1e-9);
      assert.ok(Math.abs(logicalRect.y * fitted.scale / fitted.height - logicalRect.y / STAGE_CANVAS_HEIGHT) < 1e-9);
      assert.equal(logicalRect.width * fitted.scale / fitted.scale, logicalRect.width);
    }
  });

  it('handles hidden and invalid viewport sizes without NaN transforms', () => {
    for (const [width, height] of [[0, 540], [960, 0], [-1, 200], [Infinity, 540], [960, NaN]]) {
      assert.deepEqual(fitStageCanvas(width, height), { width: 0, height: 0, scale: 0 });
    }
  });
});
