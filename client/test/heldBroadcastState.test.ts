import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildInitialMediaServerHealth,
  checkMediaServerHealth,
  normalizeMediaServerHealthPayload,
  type MediaServerHealth,
} from '../src/utils/mediaServerHealth.ts';
import {
  INITIAL_HELD_WATCH_STATE,
  formatHeldCountdown,
  getHeldBroadcastSupport,
  getHeldTestBlocker,
  heldWatchReducer,
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

describe('getHeldBroadcastSupport', () => {
  const input = { mediaHttpUrl: 'https://media.example.com', checkedAt: 1, httpStatus: 200 };
  const ready = normalizeMediaServerHealthPayload(
    { status: 'ok', service: 'media-server', capabilities: { heldBroadcast: { ready: true, message: 'ok' } } }, input
  );
  const old = normalizeMediaServerHealthPayload(
    { status: 'ok', service: 'media-server', capabilities: { testStream: { ready: true, message: 'ok' } } }, input
  );
  const check = (fetchImpl: () => Promise<Response>) => checkMediaServerHealth({
    mediaHttpUrl: 'https://media.example.com',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const timeout = () => check(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); });
  const otherService = () => check(async () => new Response(JSON.stringify({ status: 'ok', service: 'signaling-server' }), { status: 200 }));
  /** What useMediaServerHealth.refresh shows while a manual check runs: the last record, marked as checking. */
  const whileRechecking = (health: MediaServerHealth): MediaServerHealth => ({
    ...health,
    status: 'checking',
    message: 'Checking media-server readiness...',
  });

  it('reads the capability from /health, and an old media server has none', () => {
    assert.equal(ready.status, 'ready');
    assert.equal(getHeldBroadcastSupport(ready), 'yes');
    assert.equal(old.status, 'ready');
    assert.equal(getHeldBroadcastSupport(old), 'no');
  });

  it('needs a media server that advertises the request', () => {
    assert.equal(getHeldBroadcastSupport({ status: 'ready', heldBroadcast: { ready: true, message: '' } }), 'yes');
    assert.equal(getHeldBroadcastSupport({ status: 'ready' }), 'no');
    assert.equal(getHeldBroadcastSupport({ status: 'ready', heldBroadcast: { ready: false, message: '' } }), 'no');
    assert.equal(getHeldBroadcastSupport({ status: 'unavailable', heldBroadcast: { ready: false, message: '' } }), 'no');
    assert.equal(getHeldBroadcastSupport(null), 'no');
    assert.equal(getHeldBroadcastSupport(undefined), 'no');
  });

  it('waits for the first health answer', () => {
    assert.equal(getHeldBroadcastSupport(buildInitialMediaServerHealth('https://media.example.com')), 'no');
    assert.equal(getHeldBroadcastSupport({ status: 'checking' }), 'no');
    assert.equal(getHeldBroadcastSupport({ status: 'checking', checkedAt: null }), 'no');
  });

  it('leaves the question open after a health check that got no answer: a busy media server must not hide the banner', async () => {
    const timedOut = await timeout();
    assert.equal(timedOut.status, 'unavailable');
    assert.equal(timedOut.heldBroadcast, undefined, 'a failed check carries no capabilities');
    assert.equal(getHeldBroadcastSupport(timedOut), 'open');

    const offline = await check(async () => { throw new TypeError('Failed to fetch'); });
    assert.equal(getHeldBroadcastSupport(offline), 'open');

    for (const status of [429, 500, 502, 503]) {
      const busy = await check(async () => new Response('busy', { status }));
      assert.equal(busy.status, 'unavailable');
      assert.equal(getHeldBroadcastSupport(busy), 'open', `HTTP ${status}`);
    }
    assert.equal(getHeldBroadcastSupport({ status: 'unavailable', httpStatus: 503 }), 'open');
  });

  it('says no for a server that answered and is not a media server with the request', async () => {
    const other = await otherService();
    assert.equal(other.status, 'unavailable');
    assert.equal(getHeldBroadcastSupport(other), 'no');

    const notOk = await check(async () => new Response(JSON.stringify({ status: 'starting', service: 'media-server' }), { status: 200 }));
    assert.equal(getHeldBroadcastSupport(notOk), 'no');

    const notFound = await check(async () => new Response('Not found', { status: 404 }));
    assert.equal(notFound.status, 'unavailable');
    assert.equal(getHeldBroadcastSupport(notFound), 'no');
    assert.equal(getHeldBroadcastSupport({ status: 'unavailable', httpStatus: 200 }), 'no');
  });

  it('a manual re-check does not change the answer while it runs', async () => {
    // From a ready answer the capability is kept.
    assert.equal(getHeldBroadcastSupport(whileRechecking(ready)), 'yes');
    // From an old media server: still no.
    assert.equal(getHeldBroadcastSupport(whileRechecking(old)), 'no');
    // From a check that got no answer: still open, so the banner stays through the re-check.
    assert.equal(getHeldBroadcastSupport(whileRechecking(await timeout())), 'open');
    const busy = await check(async () => new Response('busy', { status: 503 }));
    assert.equal(getHeldBroadcastSupport(whileRechecking(busy)), 'open');
    // From an answer that was not a media server: still no.
    assert.equal(getHeldBroadcastSupport(whileRechecking(await otherService())), 'no');
  });
});

describe('getHeldTestBlocker', () => {
  it('blocks the private test with one line only while a hold is shown', () => {
    assert.match(getHeldTestBlocker({ phase: 'held', secondsLeft: 5, destinations: [] }) || '', /still on the air/);
    assert.equal(getHeldTestBlocker({ phase: 'idle' }), null);
    assert.equal(getHeldTestBlocker({ phase: 'ended' }), null);
  });
});
