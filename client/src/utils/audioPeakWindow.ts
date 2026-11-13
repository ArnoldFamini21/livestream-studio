/** The loudest level heard in the last few seconds, from a stream of meter readings. */

export const AUDIO_PEAK_WINDOW_MS = 8_000;
const SILENCE_FLOOR_DB = -120;

export function amplitudeToDb(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return SILENCE_FLOOR_DB;
  return Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(Math.min(1, amplitude)));
}

export class AudioPeakWindow {
  private readings: Array<{ at: number; db: number }> = [];

  constructor(private readonly windowMs = AUDIO_PEAK_WINDOW_MS) {}

  push(db: number, now = Date.now()): void {
    this.readings.push({ at: now, db });
    this.trim(now);
  }

  /** Null until a reading exists; a window with only silence reads as the floor. */
  peak(now = Date.now()): number | null {
    this.trim(now);
    if (this.readings.length === 0) return null;
    return this.readings.reduce((max, reading) => Math.max(max, reading.db), SILENCE_FLOOR_DB);
  }

  reset(): void {
    this.readings = [];
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.readings.length > 0 && this.readings[0].at < cutoff) this.readings.shift();
  }
}
