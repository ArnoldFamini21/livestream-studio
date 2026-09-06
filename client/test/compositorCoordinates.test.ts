import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCompositorCoordinateScales } from '../src/utils/compositorCoordinates.ts';
import { getCompositorVideoDrawPlan } from '../src/utils/compositorVideo.ts';
import { getLogoCanvasRect } from '../src/utils/logoPosition.ts';

describe('compositor coordinates for a scaled stage', () => {
  const logical = { width: 960, height: 540 };

  it('keeps camera cropping and stage position identical as the preview changes size', () => {
    const plans = [320, 720, 960, 1280].map((width) => {
      const previewScale = width / logical.width;
      const scales = getCompositorCoordinateScales({ width, height: width * 9 / 16 }, logical)!;
      // One camera occupies the same logical region in each preview.
      const tile = { x: 8 * previewScale, y: 8 * previewScale, width: 944 * previewScale, height: 524 * previewScale };
      return {
        x: Math.round(tile.x * scales.displayScaleX),
        y: Math.round(tile.y * scales.displayScaleY),
        plan: getCompositorVideoDrawPlan(1920, 1080,
          Math.round(tile.width * scales.displayScaleX), Math.round(tile.height * scales.displayScaleY), 'cover'),
      };
    });
    plans.forEach((plan) => assert.deepEqual(plan, plans[0]));
  });

  it('keeps logo size, margins, and corner radius independent of preview scaling', () => {
    const shapes = [320, 720, 960, 1280].map((width) => {
      const scales = getCompositorCoordinateScales({ width, height: width * 9 / 16 }, logical)!;
      return {
        logo: getLogoCanvasRect({ sourceWidth: 400, sourceHeight: 120, placement: 'top-right', size: 'medium',
          scaleX: scales.logicalScaleX, scaleY: scales.logicalScaleY }),
        mediaRadius: 16 * Math.min(scales.logicalScaleX, scales.logicalScaleY),
      };
    });
    shapes.forEach((shape) => assert.deepEqual(shape, shapes[0]));
    assert.equal(shapes[0].mediaRadius, 32);
    assert.equal(shapes[0].logo?.width, 256);
  });

  it('skips unmeasurable or invalid stages without dividing by zero', () => {
    assert.equal(getCompositorCoordinateScales({ width: 0, height: 0 }, logical), null);
    assert.equal(getCompositorCoordinateScales(logical, { width: 0, height: 540 }), null);
    assert.equal(getCompositorCoordinateScales({ width: NaN, height: 540 }, logical), null);
    assert.equal(getCompositorCoordinateScales(logical, logical, { width: Infinity, height: 1080 }), null);
  });
});
