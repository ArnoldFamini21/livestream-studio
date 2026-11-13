import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeMediaServerHealthPayload } from '../src/utils/mediaServerHealth.ts';
import {
  INITIAL_HELD_WATCH_STATE,
  formatHeldCountdown,
  getHeldTestBlocker,
  heldWatchReducer,
  isHeldBroadcastSupported,
  parseHeldBroadcastAnswer,
  type HeldBroadcastAnswer,
  type HeldWatchEvent,
  type HeldWatchState,
} from '../src/utils/heldBroadcastState.ts';

const held = (secondsLeft: number): HeldBroadcastAnswer => ({
  held: true,
  state: 'held',
  secondsLeft,
  destinations: [{ name: 'YouTube', connected: true }],
});
const notHeld = (state: 'none' | 'broadcast' | 'test'): HeldBroadcastAnswer => ({ held: false, state, secondsLeft: 0, destinations: [] });

function run(events: HeldWatchEvent[], from: HeldWatchState = INITIAL_HELD_WATCH_STATE): HeldWatchState {
  return events.reduce(heldWatchReducer, from);
}

describe('parseHeldBroadcastAnswer', () => {
  it('reads a held answer', () => {
    assert.deepEqual(parseHeldBroadcastAnswer({
      held: true, state: 'held', secondsLeft: 151.7, destinations: [{ name: 'YouTube', connected: true }, { name: 'FB', connected: false }, 7, { name: 5 }],
    }), {
      held: true,
      state: 'held',
      secondsLeft: 151,
      destinations: [{ name: 'YouTube', connected: true }, { name: 'FB', connected: false }],
    });
  });

  it('reads a not-held answer with what is running', () => {
    assert.deepEqual(parseHeldBroadcastAnswer({ held: false, state: 'broadcast' }), notHeld('broadcast'));
    assert.deepEqual(parseHeldBroadcastAnswer({ held: false, state: 'test' }), notHeld('test'));
    assert.deepEqual(parseHeldBroadcastAnswer({ held: false }), notHeld('none'));
  });

  it('refuses anything that is not an answer', () => {
    for (const value of [null, undefined, 'x', 3, {}, { held: 'yes' }, { held: true }, { held: true, secondsLeft: 'soon' }]) {
      assert.equal(parseHeldBroadcastAnswer(value), null, JSON.stringify(value));
    }
  });
});

