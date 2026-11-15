import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkProgramAudioClock,
  judgeAudioClock,
  restoreAudioOutputClock,
  type AudioClockDeps,
  type ClockedAudioContext,
} from '../src/audio/programAudioClock.ts';

describe('judgeAudioClock', () => {
  it('says running when the clock moved at least 0.2 s in a second or more', () => {
    assert.equal(judgeAudioClock({ state: 'running', before: 10, after: 11.2, elapsedMs: 1_200 }), 'running');
    assert.equal(judgeAudioClock({ state: 'running', before: 10, after: 10.2, elapsedMs: 1_000 }), 'running');
  });

  it('says stuck when less than 0.2 s passed in at least 1 s (the owner case: 0.005 s)', () => {
    assert.equal(judgeAudioClock({ state: 'running', before: 3, after: 3.005, elapsedMs: 1_000 }), 'stuck');
    assert.equal(judgeAudioClock({ state: 'running', before: 3, after: 3.1999, elapsedMs: 1_000 }), 'stuck');
    assert.equal(judgeAudioClock({ state: 'running', before: 3, after: 3.1, elapsedMs: 5_000 }), 'stuck');
  });

  it('says stuck when the context is not running after a resume, whatever the clock says', () => {
    assert.equal(judgeAudioClock({ state: 'suspended', before: 0, after: 5, elapsedMs: 1_200 }), 'stuck');
    assert.equal(judgeAudioClock({ state: 'closed', before: 0, after: 5, elapsedMs: 1_200 }), 'stuck');
    assert.equal(judgeAudioClock({ state: 'interrupted', before: 0, after: 5, elapsedMs: 1_200 }), 'stuck');
  });

  it('judges a shorter look in proportion (0.8 s needs 0.16 s)', () => {
    assert.equal(judgeAudioClock({ state: 'running', before: 0, after: 0.8, elapsedMs: 800 }), 'running');
    assert.equal(judgeAudioClock({ state: 'running', before: 0, after: 0.15, elapsedMs: 800 }), 'stuck');
    assert.equal(judgeAudioClock({ state: 'running', before: 0, after: 0.005, elapsedMs: 800 }), 'stuck');
  });

  it('does not call a clock stuck when no wall time passed, and calls an unreadable clock stuck', () => {
    assert.equal(judgeAudioClock({ state: 'running', before: 0, after: 0, elapsedMs: 0 }), 'running');
    assert.equal(judgeAudioClock({ state: 'running', before: 0, after: 0, elapsedMs: Number.NaN }), 'running');
    assert.equal(judgeAudioClock({ state: 'running', before: Number.NaN, after: 1, elapsedMs: 1_200 }), 'stuck');
  });
});

interface FakeOptions {
  /** The sound device is stuck: the clock only moves while the context has no sound device. */
  deviceStuck?: boolean;
  /** Starts suspended. */
  suspended?: boolean;
  /** resume() works. Default true. */
  resumeWorks?: boolean;
  /** resume() never answers. */
  resumeHangs?: boolean;
  /** No setSinkId at all (not Chrome). */
  noSetSinkId?: boolean;
  /** setSinkId rejects. */
  sinkRejects?: boolean;
  /** setSinkId takes the device away at once but answers only after 40 ms (a slow driver). */
  sinkAnswersLate?: boolean;
  /** setSinkId never answers and never changes the device. */
  sinkHangs?: boolean;
  /** setSinkId does not answer within the limit, and the device change lands this long after the call. */
  sinkLandsAfterMs?: number;
  /** While a device change is on its way the clock does not move (a device that is slow to open). */
  clockPausedWhileSwitching?: boolean;
  /** Even with no sound device the clock does not move. */
  neverTicks?: boolean;
  /** The clock cannot be read. */
  clockThrows?: boolean;
}

