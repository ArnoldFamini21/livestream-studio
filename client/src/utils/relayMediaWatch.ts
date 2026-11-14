/**
 * The media watchdog for the live relay.
 *
 * The studio's browser is the program: a MediaRecorder turns the canvas and
 * the Web Audio mix into chunks, and the chunks go to the media server. If the
 * recorder never produces a chunk (or stops producing them), nothing leaves
 * the browser, yet the relay socket is fine and the studio still said LIVE.
 *
 * This module only decides. The clock comes in as an argument, so every rule
 * can be tested without timers. useRtmpRelay owns the timers and acts on the
 * answers.
 *
 * What counts is when the recorder PRODUCED its last non-empty chunk, not when
 * a chunk was sent: a slow uplink is handled elsewhere (the backlog rule).
 */
import type { ProgramAudioState } from '../audio/programAudioClock.ts';

/** No chunk this long after the recorder started: it is not producing at all. */
export const RELAY_NO_FIRST_CHUNK_MS = 8_000;
/** No chunk this long after an earlier one: the recorder stopped producing. */
export const RELAY_CHUNK_GAP_MS = 10_000;
/** How often the relay looks (the recorder slices every second). */
export const RELAY_MEDIA_WATCH_POLL_MS = 1_000;
/** Restarts in a row for this cause before the relay ends instead. */
export const MAX_MEDIA_RESTARTS_IN_A_ROW = 2;
/** The count starts again once chunks have flowed this long. */
export const MEDIA_RESTARTS_RESET_AFTER_FLOW_MS = 60_000;

export const RELAY_AUDIO_STUCK_MESSAGE =
  "Your computer's sound output is not responding, so the browser cannot produce the broadcast. Check the sound output device or restart the browser, then go live again.";
export const RELAY_NO_MEDIA_STOP_MESSAGE =
  'Your browser is not producing the broadcast (no video or sound data came out of it). Reload the studio page and go live again. If it happens again, restart the browser.';

export type RelayMediaStallKind = 'no-first-chunk' | 'stopped';
export type RelayMediaWatchVerdict = 'fine' | RelayMediaStallKind;

export interface RelayMediaWatchInput {
  nowMs: number;
  /** When this transport's recorder started; null before it has. */
  recorderStartedAtMs: number | null;
  /** When this recorder last produced a non-empty chunk; null if it never has. */
  lastChunkProducedAtMs: number | null;
  /** The media server answered "session-started". */
  sessionStarted: boolean;
  /** The host (or the studio) is ending the relay on purpose. */
  stoppingOnPurpose: boolean;
  /** A reconnect is waiting to run: there is no recorder to blame. */
  reconnectWaiting: boolean;
  /** This transport is still the relay's current one. */
  transportCurrent: boolean;
}

export function decideRelayMediaWatch(input: RelayMediaWatchInput): RelayMediaWatchVerdict {
  const { nowMs, recorderStartedAtMs, lastChunkProducedAtMs } = input;
  if (!input.sessionStarted || input.stoppingOnPurpose || input.reconnectWaiting || !input.transportCurrent) return 'fine';
  if (recorderStartedAtMs === null || !Number.isFinite(recorderStartedAtMs) || !Number.isFinite(nowMs)) return 'fine';

  // A chunk from before this recorder started belongs to an older one.
  const lastChunk = lastChunkProducedAtMs !== null && Number.isFinite(lastChunkProducedAtMs) && lastChunkProducedAtMs >= recorderStartedAtMs
    ? lastChunkProducedAtMs
    : null;

  if (lastChunk === null) {
    return nowMs - recorderStartedAtMs >= RELAY_NO_FIRST_CHUNK_MS ? 'no-first-chunk' : 'fine';
  }
  return nowMs - lastChunk >= RELAY_CHUNK_GAP_MS ? 'stopped' : 'fine';
}

/**
 * Restarts already used for this cause. They start again once the transport
 * that just stalled had produced chunks for MEDIA_RESTARTS_RESET_AFTER_FLOW_MS
 * (from its first chunk to its last).
 */
export function getMediaRestartsInARow(input: {
  restarts: number;
  firstChunkProducedAtMs: number | null;
  lastChunkProducedAtMs: number | null;
}): number {
  const { restarts, firstChunkProducedAtMs, lastChunkProducedAtMs } = input;
  const used = Number.isFinite(restarts) && restarts > 0 ? Math.floor(restarts) : 0;
  if (
    firstChunkProducedAtMs !== null
    && lastChunkProducedAtMs !== null
    && lastChunkProducedAtMs - firstChunkProducedAtMs >= MEDIA_RESTARTS_RESET_AFTER_FLOW_MS
  ) {
    return 0;
  }
  return used;
}

/** What the program audio check found; null when the caller has no check. */
export type RelayMediaAudioFinding = ProgramAudioState | null;

export type RelayMediaStallAction =
  | { action: 'end'; reason: 'sound-output-stuck' | 'no-media'; message: string }
  | {
    action: 'restart';
    cause: 'sound-output-recovered' | 'plain';
    /** The restart count after this one. */
    restartsInARow: number;
    message: string;
  };

/** What to do now that the verdict is not "fine", given what the audio check found. */
export function decideRelayMediaAction(input: {
  kind: RelayMediaStallKind;
  audio: RelayMediaAudioFinding;
  restartsInARow: number;
}): RelayMediaStallAction {
  const { kind, audio } = input;
  if (audio === 'stuck') {
    return { action: 'end', reason: 'sound-output-stuck', message: RELAY_AUDIO_STUCK_MESSAGE };
  }
  const used = Number.isFinite(input.restartsInARow) && input.restartsInARow > 0 ? Math.floor(input.restartsInARow) : 0;
  if (used >= MAX_MEDIA_RESTARTS_IN_A_ROW) {
    return { action: 'end', reason: 'no-media', message: RELAY_NO_MEDIA_STOP_MESSAGE };
  }
  if (audio === 'recovered') {
    return {
      action: 'restart',
      cause: 'sound-output-recovered',
      restartsInARow: used + 1,
      message: 'The studio switched its sound output off so the broadcast can run. Restarting the broadcast now...',
    };
  }
  return {
    action: 'restart',
    cause: 'plain',
    restartsInARow: used + 1,
    message: kind === 'no-first-chunk'
      ? 'Your browser did not start producing the broadcast. Restarting it now...'
      : 'Your browser stopped producing the broadcast. Restarting it now...',
  };
}
