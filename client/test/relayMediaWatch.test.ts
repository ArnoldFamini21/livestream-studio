import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideRelayMediaAction,
  decideRelayMediaWatch,
  nextMediaFlowStart,
  restartsAfterFlow,
  runRelayMediaStall,
  RELAY_AUDIO_STUCK_TEST_MESSAGE,
  RELAY_NO_MEDIA_STOP_TEST_MESSAGE,
  MAX_MEDIA_RESTARTS_IN_A_ROW,
  MEDIA_RESTARTS_RESET_AFTER_FLOW_MS,
  RELAY_AUDIO_STUCK_MESSAGE,
  RELAY_CHUNK_GAP_MS,
  RELAY_NO_FIRST_CHUNK_MS,
  RELAY_NO_MEDIA_STOP_MESSAGE,
  type RelayMediaWatchInput,
} from '../src/utils/relayMediaWatch.ts';

const T0 = 1_000_000;

function watch(overrides: Partial<RelayMediaWatchInput> = {}) {
  return decideRelayMediaWatch({
    nowMs: T0,
    recorderStartedAtMs: T0,
    lastChunkProducedAtMs: null,
    sessionStarted: true,
    stoppingOnPurpose: false,
    reconnectWaiting: false,
    transportCurrent: true,
    ...overrides,
  });
}

describe('relay media watchdog: thresholds', () => {
  it('uses 8 s for the first chunk and 10 s for a gap', () => {
    assert.equal(RELAY_NO_FIRST_CHUNK_MS, 8_000);
    assert.equal(RELAY_CHUNK_GAP_MS, 10_000);
  });

  it('is fine until 8 s after the recorder started with no chunk, then says no-first-chunk', () => {
    assert.equal(watch({ nowMs: T0 }), 'fine');
    assert.equal(watch({ nowMs: T0 + 7_999 }), 'fine');
    assert.equal(watch({ nowMs: T0 + 8_000 }), 'no-first-chunk');
    assert.equal(watch({ nowMs: T0 + 60_000 }), 'no-first-chunk');
  });

  it('is fine until 10 s after the last produced chunk, then says stopped', () => {
    const lastChunkProducedAtMs = T0 + 20_000;
    assert.equal(watch({ nowMs: lastChunkProducedAtMs + 1_000, lastChunkProducedAtMs }), 'fine');
    assert.equal(watch({ nowMs: lastChunkProducedAtMs + 9_999, lastChunkProducedAtMs }), 'fine');
    assert.equal(watch({ nowMs: lastChunkProducedAtMs + 10_000, lastChunkProducedAtMs }), 'stopped');
  });

  it('measures a gap from the last chunk, not from the start, once a chunk exists', () => {
    // 8 s after start with a chunk produced just now: nothing wrong.
    assert.equal(watch({ nowMs: T0 + 30_000, lastChunkProducedAtMs: T0 + 29_500 }), 'fine');
  });

  it('ignores a chunk time from before this recorder started (an older recorder)', () => {
    assert.equal(watch({ nowMs: T0 + 9_000, lastChunkProducedAtMs: T0 - 500 }), 'no-first-chunk');
    assert.equal(watch({ nowMs: T0 + 3_000, lastChunkProducedAtMs: T0 - 500 }), 'fine');
  });

  it('never judges a clock that went backwards or a missing recorder', () => {
    assert.equal(watch({ nowMs: T0 - 5_000 }), 'fine');
    assert.equal(watch({ nowMs: T0 + 60_000, recorderStartedAtMs: null }), 'fine');
    assert.equal(watch({ nowMs: Number.NaN }), 'fine');
  });
});

describe('relay media watchdog: when it must not fire', () => {
  const late = { nowMs: T0 + 60_000 };

  it('does not fire before the media server answered session-started', () => {
    assert.equal(watch({ ...late, sessionStarted: false }), 'fine');
  });

  it('does not fire while the relay is stopping on purpose', () => {
    assert.equal(watch({ ...late, stoppingOnPurpose: true }), 'fine');
  });

  it('does not fire while a reconnect is waiting', () => {
    assert.equal(watch({ ...late, reconnectWaiting: true }), 'fine');
  });

  it('does not fire for a transport that is no longer current', () => {
    assert.equal(watch({ ...late, transportCurrent: false }), 'fine');
  });

  it('fires when all four conditions allow it', () => {
    assert.equal(watch(late), 'no-first-chunk');
  });
});

