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

  it('ignores the destination ids: a reload names the same destinations differently', () => {
    const running = payload();
    const reloaded = payload({
      token: 'token-b',
      destinations: running.destinations.map((d, index) => ({ ...d, id: `saved-${index}`, name: `${d.name} (saved)` })),
    });
    assert.equal(isSameRelaySetup(running, reloaded), true);
    // ...and a different order of the saved list does not matter either.
    assert.equal(isSameRelaySetup(running, { ...reloaded, destinations: [...reloaded.destinations].reverse() }), true);
  });

  it('rejects another URL, a key with different case, or one destination more or fewer, whatever the ids', () => {
    const running = payload();
    const renamed = running.destinations.map((d, index) => ({ ...d, id: `saved-${index}` }));
    assert.equal(isSameRelaySetup(running, payload({ destinations: renamed.map((d, i) => (i === 0 ? { ...d, rtmpUrl: 'rtmp://b.rtmp.youtube.com/live2' } : d)) })), false);
    assert.equal(isSameRelaySetup(running, payload({ destinations: renamed.map((d, i) => (i === 0 ? { ...d, streamKey: 'KEY-1' } : d)) })), false);
    assert.equal(isSameRelaySetup(running, payload({ destinations: renamed.slice(1) })), false);
    assert.equal(isSameRelaySetup(running, payload({ destinations: [...renamed, { id: 'saved-2', name: 'Extra', rtmpUrl: 'rtmp://c/live', streamKey: 'key-3' }] })), false);
  });

  it('treats a duplicated destination as a different list', () => {
    const running = payload();
    const twice = [running.destinations[0], { ...running.destinations[0], id: 'yt-2' }];
    assert.equal(isSameRelaySetup(payload({ destinations: twice }), payload({ destinations: twice.map((d, i) => ({ ...d, id: `n${i}` })) })), true);
    assert.equal(isSameRelaySetup(payload({ destinations: twice }), payload({ destinations: running.destinations.slice(0, 1) })), false);
  });

  it('rejects a studio that now uploads in another video mode', () => {
    const h264 = { container: 'matroska' as const, videoCodec: 'h264' as const, audioCodec: 'opus' as const, keyframeIntervalMs: 2_000 };
    const copy = payload({ encoding: h264 });
    assert.equal(isSameRelaySetup(copy, payload({ token: 'token-b', encoding: h264 })), true);
    assert.equal(isSameRelaySetup(copy, payload()), false, 'VP8 after H.264 would change the output codec setup');
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
