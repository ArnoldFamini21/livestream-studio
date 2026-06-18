import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRelayLatency,
  getRelayLatencyMs,
  MAX_RELAY_LATENCY_MS,
} from '../src/utils/rtmpRelayLatency.ts';

describe('RTMP relay latency utilities', () => {
  it('calculates bounded relay round-trip latency', () => {
    assert.equal(getRelayLatencyMs(1_250, 1_000), 250);
    assert.equal(getRelayLatencyMs(1_000, 1_250), null);
    assert.equal(getRelayLatencyMs(MAX_RELAY_LATENCY_MS + 2, 1), null);
    assert.equal(getRelayLatencyMs(Number.NaN, 1_000), null);
  });

  it('formats relay latency for the health panel', () => {
    assert.equal(formatRelayLatency(null), 'waiting');
    assert.equal(formatRelayLatency(82), '82 ms');
    assert.equal(formatRelayLatency(1_250), '1.3 s');
  });
});
