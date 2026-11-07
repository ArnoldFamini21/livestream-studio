import {
  DEFAULT_AUDIO_PROCESSING_PREFERENCES,
  type AudioProcessingPreferences,
} from './mediaPreferences.ts';
import { isAiNoiseRemovalSupported } from './aiNoiseRemoval.ts';

export function normalizeAudioProcessingPreferences(
  preferences: Partial<AudioProcessingPreferences> = {}
): AudioProcessingPreferences {
  return {
    echoCancellation: preferences.echoCancellation ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.echoCancellation,
    noiseSuppression: preferences.noiseSuppression ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.noiseSuppression,
    voiceIsolation: preferences.voiceIsolation ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.voiceIsolation,
    aiNoiseRemoval: preferences.aiNoiseRemoval ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.aiNoiseRemoval,
    musicMode: preferences.musicMode ?? DEFAULT_AUDIO_PROCESSING_PREFERENCES.musicMode,
  };
}

/**
 * Whether the RNNoise stage will actually run on the processed mic. Music
 * mode is "original sound", so it wins over every voice cleanup stage.
 */
export function usesAiNoiseRemoval(
  preferences: AudioProcessingPreferences,
  supported: boolean = isAiNoiseRemovalSupported()
): boolean {
  return preferences.aiNoiseRemoval && !preferences.musicMode && supported;
}

export interface AudioTrackConstraintOptions {
  /** Defaults to runtime detection (AudioWorklet + WebAssembly). */
  aiNoiseRemovalSupported?: boolean;
}

function getAdvancedVoiceConstraints(
  preferences: AudioProcessingPreferences,
  browserNoiseSuppression: boolean
): Record<string, unknown> {
  if (!preferences.voiceIsolation) return {};
  return {
    voiceIsolation: { ideal: true },
    suppressLocalAudioPlayback: { ideal: true },
    googEchoCancellation: preferences.echoCancellation,
    googAutoGainControl: true,
    googNoiseSuppression: browserNoiseSuppression,
    googHighpassFilter: true,
  };
}

/** Music / original sound: every browser voice stage off, stereo when the device has it. */
function createMusicModeConstraints(deviceId?: string | null): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    voiceIsolation: false,
    googEchoCancellation: false,
    googAutoGainControl: false,
    googNoiseSuppression: false,
    googHighpassFilter: false,
    latency: { ideal: 0.02 },
  } as MediaTrackConstraints;
}

export function createAudioTrackConstraints(
  deviceId?: string | null,
  preferences: Partial<AudioProcessingPreferences> = {},
  options: AudioTrackConstraintOptions = {}
): MediaTrackConstraints {
  const normalized = normalizeAudioProcessingPreferences(preferences);
  if (normalized.musicMode) return createMusicModeConstraints(deviceId);
  // RNNoise replaces the browser's suppressor; running both smears speech.
  const aiNoiseRemoval = usesAiNoiseRemoval(
    normalized,
    options.aiNoiseRemovalSupported ?? isAiNoiseRemovalSupported()
  );
  const browserNoiseSuppression = normalized.noiseSuppression && !aiNoiseRemoval;
  const constraints: MediaTrackConstraints = {
    echoCancellation: normalized.echoCancellation ? { ideal: true } : false,
    noiseSuppression: browserNoiseSuppression ? { ideal: true } : false,
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    sampleSize: { ideal: 16 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
  return {
    ...constraints,
    ...getAdvancedVoiceConstraints(normalized, browserNoiseSuppression),
    latency: { ideal: 0.02 },
  } as MediaTrackConstraints;
}
