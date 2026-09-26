import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getRelayAttemptsUsed,
  getRelayReconnectDelayMs,
  getRelayReconnectPlan,
  MAX_RELAY_RECONNECT_ATTEMPTS,
  RELAY_RECONNECT_DELAY_MS,
  RELAY_STABLE_AFTER_MS,
} from '../src/utils/rtmpRelayReconnect.ts';

describe('RTMP relay reconnect policy', () => {
  it('returns the next bounded reconnect attempt with a destination-safe message', () => {
    const plan = getRelayReconnectPlan(0, 'Media relay connection closed unexpectedly.');

    assert.equal(plan?.attempt, 1);
    assert.equal(plan?.maxAttempts, MAX_RELAY_RECONNECT_ATTEMPTS);
    assert.match(plan?.message || '', /Reconnecting \(1\/10\)/);
    assert.match(plan?.message || '', /Media relay connection closed unexpectedly/);
    assert.equal(RELAY_RECONNECT_DELAY_MS, 1500);
  });

  it('stops retrying after the maximum attempt count', () => {
    assert.equal(getRelayReconnectPlan(MAX_RELAY_RECONNECT_ATTEMPTS, 'Relay dropped'), null);
    assert.equal(getRelayReconnectPlan(-1, 'Relay dropped'), null);
    assert.equal(getRelayReconnectPlan(0, 'Relay dropped', 0), null);
  });

  it('uses a generic reconnect reason when the relay does not provide one', () => {
    const plan = getRelayReconnectPlan(1, '   ');

    assert.equal(plan?.attempt, 2);
    assert.match(plan?.message || '', /Media relay connection dropped/);
    assert.match(plan?.message || '', /Reconnecting \(2\/10\)/);
  });

  it('keeps trying for about two minutes with growing gaps', () => {
    const delays = Array.from({ length: MAX_RELAY_RECONNECT_ATTEMPTS }, (_, i) => getRelayReconnectDelayMs(i + 1));
    assert.deepEqual(delays, [1500, 3000, 6000, 12000, 15000, 15000, 15000, 15000, 15000, 15000]);
    assert.ok(delays.reduce((a, b) => a + b, 0) >= 110_000);
  });

  it('starts counting again once the relay has been connected for a while', () => {
    const now = 1_000_000;
    assert.equal(getRelayAttemptsUsed(4, now - RELAY_STABLE_AFTER_MS, now), 0);
    assert.equal(getRelayAttemptsUsed(4, now - 2_000, now), 4);
    assert.equal(getRelayAttemptsUsed(1, null, now), 1);
  });
});
