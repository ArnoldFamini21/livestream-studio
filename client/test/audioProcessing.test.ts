import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAudioTrackConstraints,
  normalizeAudioProcessingPreferences,
} from '../src/utils/audioProcessing.ts';

describe('audio processing constraints', () => {
  it('defaults echo cancellation and noise suppression on', () => {
    assert.deepEqual(normalizeAudioProcessingPreferences(), {
      echoCancellation: true,
      noiseSuppression: true,
    });
  });

  it('preserves explicit audio processing choices', () => {
    assert.deepEqual(normalizeAudioProcessingPreferences({
      echoCancellation: false,
      noiseSuppression: true,
    }), {
      echoCancellation: false,
      noiseSuppression: true,
    });
  });

  it('builds microphone constraints with optional device targeting', () => {
    assert.deepEqual(createAudioTrackConstraints('mic-1', {
      echoCancellation: false,
      noiseSuppression: false,
    }), {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
      deviceId: { exact: 'mic-1' },
    });
  });

  it('does not exact-match a device when using the browser default microphone', () => {
    assert.deepEqual(createAudioTrackConstraints('', {
      echoCancellation: true,
      noiseSuppression: false,
    }), {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    });
  });
});
