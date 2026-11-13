import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_TEST_STREAM_STATE,
  MESSAGE_BUSY,
  MESSAGE_LIVE_BLOCKS_TEST,
  MESSAGE_TEST_BLOCKS_LIVE,
  TEST_BANNER_LABEL,
  describeSwitchFailure,
  describeTestPhase,
  isHeldBroadcastRefusal,
  getGoLiveBlocker,
  getTestStartBlocker,
  isTestOnAir,
  isTestRelayInUse,
  testStreamReducer,
  type TestStreamEvent,
  type TestStreamState,
} from '../src/utils/testStreamMachine.ts';

function run(events: TestStreamEvent[], from: TestStreamState = INITIAL_TEST_STREAM_STATE): TestStreamState {
  return events.reduce(testStreamReducer, from);
}

const started: TestStreamEvent[] = [
  { type: 'START_REQUESTED' },
  { type: 'START_SUCCEEDED', watchId: 't-abc', startedAt: '2026-11-13T10:00:00.000Z' },
];
const supported = { supported: true, unsupportedReason: '', isHost: true };

describe('test stream state machine', () => {
  it('runs a test from start to end', () => {
    const starting = run([{ type: 'START_REQUESTED' }]);
    assert.equal(starting.phase, 'starting');
    assert.equal(isTestRelayInUse(starting), true);
    assert.equal(isTestOnAir(starting), false);

    const testing = run(started);
    assert.equal(testing.phase, 'testing');
    assert.equal(testing.watchId, 't-abc');
    assert.equal(isTestOnAir(testing), true);
    assert.equal(describeTestPhase(testing).label, TEST_BANNER_LABEL);

    const ending = run([{ type: 'END_REQUESTED' }], testing);
    assert.equal(ending.phase, 'ending');
    assert.equal(run([{ type: 'END_COMPLETED' }], ending), INITIAL_TEST_STREAM_STATE);
  });

  it('switches from a test to the real broadcast', () => {
    const switching = run([{ type: 'GO_LIVE_REQUESTED' }], run(started));
    assert.equal(switching.phase, 'switching');
    assert.equal(isTestOnAir(switching), false, 'the TEST label goes away as soon as the switch starts');
    assert.equal(isTestRelayInUse(switching), true);

    const done = run([{ type: 'SWITCH_COMPLETED' }, { type: 'LIVE_ON' }], switching);
    assert.equal(done.phase, 'live');
    assert.equal(done.watchId, null);
    assert.equal(isTestRelayInUse(done), false);
    assert.equal(describeTestPhase(done).label, 'LIVE');
    assert.equal(run([{ type: 'LIVE_OFF' }], done), INITIAL_TEST_STREAM_STATE);
  });

  it('reports a failed switch and lets the host try again', () => {
    const failed = run([{ type: 'GO_LIVE_REQUESTED' }, { type: 'SWITCH_FAILED', message: 'Media server busy' }], run(started));
    assert.equal(failed.phase, 'error');
    assert.equal(failed.message, 'Media server busy');
    assert.equal(run([{ type: 'START_REQUESTED' }], failed).phase, 'starting');
    assert.equal(run([{ type: 'DISMISS' }], failed), INITIAL_TEST_STREAM_STATE);
  });

  it('never starts a test while live, and says why', () => {
    const live = run([{ type: 'LIVE_ON' }]);
    const after = run([{ type: 'START_REQUESTED' }], live);
    assert.equal(after.phase, 'live');
    assert.equal(after.message, MESSAGE_LIVE_BLOCKS_TEST);
    assert.equal(getTestStartBlocker(live, supported), MESSAGE_LIVE_BLOCKS_TEST);
  });

  it('never goes live through the normal path during a test, and says why', () => {
    const testing = run(started);
    assert.equal(getGoLiveBlocker(testing), MESSAGE_TEST_BLOCKS_LIVE);
    assert.equal(getGoLiveBlocker(run([{ type: 'START_REQUESTED' }])), MESSAGE_BUSY);
    assert.equal(getGoLiveBlocker(INITIAL_TEST_STREAM_STATE), null);
    assert.equal(getGoLiveBlocker(run([{ type: 'LIVE_ON' }])), null);
  });

  it('refuses a second test and a second switch while busy', () => {
    const testing = run(started);
    assert.equal(run([{ type: 'START_REQUESTED' }], testing), testing);
    const switching = run([{ type: 'GO_LIVE_REQUESTED' }], testing);
    assert.equal(run([{ type: 'GO_LIVE_REQUESTED' }], switching).message, MESSAGE_BUSY);
    assert.equal(run([{ type: 'START_REQUESTED' }], switching).message, MESSAGE_BUSY);
  });

  it('turns a failed start or a lost connection into a clear error', () => {
    const failed = run([{ type: 'START_REQUESTED' }, { type: 'START_FAILED', message: 'Media server did not respond' }]);
    assert.equal(failed.phase, 'error');
    assert.equal(failed.message, 'Media server did not respond');
    assert.equal(isTestRelayInUse(failed), false);

    const lost = run([{ type: 'RELAY_LOST', message: 'The connection was lost.' }], run(started));
    assert.equal(lost.phase, 'error');
    assert.equal(describeTestPhase(lost).tone, 'error');
    // A late event after the test ended changes nothing.
    assert.equal(run([{ type: 'RELAY_LOST', message: 'x' }]), INITIAL_TEST_STREAM_STATE);
    assert.equal(run([{ type: 'START_SUCCEEDED', watchId: 't-x', startedAt: 'now' }]), INITIAL_TEST_STREAM_STATE);
  });

  it('can cancel a test that is still starting', () => {
    assert.equal(run([{ type: 'START_REQUESTED' }, { type: 'END_REQUESTED' }]).phase, 'ending');
  });

  it('follows a new private address after a reconnect', () => {
    const next = run([{ type: 'OUTPUT_CHANGED', watchId: 't-new' }], run(started));
    assert.equal(next.watchId, 't-new');
    assert.equal(next.phase, 'testing');
    assert.equal(run([{ type: 'OUTPUT_CHANGED', watchId: 't-new' }]).watchId, null);
  });

  it('turns a test off if the studio goes live some other way', () => {
    const live = run([{ type: 'LIVE_ON' }], run(started));
    assert.equal(live.phase, 'live');
    assert.equal(live.watchId, null);
  });

  it('offers the test only to the host and only when the media server advertises it', () => {
    assert.equal(getTestStartBlocker(INITIAL_TEST_STREAM_STATE, supported), null);
    assert.equal(getTestStartBlocker(INITIAL_TEST_STREAM_STATE, { ...supported, isHost: false }), 'Only the host can run a test stream.');
    assert.match(
      getTestStartBlocker(INITIAL_TEST_STREAM_STATE, { ...supported, supported: false, unsupportedReason: 'Update the media server to use the test stream.' }) || '',
      /Update the media server/
    );
    assert.equal(getTestStartBlocker(run(started), supported), 'A test is already running.');
  });
});

