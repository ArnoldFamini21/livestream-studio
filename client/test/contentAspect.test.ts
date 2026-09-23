import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getIntrinsicAspect, shouldUpdateContentAspect } from '../src/utils/contentAspect.ts';

describe('shared content aspect', () => {
  it('reads images, videos, and screens once they report their size', () => {
    assert.equal(getIntrinsicAspect({ naturalWidth: 1280, naturalHeight: 720 }), 16 / 9);
    assert.equal(getIntrinsicAspect({ videoWidth: 1440, videoHeight: 1080, naturalWidth: 0 }), 4 / 3);
    assert.equal(getIntrinsicAspect({ videoWidth: 0, videoHeight: 0 }), null, 'metadata not loaded yet');
    assert.equal(getIntrinsicAspect(null), null);
    assert.equal(getIntrinsicAspect({ naturalWidth: Number.NaN, naturalHeight: 10 }), null);
  });

  it('ignores sub-percent jitter but follows real shape changes', () => {
    assert.equal(shouldUpdateContentAspect(null, 16 / 9), true);
    assert.equal(shouldUpdateContentAspect(16 / 9, 1366 / 768), false);
    assert.equal(shouldUpdateContentAspect(16 / 9, 4 / 3), true);
    assert.equal(shouldUpdateContentAspect(16 / 9, null), false);
  });
});
