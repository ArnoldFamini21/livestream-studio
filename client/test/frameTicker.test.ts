import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrameGate } from '../src/utils/frameTicker.ts';

/** Feeds worker-style ticks every `intervalMs` (queued while a frame runs) and reports busy time. */
function simulate(frameMs: number, intervalMs = 33, durationMs = 3300) {
  let clock = 0;
  let frames = 0;
  let busyMs = 0;
  const gate = createFrameGate(intervalMs, () => { frames += 1; clock += frameMs; busyMs += frameMs; }, () => clock);
  for (let due = 0; due < durationMs; due += intervalMs) {
    if (clock < due) clock = due; // idle until the next tick arrives
    gate();                      // ticks queued during a slow frame arrive late, back to back
  }
  return { frames, busyShare: busyMs / Math.max(clock, 1) };
}

describe('frame gate', () => {
  it('draws every tick when frames are fast', () => {
    const { frames } = simulate(5);
    assert.equal(frames, 100);
  });

  it('keeps the full frame rate for frames that fit in the interval', () => {
    assert.equal(simulate(20).frames, 100);
    assert.equal(simulate(24).frames, 100);
  });

  it('leaves the main thread idle time when frames are slower than the interval', () => {
    const { busyShare, frames } = simulate(40);
    assert.ok(busyShare < 0.75, `busy ${Math.round(busyShare * 100)}% of the time`);
    assert.ok(frames > 30, 'still draws a reduced frame rate');
  });

  it('never runs frames back to back, even at 100 ms per frame', () => {
    const { busyShare } = simulate(100);
    assert.ok(busyShare < 0.9, `busy ${Math.round(busyShare * 100)}% of the time`);
  });

  it('keeps the gap after a frame that throws', () => {
    let clock = 0;
    const gate = createFrameGate(33, () => { clock += 20; throw new Error('draw failed'); }, () => clock);
    assert.throws(() => gate());
    clock += 5;
    assert.equal(gate(), false, 'a tick right after the failed frame is skipped');
  });
});
