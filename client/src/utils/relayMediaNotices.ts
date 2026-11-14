/**
 * What the host reads when the browser stops producing the broadcast. Plain
 * words: what happened, what the studio did, what to do.
 */
import type { RtmpRelayStats } from '../hooks/useRtmpRelay.ts';

/** Shown once each time the media watchdog fires and restarts the broadcast. */
export const RELAY_NOT_SENDING_NOTICE = 'The studio is not sending your broadcast. It is restarting it now.';
/** The same for the private test stream. */
export const RELAY_NOT_SENDING_TEST_NOTICE = 'The studio is not sending your test stream. It is restarting it now.';

export function relayNotSendingNotice(test: boolean): string {
  return test ? RELAY_NOT_SENDING_TEST_NOTICE : RELAY_NOT_SENDING_NOTICE;
}

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
 * elements, not through the studio's audio mix, so the studio does not switch
 * them off (if the computer's sound device itself is dead, the host cannot hear
 * them either; that is the device, not the studio). The broadcast and the
 * guests still receive the whole mix.
 */
export const SOUND_OUTPUT_OFF_NOTICE =
  "Your computer's sound output stopped responding. To keep the broadcast going, the studio stopped playing its sound effects, music and clips on this computer. Guests' voices are played separately and are not switched off by the studio. Viewers still hear everything. When the sound output works again, press \"Turn sound back on\".";
/** The same for the private test stream (there are no viewers). */
export const SOUND_OUTPUT_OFF_TEST_NOTICE =
  "Your computer's sound output stopped responding. To keep the test going, the studio stopped playing its sound effects, music and clips on this computer. Guests' voices are played separately and are not switched off by the studio. When the sound output works again, press \"Turn sound back on\".";

export function soundOutputOffNotice(test: boolean): string {
  return test ? SOUND_OUTPUT_OFF_TEST_NOTICE : SOUND_OUTPUT_OFF_NOTICE;
}

/** The small marker that stays while the output is off and a broadcast is running. */
export const SOUND_OUTPUT_OFF_MARKER = 'Sound effects, music and clips are not playing on this computer. Viewers still hear everything. Check the sound output device, then press "Turn sound back on".';
/** The marker when no broadcast is running (nobody is watching, so it says nothing about viewers). */
export const SOUND_OUTPUT_OFF_IDLE_MARKER = 'Sound is off on this computer (sound effects, music and clips). Check the sound output device, then press "Turn sound back on".';

export function soundOutputOffMarker(broadcastRunning: boolean): string {
  return broadcastRunning ? SOUND_OUTPUT_OFF_MARKER : SOUND_OUTPUT_OFF_IDLE_MARKER;
}

export const SOUND_OUTPUT_RESTORE_LABEL = 'Turn sound back on';
export const SOUND_OUTPUT_RESTORING_LABEL = 'Turning sound on…';
export const SOUND_OUTPUT_RESTORE_FAILED = 'The sound output still does not respond. Sound stays off on this computer.';
export const SOUND_OUTPUT_RESTORED_NOTICE = 'Sound is back on.';

export type RelayStatusName = RtmpRelayStats['status'];

/** A relay is running: connecting, or live. */
export function isRelayRunning(status: RelayStatusName): boolean {
  return status === 'connecting' || status === 'live';
}

/**
 * Time for the quiet try at turning the sound back on: the sound output is off
 * and no broadcast runs. A relay in "error" while the studio still counts as
 * live (a recorder error that did not end the broadcast) is still running.
 */
export function shouldRestoreSoundQuietly(input: {
  relayStatus: RelayStatusName;
  studioLive: boolean;
  soundOutputOff: boolean;
}): boolean {
  return input.soundOutputOff && !input.studioLive && !isRelayRunning(input.relayStatus);
}