/** A fake context in a fake world: sleeping moves wall time, and the clock if it ticks. */
function fakeWorld(options: FakeOptions = {}) {
  const world = { wallMs: 0, sleeps: [] as number[] };
  const sinkCalls: Array<string | { type: 'none' }> = [];
  let sink: string | { type: 'none' } = '';
  let pendingSink: { id: string | { type: 'none' }; atMs: number } | null = null;
  let audioTime = 0;
  const ticks = () => {
    if (options.neverTicks) return false;
    if (options.clockPausedWhileSwitching && pendingSink) return false;
    const noDevice = typeof sink === 'object' && sink.type === 'none';
    return noDevice || !options.deviceStuck;
  };
  const context = {
    state: options.suspended ? 'suspended' : 'running',
    get currentTime() {
      if (options.clockThrows) throw new Error('context is gone');
      return audioTime;
    },
    resume() {
      if (options.resumeHangs) return new Promise<void>(() => {});
      if (options.resumeWorks !== false) context.state = 'running';
      return Promise.resolve();
    },
  } as ClockedAudioContext & { state: string };
  if (!options.noSetSinkId) {
    context.setSinkId = (id) => {
      sinkCalls.push(id);
      if (options.sinkRejects) return Promise.reject(new DOMException('no device', 'NotFoundError'));
      if (options.sinkHangs) return new Promise<void>(() => {});
      if (options.sinkLandsAfterMs !== undefined) {
        pendingSink = { id, atMs: world.wallMs + options.sinkLandsAfterMs };
        return new Promise<void>(() => {});
      }
      sink = id;
      if (options.sinkAnswersLate) return new Promise<void>((resolve) => { setTimeout(resolve, 40); });
      return Promise.resolve();
    };
  }
  const deps: AudioClockDeps = {
    // A call that never answers is given up on after 5 ms here (0.4 s for real).
    callTimeoutMs: 5,
    sinkCallTimeoutMs: 5,
    now: () => world.wallMs,
    sleep: (ms) => {
      world.sleeps.push(ms);
      const start = world.wallMs;
      const end = start + ms;
      const ticking = () => ticks() && context.state === 'running';
      let tickingMs = 0;
      if (pendingSink && pendingSink.atMs < end) {
        // The device change lands inside this stretch of time.
        const landsAt = Math.max(start, pendingSink.atMs);
        if (ticking()) tickingMs += landsAt - start;
        sink = pendingSink.id;
        pendingSink = null;
        if (ticking()) tickingMs += end - landsAt;
      } else if (ticking()) {
        tickingMs = ms;
      }
      world.wallMs = end;
      audioTime += tickingMs / 1000;
      return Promise.resolve();
    },
  };
  return { context, deps, world, sinkCalls, currentSink: () => sink };
}

