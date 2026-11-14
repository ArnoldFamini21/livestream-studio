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
  let audioTime = 0;
  const ticks = () => {
    if (options.neverTicks) return false;
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
      sink = id;
      return Promise.resolve();
    };
  }
  const deps: AudioClockDeps = {
    // A call that never answers is given up on after 5 ms here (0.4 s for real).
    callTimeoutMs: 5,
    now: () => world.wallMs,
    sleep: (ms) => {
      world.sleeps.push(ms);
      world.wallMs += ms;
      if (ticks() && context.state === 'running') audioTime += ms / 1000;
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

  it('says stuck, and that the output is off, when the clock still does not move without a device', async () => {
    const { context, deps } = fakeWorld({ deviceStuck: true, neverTicks: true });
    assert.deepEqual(await checkProgramAudioClock(context, deps), { state: 'stuck', outputOff: true });
  });

  it('says stuck when the context will not run after a resume (and the device switch does not help)', async () => {
    const { context, deps } = fakeWorld({ suspended: true, resumeWorks: false, deviceStuck: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.equal(result.state, 'stuck');
  });

  it('does not wait for a resume that never answers, and stays within about 3 s', async () => {
    const { context, deps, world } = fakeWorld({ suspended: true, resumeHangs: true });
    const result = await checkProgramAudioClock(context, deps);
    assert.equal(result.state, 'stuck');
    assert.ok(world.wallMs <= 3_000, `took ${world.wallMs} ms`);
  });

  it('never throws, even when the clock cannot be read (that proves nothing, so: running)', async () => {
    const { context, deps } = fakeWorld({ clockThrows: true });
    assert.deepEqual(await checkProgramAudioClock(context, deps), { state: 'running', outputOff: false });
  });

  it('stays within about 3 s on the longest path', async () => {
    const { context, deps, world } = fakeWorld({ deviceStuck: true, neverTicks: true, suspended: true });
    await checkProgramAudioClock(context, deps);
    assert.ok(world.wallMs <= 3_500, `took ${world.wallMs} ms`);
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
