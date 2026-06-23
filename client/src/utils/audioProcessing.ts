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
  };
}

export function createAudioTrackConstraints(
  deviceId?: string | null,
  preferences: Partial<AudioProcessingPreferences> = {}
): MediaTrackConstraints {
  const normalized = normalizeAudioProcessingPreferences(preferences);
  return {
    echoCancellation: normalized.echoCancellation,
    noiseSuppression: normalized.noiseSuppression,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}