describe('checkProgramAudioClock', () => {
  it('says running for a healthy clock, without touching the sound device', async () => {
    const { context, deps, sinkCalls, world } = fakeWorld();
    const result = await checkProgramAudioClock(context, deps);
    assert.deepEqual(result, { state: 'running', outputOff: false });
    assert.deepEqual(sinkCalls, []);
    assert.deepEqual(world.sleeps, [1_200]);
  });

  it('resumes a suspended context first', async () => {
    const { context, deps } = fakeWorld({ suspended: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.equal(result.state, 'running');
    assert.equal(context.state, 'running');
  });

  it('takes the sound device away when the clock is stuck, and says recovered when it then moves', async () => {
    const { context, deps, sinkCalls, currentSink, world } = fakeWorld({ deviceStuck: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.deepEqual(result, { state: 'recovered', outputOff: true });
    assert.deepEqual(sinkCalls, [{ type: 'none' }]);
    assert.deepEqual(currentSink(), { type: 'none' });
    assert.deepEqual(world.sleeps, [1_200, 800]);
    assert.ok(world.wallMs <= 3_000, `took ${world.wallMs} ms`);
  });

  it('says stuck, and does not claim the output is off, when there is no setSinkId', async () => {
    const { context, deps } = fakeWorld({ deviceStuck: true, noSetSinkId: true });
    assert.deepEqual(await checkProgramAudioClock(context, deps), { state: 'stuck', outputOff: false });
  });

  it('says stuck when setSinkId rejects', async () => {
    const { context, deps, sinkCalls } = fakeWorld({ deviceStuck: true, sinkRejects: true });
    assert.deepEqual(await checkProgramAudioClock(context, deps), { state: 'stuck', outputOff: false });
    assert.equal(sinkCalls.length, 1);
  });

  it('a slow device switch that lands is recovery, not a failure: recovered, and the output is off', async () => {
    const { context, deps, currentSink } = fakeWorld({ deviceStuck: true, sinkAnswersLate: true });
    // The switch answers after the call limit (5 ms here, 1 s for real) but has taken effect.
    const result = await checkProgramAudioClock(context, deps);
    assert.deepEqual(result, { state: 'recovered', outputOff: true });
    assert.deepEqual(currentSink(), { type: 'none' });
  });

  it('a device switch that never answers is unknown: the clock is still watched, and the output is reported off', async () => {
    const { context, deps, world } = fakeWorld({ deviceStuck: true, sinkHangs: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.deepEqual(result, { state: 'stuck', outputOff: true });
    assert.deepEqual(world.sleeps, [1_200, 800, 1_500], 'it looked at the clock twice more after the switch');
  });

  it('a device switch that lands late is still recovery: the second, longer look sees the clock move', async () => {
    // The switch lands 1.5 s after the call: after the 0.8 s look, inside the 1.5 s one.
    const { context, deps, world, currentSink } = fakeWorld({ deviceStuck: true, sinkLandsAfterMs: 1_500 });
    const result = await checkProgramAudioClock(context, deps);
    assert.deepEqual(result, { state: 'recovered', outputOff: true });
    assert.deepEqual(world.sleeps, [1_200, 800, 1_500]);
    assert.deepEqual(currentSink(), { type: 'none' });
  });

  it('does not take the second look when the first one already sees the clock move', async () => {
    const { context, deps, world } = fakeWorld({ deviceStuck: true });
    await checkProgramAudioClock(context, deps);
    assert.deepEqual(world.sleeps, [1_200, 800]);
  });

  it('says stuck, and that the output is off, when the clock still does not move without a device', async () => {
    const { context, deps } = fakeWorld({ deviceStuck: true, neverTicks: true });
    assert.deepEqual(await checkProgramAudioClock(context, deps), { state: 'stuck', outputOff: true });
  });

  it('says stuck when the context will not run after a resume (and the device switch does not help)', async () => {
    const { context, deps } = fakeWorld({ suspended: true, resumeWorks: false, deviceStuck: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.equal(result.state, 'stuck');
  });

  it('does not wait for a resume that never answers, and stays within about 3.5 s of looking', async () => {
    const { context, deps, world } = fakeWorld({ suspended: true, resumeHangs: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.equal(result.state, 'stuck');
    assert.ok(world.wallMs <= 3_500, `took ${world.wallMs} ms`);
  });

  it('never throws, even when the clock cannot be read (that proves nothing, so: running)', async () => {
    const { context, deps } = fakeWorld({ clockThrows: true });
    assert.deepEqual(await checkProgramAudioClock(context, deps), { state: 'running', outputOff: false });
  });

  it('looks at the clock for 3.5 s on the longest path (1.2 s, then 0.8 s and 1.5 s after the switch)', async () => {
    const { context, deps, world } = fakeWorld({ deviceStuck: true, neverTicks: true, suspended: true });
    await checkProgramAudioClock(context, deps);
    assert.deepEqual(world.sleeps, [1_200, 800, 1_500]);
    assert.equal(world.wallMs, 3_500);
  });
});

describe('restoreAudioOutputClock', () => {
  it('gives the default device back and says restored when the clock keeps moving', async () => {
    const { context, deps, sinkCalls, currentSink } = fakeWorld();
    const result = await restoreAudioOutputClock(context, deps);
    assert.deepEqual(result, { restored: true, outputOff: false });
    assert.deepEqual(sinkCalls, ['']);
    assert.equal(currentSink(), '');
  });

  it('goes back to no sound device when the clock is stuck again', async () => {
    const { context, deps, sinkCalls, currentSink } = fakeWorld({ deviceStuck: true });
    const result = await restoreAudioOutputClock(context, deps);
    assert.deepEqual(result, { restored: false, outputOff: true });
    assert.deepEqual(sinkCalls, ['', { type: 'none' }]);
    assert.deepEqual(currentSink(), { type: 'none' });
  });

  it('goes back to no sound device when the default device does not answer', async () => {
    const { context, deps, sinkCalls } = fakeWorld({ sinkRejects: true });
    const result = await restoreAudioOutputClock(context, deps);
    assert.deepEqual(result, { restored: false, outputOff: true });
    assert.deepEqual(sinkCalls, ['', { type: 'none' }]);
  });

  it('a default device that is slow to open is still restored: it gets a second look', async () => {
    // The switch back lands 2 s after the call (after the 1.2 s look, inside the 1.5 s one),
    // and the clock stands still until it has.
    const { context, deps, world, sinkCalls, currentSink } = fakeWorld({ sinkLandsAfterMs: 2_000, clockPausedWhileSwitching: true });
    const result = await restoreAudioOutputClock(context, deps);
    assert.deepEqual(result, { restored: true, outputOff: false });
    assert.deepEqual(world.sleeps, [1_200, 1_500]);
    assert.deepEqual(sinkCalls, ['']);
    assert.equal(currentSink(), '');
  });

  it('a default device that took the switch and does not run is given up on after one look', async () => {
    const { context, deps, world } = fakeWorld({ deviceStuck: true });
    await restoreAudioOutputClock(context, deps);
    assert.deepEqual(world.sleeps, [1_200], 'a dead device freezes the program sound for as short a time as possible');
  });

  it('a default device that never answers is given up on after the second look, and the sound stays off', async () => {
    const { context, deps, world, sinkCalls } = fakeWorld({ sinkHangs: true, deviceStuck: true });
    const result = await restoreAudioOutputClock(context, deps);
    assert.deepEqual(result, { restored: false, outputOff: true });
    assert.deepEqual(world.sleeps, [1_200, 1_500]);
    assert.deepEqual(sinkCalls, ['', { type: 'none' }]);
  });

  it('keeps saying the output is off when there is no setSinkId to restore with', async () => {
    const { context, deps } = fakeWorld({ noSetSinkId: true });
    assert.deepEqual(await restoreAudioOutputClock(context, deps), { restored: false, outputOff: true });
  });

  it('never throws', async () => {
    const { context, deps } = fakeWorld({ clockThrows: true });
    const result = await restoreAudioOutputClock(context, deps);
    assert.equal(result.restored, false);
  });
});