describe('relay media watchdog: a fake clock', () => {
  /** Runs the watchdog once a second, like the relay does, until it fires or the time is up. */
  function runUntilFires(options: { chunkTimes: number[]; endMs: number }): { verdict: string; at: number } {
    for (let now = T0; now <= T0 + options.endMs; now += 1_000) {
      const produced = options.chunkTimes.filter((time) => time <= now);
      const verdict = watch({ nowMs: now, lastChunkProducedAtMs: produced.length ? produced[produced.length - 1] : null });
      if (verdict !== 'fine') return { verdict, at: now - T0 };
    }
    return { verdict: 'fine', at: options.endMs };
  }

  it('fires no-first-chunk at 8 s when no chunk ever comes', () => {
    assert.deepEqual(runUntilFires({ chunkTimes: [], endMs: 30_000 }), { verdict: 'no-first-chunk', at: 8_000 });
  });

  it('never fires while a chunk comes every second', () => {
    const chunkTimes = Array.from({ length: 120 }, (_, index) => T0 + 1_000 * (index + 1));
    assert.equal(runUntilFires({ chunkTimes, endMs: 110_000 }).verdict, 'fine');
  });

  it('fires stopped 10 s after the chunks stop', () => {
    const chunkTimes = Array.from({ length: 15 }, (_, index) => T0 + 1_000 * (index + 1));
    // The last chunk is at 15 s; it fires at 25 s.
    assert.deepEqual(runUntilFires({ chunkTimes, endMs: 60_000 }), { verdict: 'stopped', at: 25_000 });
  });

  it('does not fire for a slow uplink: the time of the chunks produced is what counts', () => {
    // The recorder produces every second even if every send is late; nothing changes for the watchdog.
    const chunkTimes = Array.from({ length: 60 }, (_, index) => T0 + 1_000 * (index + 1));
    assert.equal(runUntilFires({ chunkTimes, endMs: 59_000 }).verdict, 'fine');
  });
});

describe('relay media watchdog: restarts in a row', () => {
  it('allows 2 restarts, then ends', () => {
    assert.equal(MAX_MEDIA_RESTARTS_IN_A_ROW, 2);
    const first = decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: 0 });
    assert.equal(first.action, 'restart');
    assert.equal(first.action === 'restart' && first.restartsInARow, 1);
    const second = decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: 1 });
    assert.equal(second.action === 'restart' && second.restartsInARow, 2);
    const third = decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: 2 });
    assert.deepEqual(third, { action: 'end', reason: 'no-media', message: RELAY_NO_MEDIA_STOP_MESSAGE });
  });

  it('treats no audio check like a check that found the audio running', () => {
    assert.deepEqual(
      decideRelayMediaAction({ kind: 'no-first-chunk', audio: null, restartsInARow: 0 }),
      decideRelayMediaAction({ kind: 'no-first-chunk', audio: 'running', restartsInARow: 0 })
    );
    assert.equal(decideRelayMediaAction({ kind: 'no-first-chunk', audio: null, restartsInARow: 2 }).action, 'end');
  });

  it('says plainly which kind of stall it was when it restarts', () => {
    const noFirst = decideRelayMediaAction({ kind: 'no-first-chunk', audio: 'running', restartsInARow: 0 });
    const stopped = decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: 0 });
    assert.match((noFirst as { message: string }).message, /did not start producing the broadcast/);
    assert.match((stopped as { message: string }).message, /stopped producing the broadcast/);
  });

  it('starts the count again once chunks flowed for 60 s in a row', () => {
    assert.equal(MEDIA_RESTARTS_RESET_AFTER_FLOW_MS, 60_000);
    assert.equal(restartsAfterFlow(2, T0, T0 + 59_999), 2);
    assert.equal(restartsAfterFlow(2, T0, T0 + 60_000), 0);
    assert.equal(restartsAfterFlow(1, T0, T0 + 600_000), 0);
  });

  it('keeps the count when no flow has begun', () => {
    assert.equal(restartsAfterFlow(1, null, T0 + 600_000), 1);
    assert.equal(restartsAfterFlow(0, null, T0), 0);
  });

  it('tracks the flow across the whole relay: a short gap keeps it, a long gap or no chunk breaks it', () => {
    assert.equal(nextMediaFlowStart({ flowStartMs: null, previousChunkMs: null, nowMs: T0 }), T0);
    assert.equal(nextMediaFlowStart({ flowStartMs: T0, previousChunkMs: T0 + 5_000, nowMs: T0 + 6_000 }), T0);
    // A reconnect that took 9 s does not break it (it is not a stall).
    assert.equal(nextMediaFlowStart({ flowStartMs: T0, previousChunkMs: T0 + 5_000, nowMs: T0 + 14_000 }), T0);
    assert.equal(
      nextMediaFlowStart({ flowStartMs: T0, previousChunkMs: T0 + 5_000, nowMs: T0 + 5_000 + RELAY_CHUNK_GAP_MS }),
      T0 + 5_000 + RELAY_CHUNK_GAP_MS
    );
  });

  it('a healthy stretch spread over several transports still resets the count', () => {
    // Transport 1 flows 30 s, the socket drops and transport 2 carries on for 40 s: 70 s of flow.
    let flow: number | null = null;
    let last: number | null = null;
    for (let t = 0; t <= 70_000; t += 1_000) {
      flow = nextMediaFlowStart({ flowStartMs: flow, previousChunkMs: last, nowMs: T0 + t });
      last = T0 + t;
    }
    assert.equal(restartsAfterFlow(2, flow, last as number), 0);
  });

  it('uses test words for the private test stream', () => {
    const restart = decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: 0, test: true });
    assert.match((restart as { message: string }).message, /producing the test\./);
    assert.deepEqual(
      decideRelayMediaAction({ kind: 'stopped', audio: 'stuck', restartsInARow: 0, test: true }),
      { action: 'end', reason: 'sound-output-stuck', message: RELAY_AUDIO_STUCK_TEST_MESSAGE }
    );
    assert.deepEqual(
      decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: 2, test: true }),
      { action: 'end', reason: 'no-media', message: RELAY_NO_MEDIA_STOP_TEST_MESSAGE }
    );
    assert.doesNotMatch(RELAY_AUDIO_STUCK_TEST_MESSAGE, /broadcast/);
    assert.doesNotMatch(RELAY_NO_MEDIA_STOP_TEST_MESSAGE, /broadcast|go live/);
  });
});

