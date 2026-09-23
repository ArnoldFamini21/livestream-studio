import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RELAY_BACKLOG_RECONNECT_SECONDS,
  RELAY_BACKLOG_WARNING_SECONDS,
  formatRelayBacklog,
  getRelaySendBacklog,
} from '../src/utils/rtmpRelayBackpressure.ts';

describe('relay send backlog', () => {
  it('measures queued bytes as seconds of video at the target bitrate', () => {
    // 4.5 Mbps target: one second is 562,500 bytes.
    assert.deepEqual(getRelaySendBacklog(0, 4_500_000), { seconds: 0, level: 'ok' });
    assert.deepEqual(getRelaySendBacklog(562_500, 4_500_000), { seconds: 1, level: 'ok' });
    assert.equal(getRelaySendBacklog(562_500 * RELAY_BACKLOG_WARNING_SECONDS, 4_500_000).level, 'warning');
    assert.equal(getRelaySendBacklog(562_500 * RELAY_BACKLOG_RECONNECT_SECONDS, 4_500_000).level, 'critical');
  });

  it('treats invalid inputs as no backlog', () => {
    assert.equal(getRelaySendBacklog(Number.NaN, 4_500_000).level, 'ok');
    assert.equal(getRelaySendBacklog(1_000_000, 0).level, 'ok');
    assert.equal(getRelaySendBacklog(-5, 4_500_000).seconds, 0);
  });

  it('formats the backlog for the stream health panel', () => {
    assert.equal(formatRelayBacklog(0), 'None');
    assert.equal(formatRelayBacklog(0.3), 'None');
    assert.equal(formatRelayBacklog(2.46), '2.5s');
    assert.equal(formatRelayBacklog(14.6), '15s');
  });
});
