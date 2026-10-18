import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replaceFallbackMediaTrack } from '../src/utils/mediaDeviceFallback.ts';

function track(kind: 'audio' | 'video', enabled = true) {
  let stopped = false;
  return {
    kind,
    enabled,
    stop() { stopped = true; },
    get stopped() { return stopped; },
  } as unknown as MediaStreamTrack & { readonly stopped: boolean };
}

function stream(previous: MediaStreamTrack | undefined, onAdded: (track: MediaStreamTrack) => void) {
  const tracks = previous ? [previous] : [];
  return {
    tracks,
    removeTrack(removed: MediaStreamTrack) { tracks.splice(tracks.indexOf(removed), 1); },
    addTrack(added: MediaStreamTrack) { onAdded(added); tracks.push(added); },
  };
}

describe('automatic media device fallback privacy', () => {
  for (const kind of ['audio', 'video'] as const) {
    it(`keeps a disabled ${kind} disabled before publishing its replacement`, () => {
      const disconnected = track(kind, false);
      const replacement = track(kind);
      const media = stream(disconnected, (added) => assert.equal(added.enabled, false));

      const enabled = replaceFallbackMediaTrack(media, disconnected, replacement);

      assert.equal(enabled, false);
      assert.equal(disconnected.stopped, true);
      assert.deepEqual(media.tracks, [replacement]);
    });

    it(`keeps an enabled ${kind} available after its device disconnects`, () => {
      const disconnected = track(kind);
      const replacement = track(kind);
      const media = stream(disconnected, (added) => assert.equal(added.enabled, true));

      assert.equal(replaceFallbackMediaTrack(media, disconnected, replacement), true);
      assert.deepEqual(media.tracks, [replacement]);
    });
  }

  it('preserves mute on both the processed microphone and its capture source', () => {
    const disconnected = track('audio', false);
    const processed = track('audio');
    const capture = track('audio');
    const media = stream(disconnected, () => {
      assert.equal(processed.enabled, false);
      assert.equal(capture.enabled, false);
    });

    assert.equal(replaceFallbackMediaTrack(media, disconnected, processed, capture), false);
  });

  it('does not enable a new capture when there is no previous privacy choice', () => {
    const replacement = track('video');
    const media = stream(undefined, (added) => assert.equal(added.enabled, false));

    assert.equal(replaceFallbackMediaTrack(media, undefined, replacement), false);
  });
});
