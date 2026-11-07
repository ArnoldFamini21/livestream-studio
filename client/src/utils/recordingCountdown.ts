/** The longest countdown a guest will show, whatever a message says. */
export const MAX_RECORDING_COUNTDOWN_SECONDS = 10;

/** A whole number of seconds from 1 to 10, or null for "no countdown" (0, cancelled, nonsense). */
export function normalizeRecordingCountdownSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const seconds = Math.round(value);
  if (seconds <= 0) return null;
  return Math.min(MAX_RECORDING_COUNTDOWN_SECONDS, seconds);
}
