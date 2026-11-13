/**
 * Pure rules for the program-mix controls: the screen-share volume slider and
 * the background music transport (times and scrubbing). No Web Audio or DOM
 * here, so the rules run in node tests.
 */

/** Slider percent (0..100) as a linear gain (0..1). Bad input is 100%. */
export function percentToGain(percent: number | undefined | null): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 1;
  return clampPercent(percent) / 100;
}

/** Linear gain (0..1) as a whole slider percent. Bad input is 100. */
export function gainToPercent(gain: number | undefined | null): number {
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return 100;
  return clampPercent(gain * 100);
}

/** Clamp to 0..100 and round to a whole percent. Bad input is 100. */
export function clampPercent(percent: number | undefined | null): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 100;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

/** A saved screen-share gain read back from storage: anything unusable is full volume. */
export function parseSavedGain(raw: unknown): number {
  if (typeof raw === 'number') return percentToGain(raw * 100);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return percentToGain(parsed * 100);
  }
  return 1;
}

/** True when the element reports a real, finite length (not a live stream, not still loading). */
export function hasKnownDuration(duration: number | undefined | null): duration is number {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
}

function wholeSeconds(seconds: number | undefined | null): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds);
}

/** m:ss, or h:mm:ss from one hour. Unusable input is 0:00. */
export function formatClock(seconds: number | undefined | null): string {
  const total = wholeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Keep a seek target inside the track. Without a known duration only the lower bound applies. */
export function clampSeekTime(seconds: number, duration: number | undefined | null): number {
  const wanted = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (!hasKnownDuration(duration)) return wanted;
  return Math.min(wanted, duration);
}

/** Scrub bar position (0..1000, finer than whole percents) to seconds. */
export const SEEK_STEPS = 1000;

export function seekStepToTime(step: number, duration: number | undefined | null): number {
  if (!hasKnownDuration(duration)) return 0;
  const clamped = Math.min(SEEK_STEPS, Math.max(0, Number.isFinite(step) ? step : 0));
  return clampSeekTime((clamped / SEEK_STEPS) * duration, duration);
}

export function timeToSeekStep(seconds: number, duration: number | undefined | null): number {
  if (!hasKnownDuration(duration)) return 0;
  const time = clampSeekTime(seconds, duration);
  return Math.round((time / duration) * SEEK_STEPS);
}

export interface MusicTransportView {
  /** Elapsed time text, always shown. */
  elapsed: string;
  /** Total length text, or null when the length is not known. */
  total: string | null;
  /** Remaining time text like "-1:15", or null when the length is not known. */
  remaining: string | null;
  /** The scrub bar works only with a known length. */
  canSeek: boolean;
  /** Spoken value for the scrub bar. */
  valueText: string;
}

export function getMusicTransportView(input: { currentTime: number; duration: number }): MusicTransportView {
  const known = hasKnownDuration(input.duration);
  const elapsedSeconds = known
    ? clampSeekTime(input.currentTime, input.duration)
    : wholeSeconds(input.currentTime);
  const elapsed = formatClock(elapsedSeconds);
  if (!known) {
    return { elapsed, total: null, remaining: null, canSeek: false, valueText: `${elapsed} elapsed` };
  }
  const total = formatClock(input.duration);
  const remaining = `-${formatClock(Math.max(0, Math.ceil(input.duration - elapsedSeconds)))}`;
  return {
    elapsed,
    total,
    remaining,
    canSeek: true,
    valueText: `${elapsed} of ${total}, ${remaining.slice(1)} remaining`,
  };
}

export interface ScreenShareOnProgram {
  /** The screen tile is on the program (the audio follows the tile). */
  onProgram: boolean;
  /** The share has a live audio track the program mix can carry. */
  hasAudio: boolean;
}

export type ScreenVolumeView =
  | { kind: 'hidden' }
  /** An operator whose browser does not run the program: the runner sets the volume. */
  | { kind: 'set-by-program-runner' }
  | { kind: 'no-sound' }
  | { kind: 'slider' };

/**
 * Which screen-volume control to show in the People panel. Guests never see
 * it; nothing shows without a share on the program. Only the browser that runs
 * the program mix (the stage owner) mixes it, so only that one gets a slider.
 */
export function getScreenVolumeView(input: {
  isOperator: boolean;
  runsProgram: boolean;
  shares: Iterable<ScreenShareOnProgram>;
}): ScreenVolumeView {
  if (!input.isOperator) return { kind: 'hidden' };
  const onProgram = [...input.shares].filter((share) => share.onProgram);
  if (onProgram.length === 0) return { kind: 'hidden' };
  if (!input.runsProgram) return { kind: 'set-by-program-runner' };
  return onProgram.some((share) => share.hasAudio) ? { kind: 'slider' } : { kind: 'no-sound' };
}

/** True when the stream carries at least one live audio track. */
export function streamHasLiveAudio(
  stream: { getAudioTracks(): Array<{ readyState: string }> } | null | undefined
): boolean {
  return Boolean(stream?.getAudioTracks().some((track) => track.readyState === 'live'));
}
