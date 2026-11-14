import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideRelayMediaAction,
  decideRelayMediaWatch,
  getMediaRestartsInARow,
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

  it('starts the count again once chunks flowed for 60 s', () => {
    assert.equal(MEDIA_RESTARTS_RESET_AFTER_FLOW_MS, 60_000);
    assert.equal(getMediaRestartsInARow({ restarts: 2, firstChunkProducedAtMs: T0, lastChunkProducedAtMs: T0 + 59_999 }), 2);
    assert.equal(getMediaRestartsInARow({ restarts: 2, firstChunkProducedAtMs: T0, lastChunkProducedAtMs: T0 + 60_000 }), 0);
    assert.equal(getMediaRestartsInARow({ restarts: 1, firstChunkProducedAtMs: T0, lastChunkProducedAtMs: T0 + 600_000 }), 0);
  });

  it('keeps the count when no chunk ever flowed on the transport that stalled', () => {
    assert.equal(getMediaRestartsInARow({ restarts: 1, firstChunkProducedAtMs: null, lastChunkProducedAtMs: null }), 1);
    assert.equal(getMediaRestartsInARow({ restarts: 0, firstChunkProducedAtMs: null, lastChunkProducedAtMs: null }), 0);
  });

  it('walks a whole story: two restarts, a healthy minute, then two more restarts are allowed', () => {
    let count = 0;
    const act = (first: number | null, last: number | null) => {
      const used = getMediaRestartsInARow({ restarts: count, firstChunkProducedAtMs: first, lastChunkProducedAtMs: last });
      const decision = decideRelayMediaAction({ kind: 'stopped', audio: 'running', restartsInARow: used });
      if (decision.action === 'restart') count = decision.restartsInARow;
      return decision.action;
    };
    assert.equal(act(null, null), 'restart');
    assert.equal(act(null, null), 'restart');
    assert.equal(act(null, null), 'end');
    // Same story, but the second transport flows for 2 minutes before it stalls.
    count = 0;
    assert.equal(act(null, null), 'restart');
    assert.equal(act(T0, T0 + 120_000), 'restart');
    assert.equal(count, 1, 'after a healthy minute the count started again, so this was restart 1');
    assert.equal(act(null, null), 'restart');
    assert.equal(act(null, null), 'end');
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
