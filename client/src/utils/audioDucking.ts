export const AUDIO_DUCKING_TRIGGER_LEVEL = 18;
export const AUDIO_DUCKING_MIN_LEAD = 6;
export const AUDIO_DUCKING_ATTENUATION = 0.45;

export interface AudioDuckingOptions {
  enabled: boolean;
  participantVolumes: Record<string, number>;
  participantAudioLevels: Record<string, number>;
  participantIds?: Iterable<string>;
}

function clamp01(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value ?? 1));
}

function normalizeLevel(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value ?? 0));
}

function getCandidateIds(options: AudioDuckingOptions): string[] {
  if (options.participantIds) {
    return Array.from(new Set(Array.from(options.participantIds).filter(Boolean)));
  }
  return Array.from(new Set([
    ...Object.keys(options.participantVolumes),
    ...Object.keys(options.participantAudioLevels),
  ]));
}

export function getAudioDuckingSpeakerId(options: Pick<AudioDuckingOptions, 'participantAudioLevels' | 'participantIds'>): string | null {
  const ids = options.participantIds
    ? Array.from(new Set(Array.from(options.participantIds).filter(Boolean)))
    : Object.keys(options.participantAudioLevels);

  let topId: string | null = null;
  let topLevel = 0;
  let secondLevel = 0;

  for (const id of ids) {
    const level = normalizeLevel(options.participantAudioLevels[id]);
    if (level > topLevel) {
      secondLevel = topLevel;
      topLevel = level;
      topId = id;
    } else if (level > secondLevel) {
      secondLevel = level;
    }
  }

  if (!topId || topLevel < AUDIO_DUCKING_TRIGGER_LEVEL) return null;
  if (topLevel - secondLevel < AUDIO_DUCKING_MIN_LEAD) return null;
  return topId;
}

export function getDuckedParticipantVolumes(options: AudioDuckingOptions): Record<string, number> {
  const ids = getCandidateIds(options);
  const speakerId = options.enabled ? getAudioDuckingSpeakerId({
    participantAudioLevels: options.participantAudioLevels,
    participantIds: ids,
  }) : null;

  const volumes: Record<string, number> = {};
  for (const id of ids) {
    const baseVolume = clamp01(options.participantVolumes[id]);
    volumes[id] = speakerId && id !== speakerId
      ? Math.round(baseVolume * AUDIO_DUCKING_ATTENUATION * 1000) / 1000
      : baseVolume;
  }
  return volumes;
}
