import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createActiveSpeakerTracker,
  selectLoudestAboveThreshold,
} from '../src/utils/activeSpeaker.ts';

describe('selectLoudestAboveThreshold', () => {
  it('returns the loudest participant above the threshold', () => {
    const best = selectLoudestAboveThreshold({ a: 0.2, b: 0.5, c: 0.1 }, 0.16);
    assert.deepEqual(best, { id: 'b', level: 0.5 });
  });

  it('returns null when nobody exceeds the threshold', () => {
    assert.equal(selectLoudestAboveThreshold({ a: 0.05, b: 0.1 }, 0.16), null);
  });

  it('ignores non-finite levels', () => {
    const best = selectLoudestAboveThreshold({ a: Number.NaN, b: 0.3 }, 0.16);
    assert.deepEqual(best, { id: 'b', level: 0.3 });
  });
});

describe('createActiveSpeakerTracker', () => {
  it('waits for the activation window before spotlighting a speaker', () => {
    const tracker = createActiveSpeakerTracker({ threshold: 0.16, activationMs: 400, holdMs: 2000 });
    assert.equal(tracker.update({ a: 0.5, b: 0.05 }, 0), null); // just started talking
    assert.equal(tracker.update({ a: 0.5, b: 0.05 }, 300), null); // not long enough
    assert.equal(tracker.update({ a: 0.5, b: 0.05 }, 450), 'a'); // crossed activation window
    assert.equal(tracker.getActiveId(), 'a');
  });

  it('returns null when the same speaker stays active', () => {
    const tracker = createActiveSpeakerTracker();
    tracker.update({ a: 0.5 }, 0);
    assert.equal(tracker.update({ a: 0.5 }, 500), 'a');
    assert.equal(tracker.update({ a: 0.6 }, 900), null);
  });

  it('resets the activation timer when a participant drops below the threshold', () => {
    const tracker = createActiveSpeakerTracker({ activationMs: 400 });
    tracker.update({ a: 0.5 }, 0);
    tracker.update({ a: 0.02 }, 200); // stopped talking, timer resets
    assert.equal(tracker.update({ a: 0.5 }, 500), null); // only 0ms into new window
    assert.equal(tracker.update({ a: 0.5 }, 950), 'a'); // 450ms continuous again
  });

  it('holds the current speaker for holdMs before switching to a quiet-margin rival', () => {
    const tracker = createActiveSpeakerTracker({ activationMs: 400, holdMs: 2000, interruptMargin: 0.12 });
    // a becomes active at t=450
    tracker.update({ a: 0.5, b: 0.0 }, 0);
    assert.equal(tracker.update({ a: 0.5, b: 0.0 }, 450), 'a');
    // b starts talking, but only slightly louder — should not interrupt within the hold window
    tracker.update({ a: 0.4, b: 0.45 }, 500);
    assert.equal(tracker.update({ a: 0.4, b: 0.45 }, 1000), null);
    // after the hold window, b (activated long enough) takes over
    assert.equal(tracker.update({ a: 0.4, b: 0.45 }, 2600), 'b');
  });

  it('lets a clearly louder rival interrupt within the hold window', () => {
    const tracker = createActiveSpeakerTracker({ activationMs: 400, holdMs: 2000, interruptMargin: 0.12 });
    tracker.update({ a: 0.5, b: 0.0 }, 0);
    assert.equal(tracker.update({ a: 0.5, b: 0.0 }, 450), 'a');
    // b is much louder than a (>0.12 margin) and has been talking long enough
    tracker.update({ a: 0.3, b: 0.8 }, 500);
    assert.equal(tracker.update({ a: 0.3, b: 0.8 }, 950), 'b');
  });

  it('immediately clears the active speaker when they leave the stage', () => {
    const tracker = createActiveSpeakerTracker({ activationMs: 400, holdMs: 2000 });
    tracker.update({ a: 0.5, b: 0.0 }, 0);
    assert.equal(tracker.update({ a: 0.5, b: 0.0 }, 450), 'a');
    // a leaves; b has been talking and should be pick-able without waiting out the hold window
    tracker.update({ b: 0.5 }, 500);
    assert.equal(tracker.update({ b: 0.5 }, 950), 'b');
  });

  it('returns null when nobody is speaking', () => {
    const tracker = createActiveSpeakerTracker();
    assert.equal(tracker.update({ a: 0.02, b: 0.0 }, 0), null);
    assert.equal(tracker.update({ a: 0.02, b: 0.0 }, 1000), null);
    assert.equal(tracker.getActiveId(), null);
  });

  it('reset clears all state', () => {
    const tracker = createActiveSpeakerTracker();
    tracker.update({ a: 0.5 }, 0);
    tracker.update({ a: 0.5 }, 500);
    tracker.reset();
    assert.equal(tracker.getActiveId(), null);
    assert.equal(tracker.update({ a: 0.5 }, 600), null); // activation window starts over
  });
});
