import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RtmpRelayEncoderStats } from '@studio/shared';
import { evaluateRelayServerHealth, formatRelaySpeed } from '../src/utils/relayServerHealth.ts';

const NOW = 100_000;

function encoder(overrides: Partial<RtmpRelayEncoderStats> = {}): RtmpRelayEncoderStats {
  return {
    videoMode: 'copy',
    speed: 1,
    fps: 30,
    bitrateKbps: 4600,
    droppedFrames: 0,
    duplicatedFrames: 0,
    at: NOW - 1_000,
    ...overrides,
  };
}

describe('relay server health', () => {
  it('is good when the server copies in real time and every destination keeps up', () => {
    const health = evaluateRelayServerHealth({
      encoder: encoder(),
      videoMode: 'copy',
      destinationStats: { yt: { destinationId: 'yt', bitrateKbps: 4500, speed: 1, at: NOW - 500 } },
      destinationIds: ['yt'],
      upstreamKbps: 4700,
      now: NOW,
    });
    assert.equal(health.encoder.status, 'good');
    assert.equal(health.destinations.yt.status, 'good');
    assert.match(health.destinations.yt.detail, /4\.5 Mbps/);
    assert.equal(health.headline, null);
  });

  it('flags an encoder below real time as poor', () => {
    const health = evaluateRelayServerHealth({
      encoder: encoder({ videoMode: 'transcode', speed: 0.42 }),
      videoMode: 'transcode',
      destinationStats: {},
      destinationIds: ['yt'],
      upstreamKbps: 3000,
      now: NOW,
    });
    assert.equal(health.encoder.status, 'poor');
    assert.match(health.encoder.detail, /0\.42x/);
    assert.equal(health.headline?.status, 'poor');
    assert.equal(health.destinations.yt.status, 'unknown');
  });

  it('warns about a server re-encode even while it keeps up', () => {
    const health = evaluateRelayServerHealth({
      encoder: encoder({ videoMode: 'transcode', speed: 1.01 }),
      videoMode: 'transcode',
      destinationStats: {},
      destinationIds: [],
      upstreamKbps: 3000,
      now: NOW,
    });
    assert.equal(health.encoder.status, 'warning');
    assert.equal(health.headline?.status, 'warning');
  });

  it('flags a destination sending well under what the server receives', () => {
    const health = evaluateRelayServerHealth({
      encoder: encoder(),
      videoMode: 'copy',
      destinationStats: {
        yt: { destinationId: 'yt', bitrateKbps: 4400, speed: 1, at: NOW - 500 },
        fb: { destinationId: 'fb', bitrateKbps: 1800, speed: 1, at: NOW - 500 },
      },
      destinationIds: ['yt', 'fb'],
      upstreamKbps: 4700,
      now: NOW,
    });
    assert.equal(health.destinations.yt.status, 'good');
    assert.equal(health.destinations.fb.status, 'poor');
    assert.equal(health.headline, health.destinations.fb);
  });

  it('ignores stale reports', () => {
    const health = evaluateRelayServerHealth({
      encoder: encoder({ at: NOW - 60_000, speed: 0.2 }),
      videoMode: 'copy',
      destinationStats: { yt: { destinationId: 'yt', bitrateKbps: 10, speed: 0.1, at: NOW - 60_000 } },
      destinationIds: ['yt'],
      upstreamKbps: 4700,
      now: NOW,
    });
    assert.equal(health.encoder.status, 'unknown');
    assert.equal(health.destinations.yt.status, 'unknown');
    assert.equal(health.headline, null);
    assert.equal(formatRelaySpeed(null), '--');
  });
});
