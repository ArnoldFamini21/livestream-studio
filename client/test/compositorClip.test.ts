import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCompositorClipShapes, resolveCssRadius } from '../src/utils/compositorClip.ts';

describe('compositor clip shapes', () => {
  it('resolves pixel, percentage, and elliptical radii against the logical box', () => {
    assert.equal(resolveCssRadius('10px', 240, 135), 10);
    assert.equal(resolveCssRadius('50%', 120, 120), 60, 'circular camera mask');
    assert.equal(resolveCssRadius('8px 4px', 200, 100), 8);
    assert.equal(resolveCssRadius('0px', 200, 100), 0);
    assert.equal(resolveCssRadius('', 200, 100), 0);
    assert.equal(resolveCssRadius('400px', 200, 100), 50, 'never larger than half the short side');
  });

  it('intersects every rounded container before drawing', () => {
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push('begin'),
      roundRect: (x: number, y: number, w: number, h: number, r: number) => calls.push(`round ${x},${y},${w},${h},${r}`),
      clip: () => calls.push('clip'),
    } as unknown as CanvasRenderingContext2D;
    applyCompositorClipShapes(ctx, [
      { x: 0, y: 0, width: 400, height: 225, radius: 20 },
      { x: 100, y: 10, width: 200, height: 200, radius: 150 },
    ]);
    assert.deepEqual(calls, [
      'begin', 'round 0,0,400,225,20', 'clip',
      'begin', 'round 100,10,200,200,100', 'clip',
    ]);
  });
});