describe('heldWatchReducer', () => {
  it('starts idle and stays idle for an answer that holds nothing', () => {
    assert.deepEqual(run([{ type: 'ANSWER', answer: notHeld('none') }]), { phase: 'idle' });
    assert.deepEqual(run([{ type: 'ANSWER', answer: notHeld('broadcast') }]), { phase: 'idle' });
  });

  it('takes the seconds from the answer, then counts down locally', () => {
    const state = run([{ type: 'ANSWER', answer: held(120) }, { type: 'TICK' }, { type: 'TICK' }]);
    assert.deepEqual(state, { phase: 'held', secondsLeft: 118, destinations: [{ name: 'YouTube', connected: true }] });
  });

  it('a newer answer replaces the local count', () => {
    const state = run([{ type: 'ANSWER', answer: held(120) }, { type: 'TICK' }, { type: 'ANSWER', answer: held(105) }]);
    assert.equal(state.phase === 'held' && state.secondsLeft, 105);
  });

  it('ends when the countdown reaches zero', () => {
    const state = run([{ type: 'ANSWER', answer: held(2) }, { type: 'TICK' }]);
    assert.equal(state.phase, 'held');
    assert.deepEqual(run([{ type: 'TICK' }], state), { phase: 'ended' });
  });

  it('ends when the server says the hold is over, but not when the broadcast runs again or a test runs', () => {
    assert.deepEqual(run([{ type: 'ANSWER', answer: held(60) }, { type: 'ANSWER', answer: notHeld('none') }]), { phase: 'ended' });
    assert.deepEqual(run([{ type: 'ANSWER', answer: held(60) }, { type: 'ANSWER', answer: notHeld('broadcast') }]), { phase: 'idle' });
    assert.deepEqual(run([{ type: 'ANSWER', answer: held(60) }, { type: 'ANSWER', answer: notHeld('test') }]), { phase: 'idle' });
  });

  it('treats a hold with no seconds left as over once it was shown, and as nothing before', () => {
    assert.deepEqual(run([{ type: 'ANSWER', answer: held(60) }, { type: 'ANSWER', answer: held(0) }]), { phase: 'ended' });
    assert.deepEqual(run([{ type: 'ANSWER', answer: held(0) }]), { phase: 'idle' });
  });

  it('an ended notice stays until dismissed, and ticks do nothing to it', () => {
    const ended = run([{ type: 'ANSWER', answer: held(1) }, { type: 'TICK' }]);
    assert.deepEqual(run([{ type: 'TICK' }, { type: 'ANSWER', answer: notHeld('none') }], ended), { phase: 'ended' });
    assert.deepEqual(run([{ type: 'DISMISS' }], ended), { phase: 'idle' });
  });

  it('dismiss does not hide a hold; reset clears everything', () => {
    const state = run([{ type: 'ANSWER', answer: held(60) }]);
    assert.equal(run([{ type: 'DISMISS' }], state), state);
    assert.deepEqual(run([{ type: 'RESET' }], state), { phase: 'idle' });
    assert.deepEqual(run([{ type: 'RESET' }], { phase: 'ended' }), { phase: 'idle' });
  });

  it('a new hold after an ended notice shows again', () => {
    assert.equal(run([{ type: 'ANSWER', answer: held(30) }], { phase: 'ended' }).phase, 'held');
  });
});

describe('formatHeldCountdown', () => {
  it('writes M:SS', () => {
    assert.equal(formatHeldCountdown(180), '3:00');
    assert.equal(formatHeldCountdown(65), '1:05');
    assert.equal(formatHeldCountdown(9), '0:09');
    assert.equal(formatHeldCountdown(-3), '0:00');
  });
});

describe('isHeldBroadcastSupported', () => {
  it('reads the capability from /health, and an old media server has none', () => {
    const input = { mediaHttpUrl: 'https://media.example.com', checkedAt: 1 };
    const withIt = normalizeMediaServerHealthPayload(
      { status: 'ok', service: 'media-server', capabilities: { heldBroadcast: { ready: true, message: 'ok' } } }, input
    );
    assert.equal(isHeldBroadcastSupported(withIt), true);
    const old = normalizeMediaServerHealthPayload({ status: 'ok', service: 'media-server', capabilities: { testStream: { ready: true, message: 'ok' } } }, input);
    assert.equal(isHeldBroadcastSupported(old), false);
  });

  it('needs a media server that advertises the request', () => {
    assert.equal(isHeldBroadcastSupported({ status: 'ready', heldBroadcast: { ready: true, message: '' } }), true);
    assert.equal(isHeldBroadcastSupported({ status: 'ready' }), false);
    assert.equal(isHeldBroadcastSupported({ status: 'ready', heldBroadcast: { ready: false, message: '' } }), false);
    assert.equal(isHeldBroadcastSupported({ status: 'unavailable', heldBroadcast: { ready: true, message: '' } }), false);
    assert.equal(isHeldBroadcastSupported(null), false);
  });
});

describe('getHeldTestBlocker', () => {
  it('blocks the private test with one line only while a hold is shown', () => {
    assert.match(getHeldTestBlocker({ phase: 'held', secondsLeft: 5, destinations: [] }) || '', /still on the air/);
    assert.equal(getHeldTestBlocker({ phase: 'idle' }), null);
    assert.equal(getHeldTestBlocker({ phase: 'ended' }), null);
  });
});
