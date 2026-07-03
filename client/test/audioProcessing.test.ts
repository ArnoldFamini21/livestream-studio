import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAudioTrackConstraints,
  normalizeAudioProcessingPreferences,
} from '../src/utils/audioProcessing.ts';
import {
  getVoiceEnhancementProfile,
  getVoiceGateState,
  STUDIO_VOICE_ENHANCEMENT_PROFILE,
  STANDARD_VOICE_ENHANCEMENT_PROFILE,
} from '../src/utils/audioEnhancement.ts';

describe('audio processing constraints', () => {
  it('defaults echo cancellation, noise suppression, and voice cleanup on', () => {
    assert.deepEqual(normalizeAudioProcessingPreferences(), {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    });
  });

  it('preserves explicit audio processing choices', () => {
    assert.deepEqual(normalizeAudioProcessingPreferences({
      echoCancellation: false,
      noiseSuppression: true,
    }), {
      echoCancellation: false,
      noiseSuppression: true,
      voiceIsolation: true,
    });
  });

  it('builds microphone constraints with optional device targeting', () => {
    assert.deepEqual(createAudioTrackConstraints('mic-1', {
      echoCancellation: false,
      noiseSuppression: false,
      voiceIsolation: false,
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

  it('adds browser voice isolation hints when studio voice cleanup is enabled', () => {
    assert.deepEqual(createAudioTrackConstraints('mic-1', {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    }), {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      deviceId: { exact: 'mic-1' },
      voiceIsolation: { ideal: true },
      suppressLocalAudioPlayback: { ideal: true },
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      latency: { ideal: 0.02 },
    });
  });

  it('keeps explicit browser echo and suppression choices in advanced voice hints', () => {
    const constraints = createAudioTrackConstraints('mic-1', {
      echoCancellation: false,
      noiseSuppression: false,
      voiceIsolation: true,
    }) as MediaTrackConstraints & Record<string, unknown>;

    assert.equal(constraints.echoCancellation, false);
    assert.equal(constraints.noiseSuppression, false);
    assert.equal(constraints.googEchoCancellation, false);
    assert.equal(constraints.googNoiseSuppression, false);
    assert.equal(constraints.googHighpassFilter, true);
  });

  it('does not exact-match a device when using the browser default microphone', () => {
    assert.deepEqual(createAudioTrackConstraints('', {
      echoCancellation: true,
      noiseSuppression: false,
      voiceIsolation: false,
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

  it('uses the stronger studio voice gate profile when voice cleanup is enabled', () => {
    assert.equal(
      getVoiceEnhancementProfile({ echoCancellation: true, noiseSuppression: true, voiceIsolation: true }),
      STUDIO_VOICE_ENHANCEMENT_PROFILE
    );
    assert.equal(
      getVoiceEnhancementProfile({ echoCancellation: true, noiseSuppression: true, voiceIsolation: false }),
      STANDARD_VOICE_ENHANCEMENT_PROFILE
    );
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

  it('attenuates steady background noise more aggressively in studio voice mode', () => {
    const standard = getVoiceGateState(0.008, 0.012, STANDARD_VOICE_ENHANCEMENT_PROFILE);
    const studio = getVoiceGateState(0.008, 0.012, STUDIO_VOICE_ENHANCEMENT_PROFILE);

    assert.equal(standard.open, false);
    assert.equal(studio.open, false);
    assert.ok(studio.targetGain < standard.targetGain);
  });
});
