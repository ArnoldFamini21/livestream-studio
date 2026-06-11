import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_AUDIO_PROCESSING_PREFERENCES,
  readPreferredAudioProcessing,
  writePreferredAudioProcessing,
} from '../src/utils/mediaPreferences.ts';

class MemoryStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key) || '' : null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
});

describe('audio processing preferences', () => {
  it('defaults echo cancellation and noise suppression on', () => {
    assert.deepEqual(readPreferredAudioProcessing(), DEFAULT_AUDIO_PROCESSING_PREFERENCES);
  });

  it('round trips explicit join-screen audio processing choices through session storage', () => {
    writePreferredAudioProcessing({ echoCancellation: false, noiseSuppression: true });

    assert.deepEqual(readPreferredAudioProcessing(), {
      echoCancellation: false,
      noiseSuppression: true,
    });
  });

  it('falls back to defaults when session storage values are not booleans', () => {
    sessionStorage.setItem('preferredEchoCancellation', 'yes');
    sessionStorage.setItem('preferredNoiseSuppression', '');

    assert.deepEqual(readPreferredAudioProcessing(), DEFAULT_AUDIO_PROCESSING_PREFERENCES);
  });
});
