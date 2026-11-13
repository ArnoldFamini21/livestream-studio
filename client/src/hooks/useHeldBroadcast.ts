import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  INITIAL_HELD_WATCH_STATE,
  heldWatchReducer,
  type HeldWatchState,
} from '../utils/heldBroadcastState.ts';
import { createHeldBroadcastAsker, fetchHeldBroadcast } from '../utils/heldBroadcastAsker.ts';

interface UseHeldBroadcastOptions {
  /** The host has joined, the media server knows the request, and the studio is not live. */
  active: boolean;
  /** The signaling connection is up (asks again when it comes back). */
  connected: boolean;
  roomId: string | null;
  requestToken: () => Promise<string>;
  /** For tests. */
  fetchHeld?: typeof fetchHeldBroadcast;
}

export interface HeldBroadcastControls {
  state: HeldWatchState;
  dismiss: () => void;
}

/**
 * Asks the media server whether this room's broadcast is on hold, and counts
 * the hold down locally between answers. Only the host asks. The decisions
 * live in utils/heldBroadcastState.ts and heldBroadcastAsker.ts.
 */
export function useHeldBroadcast(options: UseHeldBroadcastOptions): HeldBroadcastControls {
  const [state, dispatch] = useReducer(heldWatchReducer, INITIAL_HELD_WATCH_STATE);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;

  const { active, connected, roomId } = options;

  // Nothing is shown to a guest, a co-host, a live host or on an old media server.
  useEffect(() => {
    if (!active) dispatch({ type: 'RESET' });
  }, [active]);

  // Ask once, then every ~10 s while a hold is reported; stop on any change or unmount.
  useEffect(() => {
    if (!active || !connected || !roomId) return undefined;
    const asker = createHeldBroadcastAsker({
      ask: async () => {
        const token = await optionsRef.current.requestToken();
        return (optionsRef.current.fetchHeld ?? fetchHeldBroadcast)({ roomId, token });
      },
      onAnswer: (answer) => dispatch({ type: 'ANSWER', answer }),
    });
    asker.start(stateRef.current.phase === 'held');
    return () => asker.stop();
  }, [active, connected, roomId]);

  // The countdown between answers: from the seconds the server gave, never from a clock comparison.
  const holding = state.phase === 'held';
  useEffect(() => {
    if (!active || !holding) return undefined;
    const timer = window.setInterval(() => dispatch({ type: 'TICK' }), 1_000);
    return () => window.clearInterval(timer);
  }, [active, holding]);

  const dismiss = useCallback(() => dispatch({ type: 'DISMISS' }), []);
  return { state, dismiss };
}
