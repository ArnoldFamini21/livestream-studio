import { seekStepToTime } from './mixControls.ts';

/**
 * Where to seek when the pointer is released on the scrub bar, or null for
 * "do not seek". A tap on the thumb that does not move it changes nothing, so
 * it must not seek: the thumb sits on a rounded step, and seeking to it would
 * jump the music by a fraction of a second. Pressing on the bar or dragging
 * does change the step, and that is what seeks.
 */
export function getScrubReleaseSeek(movedToStep: number | null, duration: number | undefined | null): number | null {
  if (movedToStep === null) return null;
  return seekStepToTime(movedToStep, duration);
}