describe('a test refused because the broadcast is on hold', () => {
  const message = 'Your broadcast is still on the air, waiting for you. Press Go Live to continue it. A test can run after the broadcast ends.';

  it('returns to idle with the server message, never stuck starting and never showing TEST', () => {
    const next = run([{ type: 'START_REQUESTED' }, { type: 'START_FAILED', message, refused: true }]);
    assert.equal(next.phase, 'idle');
    assert.equal(next.message, message);
    assert.equal(isTestOnAir(next), false);
    assert.equal(isTestRelayInUse(next), false);
    assert.equal(describeTestPhase(next).label, 'Not live');
    assert.equal(getTestStartBlocker(next, { supported: true, unsupportedReason: '', isHost: true }), null);
  });

  it('clears the message on the next press and on dismiss', () => {
    const refused = run([{ type: 'START_REQUESTED' }, { type: 'START_FAILED', message, refused: true }]);
    assert.equal(run([{ type: 'START_REQUESTED' }], refused).message, null);
    assert.equal(run([{ type: 'DISMISS' }], refused).message, null);
    assert.equal(run([{ type: 'DISMISS' }], refused).phase, 'idle');
  });

  it('is told apart from other failures by the error code', () => {
    assert.equal(isHeldBroadcastRefusal(Object.assign(new Error('x'), { code: 'TEST_BLOCKED_BY_HELD_BROADCAST' })), true);
    assert.equal(isHeldBroadcastRefusal(Object.assign(new Error('x'), { code: 'RELAY_CAPACITY_REACHED' })), false);
    assert.equal(isHeldBroadcastRefusal(new Error('x')), false);
    assert.equal(isHeldBroadcastRefusal(null), false);
  });

  it('keeps an ordinary failure as an error', () => {
    assert.equal(run([{ type: 'START_REQUESTED' }, { type: 'START_FAILED', message: 'boom' }]).phase, 'error');
  });
});

describe('"Go live now" failing after the test has ended', () => {
  const failure = describeSwitchFailure('Check destination settings before going live.');
  const switching = run(started.concat({ type: 'GO_LIVE_REQUESTED' }));

  it('words the reason in plain language', () => {
    assert.match(failure, /test has ended, but the broadcast did not start\. Reason: Check destination settings before going live\. Fix it/);
    assert.match(describeSwitchFailure(null), /Check the destination list/);
  });

  it('shows the message although LIVE_ON and LIVE_OFF came first', () => {
    const next = run([{ type: 'LIVE_ON' }, { type: 'LIVE_OFF' }, { type: 'SWITCH_FAILED', message: failure }], switching);
    assert.equal(next.phase, 'error');
    assert.equal(next.message, failure);
  });

  it('shows the message when it arrives before LIVE_OFF, and keeps it', () => {
    const next = run([{ type: 'LIVE_ON' }, { type: 'SWITCH_FAILED', message: failure }, { type: 'LIVE_OFF' }], switching);
    assert.equal(next.phase, 'error');
    assert.equal(next.message, failure);
  });

  it('shows the message when no live flip happened at all', () => {
    assert.equal(run([{ type: 'SWITCH_FAILED', message: failure }], switching).message, failure);
  });

  it('clears it on the next action', () => {
    const failed = run([{ type: 'SWITCH_FAILED', message: failure }], switching);
    assert.equal(run([{ type: 'START_REQUESTED' }], failed).message, null);
    assert.equal(run([{ type: 'DISMISS' }], failed).message, null);
    assert.equal(run([{ type: 'LIVE_ON' }], failed).message, null);
  });

  it('a successful switch leaves no message', () => {
    const next = run([{ type: 'LIVE_ON' }, { type: 'SWITCH_COMPLETED' }], switching);
    assert.equal(next.message, null);
    assert.equal(next.phase, 'live');
  });

  it('ignores a switch failure when no switch was started', () => {
    assert.equal(run([{ type: 'SWITCH_FAILED', message: failure }], run(started)).phase, 'testing');
  });
});
