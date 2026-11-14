import type { RtmpRelayStartPayload } from '@studio/shared';
import { destinationSetKey } from './relayRekey.js';
import { getRelayVideoMode, normalizeAudioConfig, normalizeVideoConfig } from './rtmp.js';

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

/**
 * The hold time of this process: 3 minutes unless STUDIO_RECONNECT_HOLD_SECONDS
 * names a shorter one (for local and automated checks). A longer or invalid
 * value is ignored, so a mistake can never lengthen or break the hold.
 */
export function getStudioReconnectHoldMs(env: Record<string, string | undefined>): number {
  const seconds = Number(env.STUDIO_RECONNECT_HOLD_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds * 1000 >= STUDIO_RECONNECT_HOLD_MS) return STUDIO_RECONNECT_HOLD_MS;
  return seconds * 1000;
}

/**
 * A reconnecting studio may continue a running broadcast only with the same
 * places to stream to (the RTMP URL and stream key pairs, compared exactly,
 * in any order; the studio's own destination ids are ignored, see
 * relayRekey.ts) and the same output settings: the replacement encoder must
 * produce a stream the destinations can take without a restart.
 */
export function isSameRelaySetup(running: RtmpRelayStartPayload, incoming: RtmpRelayStartPayload): boolean {
  // A test is never continued as a broadcast, nor a broadcast as a test.
  if (Boolean(running.test) !== Boolean(incoming.test)) return false;
  if (destinationSetKey(running.destinations) !== destinationSetKey(incoming.destinations)) return false;
  const videoA = normalizeVideoConfig(running.video);
  const videoB = normalizeVideoConfig(incoming.video);
  const audioA = normalizeAudioConfig(running.audio);
  const audioB = normalizeAudioConfig(incoming.audio);
  // A copied browser stream and a server re-encode differ in size and codec setup.
  if (getRelayVideoMode(running.encoding) !== getRelayVideoMode(incoming.encoding)) return false;
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
