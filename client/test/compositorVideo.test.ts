import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCompositorVideoDrawPlan,
  getCompositorVideoObjectFit,
  isCompositorVideoHorizontallyMirrored,
} from '../src/utils/compositorVideo.ts';

describe('compositor video drawing', () => {
  it('letterboxes contained screen shares without stretching them', () => {
    assert.deepEqual(
      getCompositorVideoDrawPlan(1280, 1024, 1920, 1080, 'contain'),
      {
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 1280,
        sourceHeight: 1024,
        destX: 285,
        destY: 0,
        destWidth: 1350,
        destHeight: 1080,
      }
    );
  });

  it('crops cover video sources to fill participant camera tiles', () => {
    assert.deepEqual(
      getCompositorVideoDrawPlan(1920, 1080, 800, 800, 'cover'),
      {
        sourceX: 420,
        sourceY: 0,
        sourceWidth: 1080,
        sourceHeight: 1080,
        destX: 0,
        destY: 0,
        destWidth: 800,
        destHeight: 800,
      }
    );
  });

  it('falls back to fill when no supported object-fit value is present', () => {
    assert.deepEqual(
      getCompositorVideoDrawPlan(1920, 1080, 640, 360, 'fill'),
      {
        sourceX: 0,
        sourceY: 0,
        sourceWidth: 1920,
        sourceHeight: 1080,
        destX: 0,
        destY: 0,
        destWidth: 640,
        destHeight: 360,
      }
    );
  });

  it('rejects unusable dimensions', () => {
    assert.equal(getCompositorVideoDrawPlan(0, 1080, 640, 360, 'contain'), null);
    assert.equal(getCompositorVideoDrawPlan(1920, 1080, 0, 360, 'cover'), null);
  });

  it('reads inline fit and mirror flags from DOM video styles', () => {
    const video = {
      style: {
        objectFit: 'contain',
        transform: 'scaleX(-1)',
      },
    } as unknown as HTMLVideoElement;

    assert.equal(getCompositorVideoObjectFit(video), 'contain');
    assert.equal(isCompositorVideoHorizontallyMirrored(video), true);
  });
});
