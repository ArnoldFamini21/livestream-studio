export interface AudioProcessingPreferences {
  echoCancellation: boolean;
  noiseSuppression: boolean;
}

const PREFERRED_ECHO_CANCELLATION_KEY = 'preferredEchoCancellation';
const PREFERRED_NOISE_SUPPRESSION_KEY = 'preferredNoiseSuppression';

export const DEFAULT_AUDIO_PROCESSING_PREFERENCES: AudioProcessingPreferences = {
  echoCancellation: true,
  noiseSuppression: true,
};

function readSessionBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = sessionStorage.getItem(key);
    if (value === 'true') return true;
    if (value === 'false') return false;
  } catch {
    // Ignore unavailable sessionStorage.
  }
  return fallback;
}

function writeSessionBoolean(key: string, value: boolean) {
  try {
    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore unavailable sessionStorage.
  }
}

export function readPreferredAudioProcessing(): AudioProcessingPreferences {
  return {
    echoCancellation: readSessionBoolean(
      PREFERRED_ECHO_CANCELLATION_KEY,
      DEFAULT_AUDIO_PROCESSING_PREFERENCES.echoCancellation
    ),
    noiseSuppression: readSessionBoolean(
      PREFERRED_NOISE_SUPPRESSION_KEY,
      DEFAULT_AUDIO_PROCESSING_PREFERENCES.noiseSuppression
    ),
  };
}

export function writePreferredAudioProcessing(preferences: AudioProcessingPreferences) {
  writeSessionBoolean(PREFERRED_ECHO_CANCELLATION_KEY, preferences.echoCancellation);
  writeSessionBoolean(PREFERRED_NOISE_SUPPRESSION_KEY, preferences.noiseSuppression);
}
