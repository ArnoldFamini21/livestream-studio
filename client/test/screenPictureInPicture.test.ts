import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getContainedVideoRect,
  getCoverSourceRect,
  getScreenPictureInPictureCanvasSize,
  getScreenPictureInPictureInsetRect,
} from '../src/utils/screenPictureInPicture.ts';

describe('screen picture-in-picture recording geometry', () => {
  it('caps large screen recordings while preserving aspect ratio', () => {
    assert.deepEqual(
      getScreenPictureInPictureCanvasSize({ width: 3840, height: 2160 }),
      { width: 1920, height: 1080 }
    );
    assert.deepEqual(
      getScreenPictureInPictureCanvasSize({ width: 1080, height: 1920 }),
      { width: 1080, height: 1920 }
    );
  });

  it('falls back to 1080p landscape when screen settings are missing', () => {
    assert.deepEqual(getScreenPictureInPictureCanvasSize(null), { width: 1920, height: 1080 });
    assert.deepEqual(getScreenPictureInPictureCanvasSize({}), { width: 1920, height: 1080 });
  });

  it('contains screen video without cropping', () => {
    assert.deepEqual(
      getContainedVideoRect({ width: 1280, height: 720 }, { width: 1080, height: 1920 }),
      { x: 0, y: 656, width: 1080, height: 608 }
    );
  });

  it('crops camera video to cover the inset', () => {
    const source = getCoverSourceRect({ width: 1920, height: 1080 }, { width: 320, height: 320 });

    assert.equal(source.x, 420);
    assert.equal(source.y, 0);
    assert.equal(source.width, 1080);
    assert.equal(source.height, 1080);
  });

  it('keeps the camera inset inside the bottom-right canvas bounds', () => {
    const rect = getScreenPictureInPictureInsetRect({ width: 1920, height: 1080 });

    assert.deepEqual(rect, { x: 1421, y: 783, width: 461, height: 259 });
    assert.equal(rect.x + rect.width < 1920, true);
    assert.equal(rect.y + rect.height < 1080, true);
  });
});
