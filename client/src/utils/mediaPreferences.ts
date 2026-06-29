export interface AudioProcessingPreferences {
  echoCancellation: boolean;
  noiseSuppression: boolean;
}

export type VideoQualityPresetId = '720p' | '1080p' | '4k';

export interface VideoQualityPreset {
  id: VideoQualityPresetId;
  label: string;
  description: string;
  width: number;
  height: number;
  frameRate: number;
}

const PREFERRED_ECHO_CANCELLATION_KEY = 'preferredEchoCancellation';
const PREFERRED_NOISE_SUPPRESSION_KEY = 'preferredNoiseSuppression';
const PREFERRED_VIDEO_QUALITY_KEY = 'preferredVideoQuality';

export const DEFAULT_AUDIO_PROCESSING_PREFERENCES: AudioProcessingPreferences = {
  echoCancellation: true,
  noiseSuppression: true,
};

export const DEFAULT_VIDEO_QUALITY_PRESET_ID: VideoQualityPresetId = '1080p';

export const VIDEO_QUALITY_PRESETS: readonly VideoQualityPreset[] = [
  {
    id: '720p',
    label: '720p',
    description: 'Lighter CPU and bandwidth',
    width: 1280,
    height: 720,
    frameRate: 30,
  },
  {
    id: '1080p',
    label: '1080p',
    description: 'Recommended HD',
    width: 1920,
    height: 1080,
    frameRate: 30,
  },
  {
    id: '4k',
    label: '4K',
    description: 'Best local recording quality',
    width: 3840,
    height: 2160,
    frameRate: 30,
  },
];

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

function readSessionString(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionBoolean(key: string, value: boolean) {
  try {
    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore unavailable sessionStorage.
  }
}

function writeSessionString(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
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

export function normalizeVideoQualityPresetId(value: unknown): VideoQualityPresetId {
  return VIDEO_QUALITY_PRESETS.some((preset) => preset.id === value)
    ? value as VideoQualityPresetId
    : DEFAULT_VIDEO_QUALITY_PRESET_ID;
}

export function getVideoQualityPreset(id: unknown = DEFAULT_VIDEO_QUALITY_PRESET_ID): VideoQualityPreset {
  const normalizedId = normalizeVideoQualityPresetId(id);
  return VIDEO_QUALITY_PRESETS.find((preset) => preset.id === normalizedId) || VIDEO_QUALITY_PRESETS[1];
}

export function readPreferredVideoQuality(): VideoQualityPresetId {
  return normalizeVideoQualityPresetId(readSessionString(PREFERRED_VIDEO_QUALITY_KEY));
}

export function writePreferredVideoQuality(presetId: VideoQualityPresetId) {
  writeSessionString(PREFERRED_VIDEO_QUALITY_KEY, normalizeVideoQualityPresetId(presetId));
}

export function createVideoTrackConstraints(
  deviceId?: string | null,
  presetId: VideoQualityPresetId = DEFAULT_VIDEO_QUALITY_PRESET_ID
): MediaTrackConstraints {
  const preset = getVideoQualityPreset(presetId);
  return {
    width: { ideal: preset.width },
    height: { ideal: preset.height },
    frameRate: { ideal: preset.frameRate },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}
