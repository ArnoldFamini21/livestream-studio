import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getScrubReleaseSeek } from '../src/audio/scrubRelease.ts';

describe('getScrubReleaseSeek', () => {
  it('does not seek when the pointer is released without the bar having moved (a tap on the thumb)', () => {
    assert.equal(getScrubReleaseSeek(null, 200), null);
  });

  it('seeks to where the bar was dragged or pressed', () => {
    assert.equal(getScrubReleaseSeek(500, 200), 100);
    assert.equal(getScrubReleaseSeek(1000, 200), 200);
    assert.equal(getScrubReleaseSeek(0, 200), 0);
  });

  it('seeks to the start of an unknown length rather than guessing', () => {
    assert.equal(getScrubReleaseSeek(500, 0), 0);
  });
});
