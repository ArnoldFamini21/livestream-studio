import {
  DEFAULT_AUDIO_PROCESSING_PREFERENCES,
  type AudioProcessingPreferences,
} from './mediaPreferences.ts';

export function normalizeAudioProcessingPreferences(
  preferences: Partial<AudioProcessingPreferences> = {}
): AudioProcessingPreferences {
  return {
    echoCancellation: preferences.echoCancellation ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.echoCancellation,
    noiseSuppression: preferences.noiseSuppression ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.noiseSuppression,
    voiceIsolation: preferences.voiceIsolation ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.voiceIsolation,
  };
}

function getAdvancedVoiceConstraints(preferences: AudioProcessingPreferences): Record<string, unknown> {
  if (!preferences.voiceIsolation) return {};
  return {
    voiceIsolation: { ideal: true },
    suppressLocalAudioPlayback: { ideal: true },
    googEchoCancellation: preferences.echoCancellation,
    googAutoGainControl: true,
    googNoiseSuppression: preferences.noiseSuppression,
    googHighpassFilter: true,
  };
}

export function createAudioTrackConstraints(
  deviceId?: string | null,
  preferences: Partial<AudioProcessingPreferences> = {}
): MediaTrackConstraints {
  const normalized = normalizeAudioProcessingPreferences(preferences);
  const constraints: MediaTrackConstraints = {
    echoCancellation: normalized.echoCancellation ? { ideal: true } : false,
    noiseSuppression: normalized.noiseSuppression ? { ideal: true } : false,
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
  return {
    ...constraints,
    ...getAdvancedVoiceConstraints(normalized),
    latency: { ideal: 0.02 },
  } as MediaTrackConstraints;
}