describe('relay media watchdog: what happens after the audio check (runRelayMediaStall)', () => {
  /** A fake relay: a shared restart count, a transport that can change, chunks that can come back. */
  function fakeRelay(overrides: Partial<Parameters<typeof runRelayMediaStall>[0]> = {}) {
    const state = { restarts: 0, wanted: true, lastChunk: null as number | null };
    const deps: Parameters<typeof runRelayMediaStall>[0] = {
      kind: 'stopped',
      firedAtMs: T0,
      stillWanted: () => state.wanted,
      lastChunkProducedAtMs: () => state.lastChunk,
      getRestarts: () => state.restarts,
      setRestarts: (n: number) => { state.restarts = n; },
      ...overrides,
    };
    return { state, deps };
  }

  it('restarts at most twice in a row for the same cause, then ends (the count is stored)', async () => {
    const { state, deps } = fakeRelay({ checkAudio: async () => ({ state: 'running' }) });
    const first = await runRelayMediaStall(deps);
    assert.equal(first.outcome === 'act' && first.decision.action, 'restart');
    assert.equal(state.restarts, 1);
    const second = await runRelayMediaStall(deps);
    assert.equal(second.outcome === 'act' && second.decision.action, 'restart');
    assert.equal(state.restarts, 2);
    const third = await runRelayMediaStall(deps);
    assert.equal(third.outcome === 'act' && third.decision.action, 'end');
    assert.equal(third.outcome === 'act' && third.decision.action === 'end' && third.decision.reason, 'no-media');
    assert.equal(state.restarts, 2, 'an end does not count as a restart');
  });

  it('does nothing when the relay moved on during the check (stopped, or another transport took over)', async () => {
    const relay = fakeRelay({ checkAudio: async () => { relay.state.wanted = false; return { state: 'stuck' }; } });
    assert.deepEqual(await runRelayMediaStall(relay.deps), { outcome: 'abandoned' });
    assert.equal(relay.state.restarts, 0);
  });

  it('does nothing for a restart answer when the relay moved on during the check', async () => {
    const relay = fakeRelay({ checkAudio: async () => { relay.state.wanted = false; return { state: 'running' }; } });
    assert.deepEqual(await runRelayMediaStall(relay.deps), { outcome: 'abandoned' });
    assert.equal(relay.state.restarts, 0, 'no restart is counted');
  });

  it('leaves a broadcast alone when chunks came back during the check, and does not count a restart', async () => {
    const relay = fakeRelay({ checkAudio: async () => { relay.state.lastChunk = T0 + 1_000; return { state: 'running' }; } });
    assert.deepEqual(await runRelayMediaStall(relay.deps), { outcome: 'self-recovered' });
    assert.equal(relay.state.restarts, 0);
  });

  it('also leaves it alone for a stuck answer when chunks are flowing again (a working recorder is not ended)', async () => {
    const relay = fakeRelay({ checkAudio: async () => { relay.state.lastChunk = T0 + 500; return { state: 'stuck' }; } });
    assert.deepEqual(await runRelayMediaStall(relay.deps), { outcome: 'self-recovered' });
  });

  it('a chunk from before the stall fired does not count as chunks coming back', async () => {
    const { state, deps } = fakeRelay({ checkAudio: async () => ({ state: 'running' }) });
    state.lastChunk = T0 - 11_000;
    assert.equal((await runRelayMediaStall(deps)).outcome, 'act');
    state.lastChunk = T0;
    assert.equal((await runRelayMediaStall(deps)).outcome, 'act');
  });

  it('keeps the wanted restart after a recovered answer, even if a chunk came out meanwhile', async () => {
    const relay = fakeRelay({ checkAudio: async () => { relay.state.lastChunk = T0 + 900; return { state: 'recovered' }; } });
    const result = await runRelayMediaStall(relay.deps);
    assert.equal(result.outcome === 'act' && result.decision.action === 'restart' && result.decision.cause, 'sound-output-recovered');
    assert.equal(relay.state.restarts, 1);
  });

  it('ends the relay when the audio is stuck and no chunk came back', async () => {
    const { state, deps } = fakeRelay({ checkAudio: async () => ({ state: 'stuck' }) });
    const result = await runRelayMediaStall(deps);
    assert.equal(result.outcome === 'act' && result.decision.action === 'end' && result.decision.reason, 'sound-output-stuck');
    assert.equal(state.restarts, 0);
  });

  it('treats a check that throws like no check', async () => {
    const { deps } = fakeRelay({ checkAudio: async () => { throw new Error('no context'); } });
    const result = await runRelayMediaStall(deps);
    assert.equal(result.outcome === 'act' && result.decision.action, 'restart');
  });

  it('restarts with the test words for the private test stream', async () => {
    const { deps } = fakeRelay({ test: true });
    const result = await runRelayMediaStall(deps);
    assert.match(result.outcome === 'act' && result.decision.action === 'restart' ? result.decision.message : '', /test/);
  });
});

