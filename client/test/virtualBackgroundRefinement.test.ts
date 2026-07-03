import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFallbackBackgroundFilter,
  buildReplacementBackgroundFilter,
  getExpandedDrawRect,
  getSegmentationConfidence,
  getVirtualBackgroundRefinementSettings,
  prepareSegmentationMaskAlpha,
  refineSegmentationMaskAlpha,
  shouldInvertSegmentationMask,
  smoothStep,
} from '../src/utils/virtualBackgroundRefinement.ts';

describe('virtual background refinement', () => {
  it('reads confidence from alpha masks and opaque grayscale masks', () => {
    assert.equal(getSegmentationConfidence(0, 0, 0, 255), 0);
    assert.equal(getSegmentationConfidence(255, 255, 255, 255), 1);
    assert.equal(getSegmentationConfidence(0, 0, 0, 128).toFixed(2), '0.50');
  });

  it('smooths confidence into a foreground-preserving alpha ramp', () => {
    assert.equal(smoothStep(0.2, 0.8, 0), 0);
    assert.equal(smoothStep(0.2, 0.8, 1), 1);
    assert.equal(smoothStep(0.2, 0.8, 0.5).toFixed(2), '0.50');

    const pixels = new Uint8ClampedArray([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ]);
    refineSegmentationMaskAlpha(pixels);

    assert.equal(pixels[3], 0);
    assert.ok(pixels[7] > 200);
    assert.equal(pixels[11], 255);
    assert.deepEqual([...pixels.slice(0, 3)], [255, 255, 255]);
  });

  it('detects inverted center-subject masks', () => {
    const width = 8;
    const height = 8;
    const inverted = new Uint8ClampedArray(width * height * 4);
    const normal = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const inCenter = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        const invertedValue = inCenter ? 0 : 255;
        const normalValue = inCenter ? 255 : 0;

        inverted[index] = invertedValue;
        inverted[index + 1] = invertedValue;
        inverted[index + 2] = invertedValue;
        inverted[index + 3] = 255;
        normal[index] = normalValue;
        normal[index + 1] = normalValue;
        normal[index + 2] = normalValue;
        normal[index + 3] = 255;
      }
    }

    assert.equal(shouldInvertSegmentationMask(inverted, width, height), true);
    assert.equal(shouldInvertSegmentationMask(normal, width, height), false);

    refineSegmentationMaskAlpha(inverted, {
      lowCutoff: 0.04,
      highCutoff: 0.65,
      gamma: 0.75,
      invert: true,
    });

    assert.equal(inverted[(3 * width + 3) * 4 + 3], 255);
    assert.equal(inverted[3], 0);
  });

  it('prepares inverted masks into solid subject alpha without hollow silhouettes', () => {
    const width = 8;
    const height = 8;
    const mask = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const inSubject = x >= 2 && x <= 5 && y >= 1 && y <= 6;
        const value = inSubject ? 0 : 255;
        mask[index] = value;
        mask[index + 1] = value;
        mask[index + 2] = value;
        mask[index + 3] = 255;
      }
    }

    const result = prepareSegmentationMaskAlpha(mask, width, height);
    const subjectAlpha = mask[(3 * width + 3) * 4 + 3];
    const backgroundAlpha = mask[3];

    assert.equal(result.inverted, true);
    assert.equal(subjectAlpha, 255);
    assert.equal(backgroundAlpha, 0);
  });

  it('scales edge and background refinement by output size', () => {
    const small = getVirtualBackgroundRefinementSettings(640, 360);
    const large = getVirtualBackgroundRefinementSettings(1920, 1080);

    assert.ok(small.edgeBlurPx >= 2.5);
    assert.ok(large.edgeBlurPx > small.edgeBlurPx);
    assert.ok(large.maskExpansionPx >= small.maskExpansionPx);
    assert.ok(small.edgeFeatherOpacity > 0 && small.edgeFeatherOpacity < 0.5);
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
