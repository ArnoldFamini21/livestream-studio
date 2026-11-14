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

export const RELAY_AUDIO_STUCK_TEST_MESSAGE =
  "Your computer's sound output is not responding, so the browser cannot produce the test stream. Check the sound output device or restart the browser, then start the test again.";
export const RELAY_NO_MEDIA_STOP_TEST_MESSAGE =
  'Your browser is not producing the test stream (no video or sound data came out of it). Reload the studio page and start the test again. If it happens again, restart the browser.';

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
 * Where the current unbroken flow of chunks began, for the whole relay (not one
 * transport: a reconnect after a socket drop does not break the flow). Call it
 * when a chunk is produced at nowMs; the flow is broken when the chunk before it
 * is RELAY_CHUNK_GAP_MS or more behind (or there was none).
 */
export function nextMediaFlowStart(input: {
  flowStartMs: number | null;
  previousChunkMs: number | null;
  nowMs: number;
}): number {
  const { flowStartMs, previousChunkMs, nowMs } = input;
  if (flowStartMs === null || previousChunkMs === null || nowMs - previousChunkMs >= RELAY_CHUNK_GAP_MS) return nowMs;
  return flowStartMs;
}

/**
 * The restarts still counted against the relay. They start again once chunks
 * have flowed for MEDIA_RESTARTS_RESET_AFTER_FLOW_MS in a row, wherever the
 * flow began (a reconnect in between does not hide a healthy stretch).
 */
export function restartsAfterFlow(restarts: number, flowStartMs: number | null, nowMs: number): number {
  const used = Number.isFinite(restarts) && restarts > 0 ? Math.floor(restarts) : 0;
  if (flowStartMs !== null && nowMs - flowStartMs >= MEDIA_RESTARTS_RESET_AFTER_FLOW_MS) return 0;
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
  /** The private test stream: the words say "test", not "broadcast". */
  test?: boolean;
}): RelayMediaStallAction {
  const { kind, audio } = input;
  const test = input.test === true;
  if (audio === 'stuck') {
    return { action: 'end', reason: 'sound-output-stuck', message: test ? RELAY_AUDIO_STUCK_TEST_MESSAGE : RELAY_AUDIO_STUCK_MESSAGE };
  }
  const used = Number.isFinite(input.restartsInARow) && input.restartsInARow > 0 ? Math.floor(input.restartsInARow) : 0;
  if (used >= MAX_MEDIA_RESTARTS_IN_A_ROW) {
    return { action: 'end', reason: 'no-media', message: test ? RELAY_NO_MEDIA_STOP_TEST_MESSAGE : RELAY_NO_MEDIA_STOP_MESSAGE };
  }
  if (audio === 'recovered') {
    return {
      action: 'restart',
      cause: 'sound-output-recovered',
      restartsInARow: used + 1,
      message: `The studio switched its sound output off so the ${test ? 'test' : 'broadcast'} can run. Restarting it now...`,
    };
  }
  return {
    action: 'restart',
    cause: 'plain',
    restartsInARow: used + 1,
    message: kind === 'no-first-chunk'
      ? `Your browser did not start producing the ${test ? 'test' : 'broadcast'}. Restarting it now...`
      : `Your browser stopped producing the ${test ? 'test' : 'broadcast'}. Restarting it now...`,
  };
}

export interface RelayMediaStallDeps {
  kind: RelayMediaStallKind;
  test?: boolean;
  /** When the watchdog fired, on the same clock as the chunk times. */
  firedAtMs: number;
  /** The program audio check, if the caller has one. */
  checkAudio?: () => Promise<{ state: ProgramAudioState }>;
  /** This transport is still the current one and nobody is ending the relay. Asked after the audio check. */
  stillWanted: () => boolean;
  /** When the recorder last produced a non-empty chunk. */
  lastChunkProducedAtMs: () => number | null;
  getRestarts: () => number;
  setRestarts: (restarts: number) => void;
}

export type RelayMediaStallOutcome =
  /** The relay moved on during the check (stopped, reconnected, replaced): do nothing. */
  | { outcome: 'abandoned' }
  /** Chunks came back during the check: the stall is over, look again later. */
  | { outcome: 'self-recovered' }
  | { outcome: 'act'; decision: RelayMediaStallAction };

/**
 * What the relay does after the watchdog fired: ask the audio check, make sure
 * the relay still wants this, and make sure the stall is not over, then decide.
 * A chunk that came back during the check cancels the restart (unless the check
 * itself just moved the sound output off: that restart is the wanted one).
 * Stores the restart count for a restart.
 */
export async function runRelayMediaStall(deps: RelayMediaStallDeps): Promise<RelayMediaStallOutcome> {
  let audio: RelayMediaAudioFinding = null;
  if (deps.checkAudio) {
    try {
      audio = (await deps.checkAudio()).state;
    } catch {
      audio = null;
    }
  }
  if (!deps.stillWanted()) return { outcome: 'abandoned' };

  const lastChunk = deps.lastChunkProducedAtMs();
  if (lastChunk !== null && lastChunk > deps.firedAtMs && audio !== 'recovered') {
    return { outcome: 'self-recovered' };
  }

  const decision = decideRelayMediaAction({
    kind: deps.kind,
    audio,
    restartsInARow: deps.getRestarts(),
    test: deps.test,
  });
  if (decision.action === 'restart') deps.setRestarts(decision.restartsInARow);
  return { outcome: 'act', decision };
}
