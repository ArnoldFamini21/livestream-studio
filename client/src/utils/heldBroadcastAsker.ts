import { resolveMediaHttpUrl } from './apiClient.ts';
import { HELD_BROADCAST_ASK_INTERVAL_MS, parseHeldBroadcastAnswer, type HeldBroadcastAnswer } from './heldBroadcastState.ts';

/**
 * Asks the media server about the studio's own room. Once on start; while a
 * hold is reported, again every ~10 s; never when nothing is held.
 *
 * A failed ask is tried again, because the returning host has at most three
 * minutes and the connection that dropped the broadcast is often still
 * unsteady. Before any answer, a failed ask is retried quickly at first and
 * then every 30 s, for about three minutes in all, and then the asking ends:
 * a hold that existed when the studio opened cannot outlast that. While a hold
 * is known the retries go on every ~10 s (the countdown carries on locally
 * meanwhile). An old media server (route not found) ends the asking at once.
 */

/**
 * The waits before each retry of an ask that failed before any hold was known.
 * Together a little under three minutes, the longest a broadcast is held.
 */
export const HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000,
];

/** One ask may take this long; a request that hangs counts as failed and is retried. */
export const HELD_BROADCAST_ASK_TIMEOUT_MS = 8_000;

export class HeldBroadcastUnsupportedError extends Error {
  constructor() {
    super('The media server does not know the held broadcast request.');
  }
}

export async function fetchHeldBroadcast(options: {
  roomId: string;
  token: string;
  mediaHttpUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<HeldBroadcastAnswer> {
  const base = (options.mediaHttpUrl ?? resolveMediaHttpUrl()).trim().replace(/\/+$/, '');
  // No media server is set up: nothing can be on hold, and asking again would not change that.
  if (!base) throw new HeldBroadcastUnsupportedError();

  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.timeoutMs ?? HELD_BROADCAST_ASK_TIMEOUT_MS);

  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/rtmp/held?roomId=${encodeURIComponent(options.roomId)}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${options.token}` },
      signal: controller.signal,
    });
    // A media server from before this request answers "not found".
    if (response.status === 404 || response.status === 405) throw new HeldBroadcastUnsupportedError();
    if (!response.ok) throw new Error(`The media server answered ${response.status}.`);
    const answer = parseHeldBroadcastAnswer(await response.json().catch(() => null));
    // The body is read under the same time limit; a body cut off by it is a failed ask, not an old server.
    if (!answer && timedOut) throw new Error('The media server did not answer in time.');
    if (!answer) throw new HeldBroadcastUnsupportedError();
    return answer;
  } catch (error) {
    if (timedOut && !(error instanceof HeldBroadcastUnsupportedError)) {
      throw new Error('The media server did not answer in time.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export interface HeldBroadcastAskerOptions {
  ask: () => Promise<HeldBroadcastAnswer>;
  onAnswer: (answer: HeldBroadcastAnswer) => void;
  /** Called for a failed ask; the asker decides about retrying. */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  /** The waits before each retry of a failed ask while no hold is known; empty means no retry. */
  firstAskRetryDelaysMs?: readonly number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface HeldBroadcastAsker {
  /** `heldKnown`: the studio already shows a hold (a reconnect), so a failed ask is retried for as long as it shows. */
  start: (heldKnown?: boolean) => void;
  stop: () => void;
  readonly running: boolean;
}

export function createHeldBroadcastAsker(options: HeldBroadcastAskerOptions): HeldBroadcastAsker {
  const intervalMs = options.intervalMs ?? HELD_BROADCAST_ASK_INTERVAL_MS;
  const firstAskRetryDelaysMs = options.firstAskRetryDelaysMs ?? HELD_BROADCAST_FIRST_ASK_RETRY_DELAYS_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let running = false;
  let generation = 0;
  let timer: unknown = null;
  let heldKnown = false;
  /** Failed asks in a row since the start or the last answer. */
  let failures = 0;

  const finish = () => {
    running = false;
    timer = null;
  };

  const askOnce = async (mine: number) => {
    let answer: HeldBroadcastAnswer;
    try {
      answer = await options.ask();
    } catch (error) {
      if (mine !== generation) return;
      options.onError?.(error);
      // An old server ends it, whatever was known.
      if (error instanceof HeldBroadcastUnsupportedError) {
        finish();
        return;
      }
      // While a hold is known, keep trying at the usual pace.
      if (heldKnown) {
        timer = setTimer(() => { void askOnce(mine); }, intervalMs);
        return;
      }
      // Nothing known yet: retry for as long as a hold could last, then give up quietly.
      const delay = firstAskRetryDelaysMs[failures];
      failures += 1;
      if (delay === undefined) {
        finish();
        return;
      }
      timer = setTimer(() => { void askOnce(mine); }, delay);
      return;
    }
    if (mine !== generation) return;
    failures = 0;
    heldKnown = answer.held;
    options.onAnswer(answer);
    if (mine !== generation) return;
    if (answer.held) {
      timer = setTimer(() => { void askOnce(mine); }, intervalMs);
    } else {
      finish();
    }
  };

  return {
    start(alreadyHeld = false) {
      if (running) return;
      running = true;
      generation += 1;
      heldKnown = alreadyHeld;
      failures = 0;
      void askOnce(generation);
    },
    stop() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      finish();
    },
    get running() {
      return running;
    },
  };
}
