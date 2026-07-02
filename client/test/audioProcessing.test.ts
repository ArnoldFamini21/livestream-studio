import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAudioTrackConstraints,
  normalizeAudioProcessingPreferences,
} from '../src/utils/audioProcessing.ts';
import { getVoiceGateState } from '../src/utils/audioEnhancement.ts';

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
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0.02 },
      deviceId: { exact: 'mic-1' },
    });
  });

  it('does not exact-match a device when using the browser default microphone', () => {
    assert.deepEqual(createAudioTrackConstraints('', {
      echoCancellation: true,
      noiseSuppression: false,
    }), {
      echoCancellation: { ideal: true },
      noiseSuppression: false,
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0.02 },
    });
  });

  it('keeps the voice gate open for speech above the adaptive noise floor', () => {
    const state = getVoiceGateState(0.08, 0.012);

    assert.equal(state.open, true);
    assert.equal(state.targetGain, 1);
  });

  it('reduces mic gain when input stays near the room noise floor', () => {
    const state = getVoiceGateState(0.008, 0.012);

    assert.equal(state.open, false);
    assert.ok(state.targetGain < 1);
    assert.ok(state.noiseFloor > 0);
  });
});
