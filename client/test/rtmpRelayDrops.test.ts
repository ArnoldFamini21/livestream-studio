import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateDroppedFrames } from '../src/utils/rtmpRelayDrops.ts';

describe('RTMP relay dropped frame estimation', () => {
  it('estimates dropped frames from missed recorder chunks', () => {
    assert.equal(estimateDroppedFrames(30, 1000), 30);
    assert.equal(estimateDroppedFrames(30, 1000, 2), 60);
    assert.equal(estimateDroppedFrames(24, 500), 12);
  });

  it('ignores invalid inputs instead of inflating health counters', () => {
    assert.equal(estimateDroppedFrames(0, 1000), 0);
    assert.equal(estimateDroppedFrames(30, 0), 0);
    assert.equal(estimateDroppedFrames(Number.NaN, 1000), 0);
    assert.equal(estimateDroppedFrames(30, 1000, -1), 0);
  });
});