describe('relay media watchdog: what the audio check changes', () => {
  it('ends the relay with the sound output reason when the audio cannot run', () => {
    const decision = decideRelayMediaAction({ kind: 'no-first-chunk', audio: 'stuck', restartsInARow: 0 });
    assert.deepEqual(decision, { action: 'end', reason: 'sound-output-stuck', message: RELAY_AUDIO_STUCK_MESSAGE });
    assert.equal(
      RELAY_AUDIO_STUCK_MESSAGE,
      "Your computer's sound output is not responding, so the browser cannot produce the broadcast. Check the sound output device or restart the browser, then go live again."
    );
  });

  it('ends for a stuck sound output even when no restart was used yet or all were', () => {
    for (const restartsInARow of [0, 1, 2, 5]) {
      const decision = decideRelayMediaAction({ kind: 'stopped', audio: 'stuck', restartsInARow });
      assert.equal(decision.action === 'end' && decision.reason, 'sound-output-stuck');
    }
  });

  it('restarts at once when the audio was recovered, and counts it', () => {
    const decision = decideRelayMediaAction({ kind: 'no-first-chunk', audio: 'recovered', restartsInARow: 0 });
    assert.equal(decision.action, 'restart');
    assert.equal(decision.action === 'restart' && decision.cause, 'sound-output-recovered');
    assert.equal(decision.action === 'restart' && decision.restartsInARow, 1);
  });

  it('ends with the no-media reason after the restarts are used up, even if the audio then runs', () => {
    assert.equal(
      RELAY_NO_MEDIA_STOP_MESSAGE,
      'Your browser is not producing the broadcast (no video or sound data came out of it). Reload the studio page and go live again. If it happens again, restart the browser.'
    );
    const decision = decideRelayMediaAction({ kind: 'stopped', audio: 'recovered', restartsInARow: 2 });
    assert.equal(decision.action === 'end' && decision.reason, 'no-media');
  });
});
