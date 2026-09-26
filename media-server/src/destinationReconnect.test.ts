import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  DESTINATION_STABLE_AFTER_MS,
  MAX_DESTINATION_RECONNECTS,
  getDestinationReconnectDelayMs,
  getReconnectAttemptsAfterDrop,
} from './destinationReconnect.js';

it('backs off from 1.5 s to a 30 s ceiling and keeps trying for minutes', () => {
  const delays = Array.from({ length: MAX_DESTINATION_RECONNECTS }, (_, i) => getDestinationReconnectDelayMs(i + 1));
  assert.deepEqual(delays, [1500, 3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  assert.ok(delays.reduce((a, b) => a + b, 0) >= 120_000);
});

it('starts counting again after the destination has been healthy for a while', () => {
  const now = 1_000_000;
  assert.equal(getReconnectAttemptsAfterDrop(5, now - DESTINATION_STABLE_AFTER_MS, now), 0);
  assert.equal(getReconnectAttemptsAfterDrop(5, now - 1_000, now), 5, 'a reconnect that failed at once keeps its count');
  assert.equal(getReconnectAttemptsAfterDrop(2, null, now), 2);
});
