import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFallbackBackgroundFilter,
  buildReplacementBackgroundFilter,
  getExpandedDrawRect,
  getSegmentationConfidence,
  getVirtualBackgroundRefinementSettings,
  refineSegmentationMaskAlpha,
  smoothStep,
} from '../src/utils/virtualBackgroundRefinement.ts';

describe('virtual background refinement', () => {
  it('reads confidence from alpha masks and opaque grayscale masks', () => {
    assert.equal(getSegmentationConfidence(0, 0, 0, 255), 0);
    assert.equal(getSegmentationConfidence(255, 255, 255, 255), 1);
    assert.equal(getSegmentationConfidence(0, 0, 0, 128).toFixed(2), '0.50');
  });

  it('smooths confidence into a bounded alpha ramp', () => {
    assert.equal(smoothStep(0.2, 0.8, 0), 0);
    assert.equal(smoothStep(0.2, 0.8, 1), 1);
    assert.equal(smoothStep(0.2, 0.8, 0.5).toFixed(2), '0.50');

    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ]);
    refineSegmentationMaskAlpha(pixels, { lowCutoff: 0.2, highCutoff: 0.8, gamma: 1 });

    assert.equal(pixels[3], 0);
    assert.ok(pixels[7] > 80 && pixels[7] < 180);
    assert.equal(pixels[11], 255);
    assert.deepEqual([...pixels.slice(0, 3)], [255, 255, 255]);
  });

  it('scales edge and background refinement by output size', () => {
    const small = getVirtualBackgroundRefinementSettings(640, 360);
    const large = getVirtualBackgroundRefinementSettings(1920, 1080);

    assert.ok(small.edgeBlurPx >= 2.5);
    assert.ok(large.edgeBlurPx > small.edgeBlurPx);
    assert.ok(large.replacementBackgroundBlurPx >= small.replacementBackgroundBlurPx);
  });

  it('builds stable canvas filters and bleed rectangles', () => {
    const settings = getVirtualBackgroundRefinementSettings(1280, 720);

    assert.match(buildReplacementBackgroundFilter(settings), /blur\(1/);
    assert.match(buildReplacementBackgroundFilter(settings), /brightness\(0\.92\)/);
    assert.match(buildFallbackBackgroundFilter(16, settings), /blur\(16px\)/);
    assert.deepEqual(getExpandedDrawRect(1280, 720, 2.2), {
      x: -3,
      y: -3,
      width: 1286,
      height: 726,
    });
  });
});
