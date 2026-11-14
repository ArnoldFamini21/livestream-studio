import { resolveMediaHttpUrl } from './apiClient.ts';
import { HELD_BROADCAST_ASK_INTERVAL_MS, parseHeldBroadcastAnswer, type HeldBroadcastAnswer } from './heldBroadcastState.ts';

/**
 * Asks the media server about the studio's own room. Once on start; while a
 * hold is reported, again every ~10 s; never when nothing is held. A failed
 * ask only retries while a hold is known (the countdown carries on locally
 * meanwhile), and an old media server (route not found) ends the asking.
 */

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
}): Promise<HeldBroadcastAnswer> {
  const base = (options.mediaHttpUrl ?? resolveMediaHttpUrl()).trim().replace(/\/+$/, '');
  if (!base) throw new Error('The media server address is not set.');
  const response = await (options.fetchImpl ?? fetch)(`${base}/rtmp/held?roomId=${encodeURIComponent(options.roomId)}`, {
    method: 'GET',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${options.token}` },
    signal: options.signal,
  });
  // A media server from before this request answers "not found".
  if (response.status === 404 || response.status === 405) throw new HeldBroadcastUnsupportedError();
  if (!response.ok) throw new Error(`The media server answered ${response.status}.`);
  const answer = parseHeldBroadcastAnswer(await response.json().catch(() => null));
  if (!answer) throw new HeldBroadcastUnsupportedError();
  return answer;
}

export interface HeldBroadcastAskerOptions {
  ask: () => Promise<HeldBroadcastAnswer>;
  onAnswer: (answer: HeldBroadcastAnswer) => void;
  /** Called for a failed ask; the asker decides about retrying. */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface HeldBroadcastAsker {
  /** `heldKnown`: the studio already shows a hold (a reconnect), so a failed ask is retried. */
  start: (heldKnown?: boolean) => void;
  stop: () => void;
  readonly running: boolean;
}

export function createHeldBroadcastAsker(options: HeldBroadcastAskerOptions): HeldBroadcastAsker {
  const intervalMs = options.intervalMs ?? HELD_BROADCAST_ASK_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let running = false;
  let generation = 0;
  let timer: unknown = null;
  let heldKnown = false;

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
      // Keep trying only while a hold is known; an old server ends it.
      if (heldKnown && !(error instanceof HeldBroadcastUnsupportedError)) {
        timer = setTimer(() => { void askOnce(mine); }, intervalMs);
      } else {
        finish();
      }
      return;
    }
    if (mine !== generation) return;
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
