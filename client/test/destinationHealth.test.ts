import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RtmpRelayDestinationStats, StreamDestination } from '@studio/shared';
import {
  buildDestinationHealth,
  describeServerUploadEstimate,
  estimateServerUpload,
  formatGigabytesPerHour,
  getDestinationConnectionState,
  kbpsToGigabytesPerHour,
} from '../src/utils/destinationHealth.ts';
import { RELAY_SERVER_STATS_STALE_MS } from '../src/utils/relayServerHealth.ts';

const NOW = 1_000_000;

function dest(id: string, overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id,
    platform: 'custom',
    name: id,
    rtmpUrl: 'rtmp://live.example.com/app',
    streamKey: 'key',
    enabled: true,
    status: 'live',
    ...overrides,
  };
}

function stats(id: string, bitrateKbps: number | null, at = NOW - 1_000): RtmpRelayDestinationStats {
  return { destinationId: id, bitrateKbps, speed: 1, at };
}

describe('destination health', () => {
  it('maps relay status to connected, connecting, reconnecting, failed and waiting', () => {
    assert.equal(getDestinationConnectionState({ status: 'live' }), 'connected');
    assert.equal(getDestinationConnectionState({ status: 'connecting' }), 'connecting');
    // The media server's retry message and the browser's own network retry.
    assert.equal(getDestinationConnectionState({ status: 'connecting', statusMessage: 'Reconnecting (2/8) in 3 s' }), 'reconnecting');
    assert.equal(
      getDestinationConnectionState({ status: 'connecting', statusMessage: 'Your internet connection dropped. Reconnecting as soon as it is back...' }),
      'reconnecting',
    );
    assert.equal(getDestinationConnectionState({ status: 'error', statusMessage: 'Could not connect' }), 'failed');
    assert.equal(getDestinationConnectionState({ status: 'idle' }), 'idle');
  });

  it('sums only fresh bitrates from connected destinations', () => {
    const summary = buildDestinationHealth({
      destinations: [
        dest('a', { platform: 'youtube', name: 'Church YouTube' }),
        dest('b', { platform: 'kick' }),
        dest('c', { status: 'connecting', statusMessage: 'Reconnecting (1/8) in 2 s' }),
        dest('d', { status: 'error', statusMessage: 'Lost the connection' }),
        dest('e'),
      ],
      destinationStats: {
        a: stats('a', 4_660),
        b: stats('b', 4_640),
        // A dropped uploader's last report must not count.
        c: stats('c', 4_600),
        d: stats('d', 4_600),
        // Stale report: unknown.
        e: stats('e', 4_600, NOW - RELAY_SERVER_STATS_STALE_MS - 1),
      },
      serverHealth: null,
      now: NOW,
    });

    assert.equal(summary.totalOutgoingKbps, 9_300);
    assert.deepEqual(summary.rows.map((row) => [row.id, row.state, row.bitrateKbps]), [
      ['a', 'connected', 4_660],
      ['b', 'connected', 4_640],
      ['c', 'reconnecting', null],
      ['d', 'failed', null],
      ['e', 'connected', null],
    ]);
    assert.deepEqual(summary.counts, { connected: 3, connecting: 0, reconnecting: 1, failed: 1, idle: 0 });
    assert.equal(summary.rows[0].platformLabel, 'YouTube');
    assert.equal(summary.rows[1].platformLabel, 'Kick');
    assert.equal(summary.rows[2].stateLabel, 'Reconnecting');
    assert.equal(summary.rows[2].detail, 'Reconnecting (1/8) in 2 s');
    assert.equal(summary.rows[3].stateLabel, 'Failed');
  });

  it('surfaces the server warning for a connected destination that is falling behind', () => {
    const summary = buildDestinationHealth({
      destinations: [dest('a', { statusMessage: 'Caught up: skipped about 2s to stay live.' }), dest('b')],
      destinationStats: { a: stats('a', 1_200), b: stats('b', 4_600) },
      serverHealth: {
        a: { status: 'poor', detail: 'Server sends 1.2 Mbps, below the 4.6 Mbps it receives.' },
        b: { status: 'good', detail: 'Server sends 4.6 Mbps.' },
      },
      now: NOW,
    });
    assert.equal(summary.rows[0].serverStatus, 'poor');
    assert.match(summary.rows[0].detail || '', /below the 4\.6 Mbps/);
    // A healthy report adds nothing beyond the bitrate column.
    assert.equal(summary.rows[1].detail, null);
  });

  it('estimates the server upload for copy-only fan-out', () => {
    // 4.5 Mbps video + 160 kbps audio, eight destinations.
    const estimate = estimateServerUpload(8, 4_660);
    assert.equal(estimate.totalKbps, 37_280);
    assert.ok(Math.abs(estimate.gigabytesPerHour - 16.776) < 0.001);
    assert.equal(formatGigabytesPerHour(estimate.gigabytesPerHour), '17 GB/h');
    assert.equal(formatGigabytesPerHour(kbpsToGigabytesPerHour(4_660)), '2.1 GB/h');
    assert.match(describeServerUploadEstimate(estimate), /8 destinations × 4\.7 Mbps ≈ 37\.3 Mbps \(17 GB\/h\)/);
    assert.match(describeServerUploadEstimate(estimate), /Render/);
    assert.match(describeServerUploadEstimate(estimateServerUpload(1, 4_660)), /1 destination at 4\.7 Mbps/);
    assert.equal(describeServerUploadEstimate(estimateServerUpload(0, 4_660)), 'No destinations enabled.');
    assert.equal(kbpsToGigabytesPerHour(-5), 0);
  });
});
