import type { MediaServerHealth } from './mediaServerHealth.ts';

/**
 * A broadcast whose studio connection dropped stays on the air on a "be right
 * back" slate for a while. This is what the returning host learns about it:
 * the media server's answer, the local countdown between answers, and what the
 * banner may say. Nothing here holds a stream key.
 */

export const HELD_BROADCAST_ASK_INTERVAL_MS = 10_000;

export interface HeldDestinationStatus {
  name: string;
  connected: boolean;
}

export type HeldRunningState = 'held' | 'broadcast' | 'test' | 'none';

export interface HeldBroadcastAnswer {
  held: boolean;
  state: HeldRunningState;
  secondsLeft: number;
  destinations: HeldDestinationStatus[];
}

export type HeldWatchState =
  | { phase: 'idle' }
  | { phase: 'held'; secondsLeft: number; destinations: HeldDestinationStatus[] }
  | { phase: 'ended' };

export const INITIAL_HELD_WATCH_STATE: HeldWatchState = { phase: 'idle' };

export type HeldWatchEvent =
  | { type: 'ANSWER'; answer: HeldBroadcastAnswer }
  | { type: 'TICK' }
  | { type: 'DISMISS' }
  | { type: 'RESET' };

/** Reads the media server's JSON; null when it is not an answer to this question. */
export function parseHeldBroadcastAnswer(value: unknown): HeldBroadcastAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.held !== 'boolean') return null;
  const state: HeldRunningState = record.state === 'held' || record.state === 'broadcast' || record.state === 'test' || record.state === 'none'
    ? record.state
    : record.held ? 'held' : 'none';
  if (!record.held) return { held: false, state: state === 'held' ? 'none' : state, secondsLeft: 0, destinations: [] };
  const secondsLeft = Number(record.secondsLeft);
  if (!Number.isFinite(secondsLeft)) return null;
  const destinations = Array.isArray(record.destinations)
    ? record.destinations.flatMap((item): HeldDestinationStatus[] => {
      if (!item || typeof item !== 'object') return [];
      const { name, connected } = item as Record<string, unknown>;
      return typeof name === 'string' ? [{ name: name.slice(0, 80), connected: connected === true }] : [];
    })
    : [];
  return { held: true, state: 'held', secondsLeft: Math.max(0, Math.floor(secondsLeft)), destinations };
}

export function heldWatchReducer(state: HeldWatchState, event: HeldWatchEvent): HeldWatchState {
  switch (event.type) {
    case 'ANSWER': {
      const { answer } = event;
      if (answer.held) {
        // A hold that has no time left is over, whatever the destinations say.
        if (answer.secondsLeft <= 0) return state.phase === 'held' ? { phase: 'ended' } : state;
        return { phase: 'held', secondsLeft: answer.secondsLeft, destinations: answer.destinations };
      }
      // We had told the host it was on hold and the server says nothing is any more.
      // Running again (a continue from elsewhere) or a test is not an ending.
      if (state.phase === 'held') return answer.state === 'none' ? { phase: 'ended' } : { phase: 'idle' };
      return state.phase === 'ended' ? state : { phase: 'idle' };
    }
    case 'TICK':
      if (state.phase !== 'held') return state;
      return state.secondsLeft <= 1 ? { phase: 'ended' } : { ...state, secondsLeft: state.secondsLeft - 1 };
    case 'DISMISS':
      return state.phase === 'ended' ? { phase: 'idle' } : state;
    case 'RESET':
      return state.phase === 'idle' ? state : { phase: 'idle' };
  }
}

/** M:SS. */
export function formatHeldCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

/** An old media server (during a deploy) does not advertise the request: no banner, no asking. */
export function isHeldBroadcastSupported(health: Pick<MediaServerHealth, 'status' | 'heldBroadcast'> | null | undefined): boolean {
  return Boolean(health && health.status !== 'unavailable' && health.heldBroadcast?.ready === true);
}

/** The one line shown under "Test stream (private)" while a hold is reported; null when a test may run. */
export function getHeldTestBlocker(state: HeldWatchState): string | null {
  return state.phase === 'held'
    ? 'Your broadcast is still on the air, waiting for you. A test can run after you continue or it ends.'
    : null;
}
