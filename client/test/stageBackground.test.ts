import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeBackgroundColor, getPersistableStageBackground, getStageBackgroundStyle } from '../src/utils/stageBackground.ts';
import { fitCanvasBackground } from '../src/utils/canvasBackgroundImage.ts';

describe('canvas backgrounds', () => {
  it('accepts explicit RGB hex colors and normalizes short notation', () => {
    assert.equal(normalizeBackgroundColor(' #AbC '), '#aabbcc');
    assert.equal(normalizeBackgroundColor('#123456'), '#123456');
    for (const invalid of ['', '#', '#12', '#1234', '#12345z', 'red', 'url(image)', '#12345678']) assert.equal(normalizeBackgroundColor(invalid), null);
  });
  it('preserves self-contained images across reloads and excludes session object URLs', () => {
    const image = { type: 'image' as const, value: 'data:image/webp;base64,abc' };
    assert.deepEqual(getPersistableStageBackground(image), image);
    assert.deepEqual(getPersistableStageBackground({ type: 'image', value: 'blob:session' }), { type: 'none', value: '' });
    assert.deepEqual(getPersistableStageBackground({ type: 'video', value: 'blob:session' }), { type: 'none', value: '' });
  });
  it('uses cover placement for image preview and passes through colors and gradients', () => {
    assert.equal(getStageBackgroundStyle({ type: 'image', value: 'data:image/webp;base64,abc' }).backgroundSize, 'cover');
    assert.deepEqual(getStageBackgroundStyle({ type: 'color', value: '#123456' }), { background: '#123456' });
    assert.deepEqual(getStageBackgroundStyle({ type: 'none', value: '' }), {});
  });
  it('bounds large raster dimensions without stretching or upscaling', () => {
    assert.deepEqual(fitCanvasBackground(3840, 2160), { width: 1920, height: 1080 });
    assert.deepEqual(fitCanvasBackground(2000, 4000), { width: 960, height: 1920 });
    assert.deepEqual(fitCanvasBackground(320, 180), { width: 320, height: 180 });
    assert.throws(() => fitCanvasBackground(0, 400));
    assert.throws(() => fitCanvasBackground(Infinity, 400));
  });
});
