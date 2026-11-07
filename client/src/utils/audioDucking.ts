/**
 * Auto ducking lowers background music and clip audio while someone on stage
 * is talking, the way a radio host's bed music dips under their voice. It
 * never lowers other people: a guest replying over the host stays at their own
 * volume.
 */

/** Speaking-detector level (0-100) that counts as speech. */
export const AUDIO_DUCKING_TRIGGER_LEVEL = 18;
/** Music/clip gain while ducked (about -12 dB). */
export const MUSIC_DUCKING_GAIN = 0.25;
/** How long music stays down after the last speech, so it does not pump between words. */
export const MUSIC_DUCKING_HOLD_MS = 800;
/** Web Audio time constants: dip quickly, come back slowly. */
export const MUSIC_DUCKING_ATTACK_SECONDS = 0.04;
export const MUSIC_DUCKING_RELEASE_SECONDS = 0.5;

function normalizeLevel(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Whether any of `participantIds` (or anyone, if omitted) is speaking. */
export function isSpeechPresent(
  participantAudioLevels: Record<string, number>,
  participantIds?: Iterable<string>
): boolean {
  const ids = participantIds ? Array.from(participantIds) : Object.keys(participantAudioLevels);
  return ids.some((id) => normalizeLevel(participantAudioLevels[id]) >= AUDIO_DUCKING_TRIGGER_LEVEL);
}

export interface MusicDuckingState {
  ducked: boolean;
  lastSpeechAt: number | null;
}

export const INITIAL_MUSIC_DUCKING_STATE: MusicDuckingState = { ducked: false, lastSpeechAt: null };

export function nextMusicDuckingState(
  state: MusicDuckingState,
  input: { enabled: boolean; speaking: boolean; now: number }
): MusicDuckingState {
  if (!input.enabled) return INITIAL_MUSIC_DUCKING_STATE;
  if (input.speaking) return { ducked: true, lastSpeechAt: input.now };
  if (!state.ducked || state.lastSpeechAt === null) return { ducked: false, lastSpeechAt: state.lastSpeechAt };
  if (input.now - state.lastSpeechAt < MUSIC_DUCKING_HOLD_MS) return state;
  return { ducked: false, lastSpeechAt: state.lastSpeechAt };
}

/** Milliseconds until a ducked state may release, or null when nothing is pending. */
export function getMusicDuckingReleaseDelay(state: MusicDuckingState, now: number): number | null {
  if (!state.ducked || state.lastSpeechAt === null) return null;
  return Math.max(0, MUSIC_DUCKING_HOLD_MS - (now - state.lastSpeechAt));
}
