import type { RtmpRelayStartPayload } from '@studio/shared';
import { normalizeAudioConfig, normalizeVideoConfig } from './rtmp.js';

/**
 * When the studio's connection drops mid-broadcast, the media server keeps
 * the destinations' RTMP connections open on a "we'll be right back" slate
 * and the returning studio picks the same broadcast back up, so viewers see
 * a pause rather than the stream ending and a new one starting.
 */

/** Studio video silent this long: put the slate on air. */
export const STUDIO_INPUT_STALL_MS = 5_000;
/** How long the broadcast waits on the slate for the studio to return. */
export const STUDIO_RECONNECT_HOLD_MS = 3 * 60_000;

function destinationKey(payload: RtmpRelayStartPayload): string {
  return JSON.stringify(
    payload.destinations
      .map((destination) => [destination.id, destination.rtmpUrl, destination.streamKey])
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

/**
 * A reconnecting studio may continue a running broadcast only with the same
 * destinations and the same output settings: the replacement encoder must
 * produce a stream the destinations can take without a restart.
 */
export function isSameRelaySetup(running: RtmpRelayStartPayload, incoming: RtmpRelayStartPayload): boolean {
  if (destinationKey(running) !== destinationKey(incoming)) return false;
  const videoA = normalizeVideoConfig(running.video);
  const videoB = normalizeVideoConfig(incoming.video);
  const audioA = normalizeAudioConfig(running.audio);
  const audioB = normalizeAudioConfig(incoming.audio);
  return videoA.width === videoB.width
    && videoA.height === videoB.height
    && videoA.frameRate === videoB.frameRate
    && videoA.videoBitsPerSecond === videoB.videoBitsPerSecond
    && audioA.sampleRate === audioB.sampleRate
    && audioA.channelCount === audioB.channelCount
    && audioA.audioBitsPerSecond === audioB.audioBitsPerSecond;
}

/** Whether the slate should go on air now: the studio went quiet on a live broadcast. */
export function shouldShowSlate(options: {
  lastMediaAtMs: number;
  nowMs: number;
  hasLiveDestination: boolean;
  slateOnAir: boolean;
}): boolean {
  if (options.slateOnAir || !options.hasLiveDestination) return false;
  return options.nowMs - options.lastMediaAtMs >= STUDIO_INPUT_STALL_MS;
}
