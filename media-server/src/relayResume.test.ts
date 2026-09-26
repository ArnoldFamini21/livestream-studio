import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RtmpRelayStartPayload } from '@studio/shared';
import { isSameRelaySetup, shouldShowSlate, STUDIO_INPUT_STALL_MS } from './relayResume.js';

function payload(overrides: Partial<RtmpRelayStartPayload> = {}): RtmpRelayStartPayload {
  return {
    token: 'token-a',
    destinations: [
      { id: 'yt', name: 'YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'key-1' },
      { id: 'fb', name: 'Facebook', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp', streamKey: 'key-2' },
    ],
    video: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 },
    audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 160_000 },
    ...overrides,
  } as RtmpRelayStartPayload;
}

describe('isSameRelaySetup', () => {
  it('matches the same destinations and settings with a new token, in any order', () => {
    const running = payload();
    const incoming = payload({ token: 'token-b', destinations: [...running.destinations].reverse() });
    assert.equal(isSameRelaySetup(running, incoming), true);
  });

  it('rejects a different stream key, destination list, or output size', () => {
    const running = payload();
    assert.equal(isSameRelaySetup(running, payload({
      destinations: running.destinations.map((d) => (d.id === 'yt' ? { ...d, streamKey: 'other' } : d)),
    })), false);
    assert.equal(isSameRelaySetup(running, payload({ destinations: running.destinations.slice(0, 1) })), false);
    assert.equal(isSameRelaySetup(running, payload({ video: { ...running.video, width: 1080, height: 1920 } })), false);
  });
});

describe('shouldShowSlate', () => {
  const base = { lastMediaAtMs: 0, hasLiveDestination: true, slateOnAir: false };
  it('waits for a stall on a live broadcast', () => {
    assert.equal(shouldShowSlate({ ...base, nowMs: STUDIO_INPUT_STALL_MS - 1 }), false);
    assert.equal(shouldShowSlate({ ...base, nowMs: STUDIO_INPUT_STALL_MS }), true);
  });
  it('never before a destination is live, or twice', () => {
    assert.equal(shouldShowSlate({ ...base, nowMs: 60_000, hasLiveDestination: false }), false);
    assert.equal(shouldShowSlate({ ...base, nowMs: 60_000, slateOnAir: true }), false);
  });
});
