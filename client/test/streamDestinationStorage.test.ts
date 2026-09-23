import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StreamDestination } from '@studio/shared';
import {
  MAX_SAVED_DESTINATIONS,
  STREAM_DESTINATIONS_STORAGE_KEY,
  loadSavedStreamDestinations,
  restoreStreamDestinations,
  saveStreamDestinations,
  serializeStreamDestinations,
} from '../src/utils/streamDestinationStorage.ts';

function destination(overrides: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'dest-1',
    platform: 'facebook',
    name: 'Church page',
    rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    streamKey: 'FB-secret-key',
    enabled: true,
    status: 'live',
    statusMessage: 'Live',
    ...overrides,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('remembered stream destinations', () => {
  it('keeps settings but drops stream keys unless the host opted in', () => {
    const saved = serializeStreamDestinations([
      destination(),
      destination({ id: 'dest-2', platform: 'twitch', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app/', streamKey: 'live_123', rememberStreamKey: true }),
    ]);
    assert.deepEqual(saved, [
      { platform: 'facebook', name: 'Church page', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/', enabled: true },
      { platform: 'twitch', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app/', enabled: true, rememberStreamKey: true, streamKey: 'live_123' },
    ]);
    assert.ok(!JSON.stringify(saved).includes('FB-secret-key'));
    assert.ok(!JSON.stringify(saved).includes('status'));
  });

  it('never remembers single-use connected broadcasts', () => {
    const saved = serializeStreamDestinations([
      destination({
        platform: 'youtube',
        rememberStreamKey: true,
        connection: {
          provider: 'youtube',
          broadcastId: 'b1',
          watchUrl: 'https://www.youtube.com/watch?v=b1',
          studioUrl: 'https://studio.youtube.com/video/b1/livestreaming',
          privacyStatus: 'public',
        },
      }),
    ]);
    assert.deepEqual(saved, []);
  });

  it('restores valid entries and switches off destinations that lost their key', () => {
    const restored = restoreStreamDestinations([
      { platform: 'facebook', name: 'Church page', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/', enabled: true },
      { platform: 'twitch', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app/', enabled: true, rememberStreamKey: true, streamKey: ' live_123 ' },
      { platform: 'myspace', name: 'Bad', rtmpUrl: 'rtmp://x', enabled: true },
      { platform: 'custom', name: 'Bad URL', rtmpUrl: 'https://example.com', enabled: true },
      { platform: 'custom', name: '', rtmpUrl: 'rtmp://example.com/live', enabled: true },
      null,
    ]);
    assert.deepEqual(restored, [
      { platform: 'facebook', name: 'Church page', rtmpUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/', streamKey: '', enabled: false },
      { platform: 'twitch', name: 'Twitch', rtmpUrl: 'rtmp://live.twitch.tv/app/', streamKey: 'live_123', enabled: true, rememberStreamKey: true },
    ]);
  });

  it('caps restored entries and enabled destinations', () => {
    const many = Array.from({ length: MAX_SAVED_DESTINATIONS + 5 }, (_, index) => ({
      platform: 'custom',
      name: `Destination ${index}`,
      rtmpUrl: `rtmp://example.com/live${index}`,
      enabled: true,
      rememberStreamKey: true,
      streamKey: `key-${index}`,
    }));
    const restored = restoreStreamDestinations(many);
    assert.equal(restored.length, MAX_SAVED_DESTINATIONS);
    assert.equal(restored.filter((item) => item.enabled).length, 3);
  });

  it('round-trips through storage and tolerates corrupt or missing data', () => {
    const storage = memoryStorage();
    const written = saveStreamDestinations([destination({ rememberStreamKey: true })], storage);
    assert.equal(written, storage.values.get(STREAM_DESTINATIONS_STORAGE_KEY));
    assert.equal(loadSavedStreamDestinations(storage)[0].streamKey, 'FB-secret-key');

    assert.deepEqual(loadSavedStreamDestinations(memoryStorage({ [STREAM_DESTINATIONS_STORAGE_KEY]: '{not json' })), []);
    assert.deepEqual(loadSavedStreamDestinations(null), []);
    assert.equal(saveStreamDestinations([destination()], null), null);
    const failing = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    assert.equal(saveStreamDestinations([destination()], failing), null);
  });
});
