/**
 * What the host reads when the browser stops producing the broadcast. Plain
 * words: what happened, what the studio did, what to do.
 */
import type { RtmpRelayStats } from '../hooks/useRtmpRelay.ts';

/** Shown once each time the media watchdog fires and restarts the broadcast. */
export const RELAY_NOT_SENDING_NOTICE = 'The studio is not sending your broadcast. It is restarting it now.';

/** Stream Health while a stall is flagged. */
export const RELAY_NOT_SENDING_HEALTH = {
  label: 'Not sending',
  detail: 'Your browser is not producing the broadcast. The studio is restarting it.',
} as const;

/**
 * When the studio had to switch its sound output off to get the broadcast
 * running again. With no sound device the studio's own audio mix (sound
 * effects, background music, clips and videos) is not played on this computer.
 * Guests' voices are not part of that: they play through the page's video
 * elements, not through the studio's audio mix. The broadcast and the guests
 * still receive the whole mix.
 */
export const SOUND_OUTPUT_OFF_NOTICE =
  "Your computer's sound output stopped responding. To keep the broadcast going, the studio stopped playing its sound effects, music and clips on this computer. Your guests' voices are not changed. Viewers still hear everything.";

/** The small marker that stays while the output is off. */
export const SOUND_OUTPUT_OFF_MARKER = 'Sound effects, music and clips are not playing on this computer. Viewers still hear everything.';
export const SOUND_OUTPUT_RESTORE_LABEL = 'Turn sound back on';
export const SOUND_OUTPUT_RESTORING_LABEL = 'Turning sound on…';
export const SOUND_OUTPUT_RESTORE_FAILED = 'The sound output still does not respond. Sound stays off on this computer.';
export const SOUND_OUTPUT_RESTORED_NOTICE = 'Sound is back on.';

export type RelayStatusName = RtmpRelayStats['status'];

/** The broadcast was running and has now ended (stopped, or ended with an error). */
export function relayJustEnded(previous: RelayStatusName, next: RelayStatusName): boolean {
  const wasRunning = previous === 'connecting' || previous === 'live';
  return wasRunning && (next === 'idle' || next === 'error');
}
