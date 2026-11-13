/**
 * Where the studio is between "idle", a private test, and a real broadcast.
 * A test and a broadcast never run at the same time: the media server on the
 * free plan carries one relay session. This reducer is the single place that
 * decides which move is allowed and what the host is told when it is not.
 */

export type TestStreamPhase =
  /** Nothing is on air. */
  | 'idle'
  /** The test is being set up (media server check, authorization, relay start). */
  | 'starting'
  /** The private test is running. */
  | 'testing'
  /** The test is being ended on request. */
  | 'ending'
  /** The test is being ended so the real broadcast can start. */
  | 'switching'
  /** The real broadcast runs (its state lives with the Go Live code). */
  | 'live'
  /** The last test or switch failed; `message` says why. */
  | 'error';

export interface TestStreamState {
  phase: TestStreamPhase;
  startedAt: string | null;
  /** Private output id of the running test; null otherwise. */
  watchId: string | null;
  /** Error or notice for the host, in plain words. */
  message: string | null;
}

export type TestStreamEvent =
  | { type: 'START_REQUESTED' }
  | { type: 'START_SUCCEEDED'; watchId: string | null; startedAt: string }
  /** `refused`: the media server declined the start on purpose; nothing is wrong and nothing was started. */
  | { type: 'START_FAILED'; message: string; refused?: boolean }
  | { type: 'OUTPUT_CHANGED'; watchId: string }
  | { type: 'END_REQUESTED' }
  | { type: 'END_COMPLETED' }
  | { type: 'GO_LIVE_REQUESTED' }
  | { type: 'SWITCH_COMPLETED' }
  | { type: 'SWITCH_FAILED'; message: string }
  | { type: 'RELAY_LOST'; message: string }
  | { type: 'LIVE_ON' }
  | { type: 'LIVE_OFF' }
  | { type: 'DISMISS' };

export const INITIAL_TEST_STREAM_STATE: TestStreamState = {
  phase: 'idle',
  startedAt: null,
  watchId: null,
  message: null,
};

export const MESSAGE_LIVE_BLOCKS_TEST = 'A live broadcast is running. A test cannot run at the same time.';
export const MESSAGE_TEST_BLOCKS_LIVE = 'A test is running. Use "Go live now" to end it and start the broadcast.';
/** The media server's code for a test refused because the room's broadcast is on hold. */
export const TEST_BLOCKED_BY_HELD_BROADCAST_CODE = 'TEST_BLOCKED_BY_HELD_BROADCAST';

/** True for the error the relay raises when the media server declined the test on purpose. */
export function isHeldBroadcastRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === TEST_BLOCKED_BY_HELD_BROADCAST_CODE;
}

/** Said once when "Go live now" ended the test but the broadcast did not start. */
export function describeSwitchFailure(reason: string | null): string {
  const base = 'The test has ended, but the broadcast did not start.';
  const cleaned = reason?.trim().replace(/[.\s]+$/, '');
  return cleaned ? `${base} Reason: ${cleaned}. Fix it, then press Go Live.` : `${base} Check the destination list, then press Go Live.`;
}

export const MESSAGE_BUSY = 'Please wait a moment, the studio is still changing state.';

function withMessage(state: TestStreamState, message: string): TestStreamState {
  return state.message === message ? state : { ...state, message };
}

export function testStreamReducer(state: TestStreamState, event: TestStreamEvent): TestStreamState {
  switch (event.type) {
    case 'START_REQUESTED':
      if (state.phase === 'idle' || state.phase === 'error') {
        return { phase: 'starting', startedAt: null, watchId: null, message: null };
      }
      if (state.phase === 'live') return withMessage(state, MESSAGE_LIVE_BLOCKS_TEST);
      if (state.phase === 'testing') return state;
      return withMessage(state, MESSAGE_BUSY);

    case 'START_SUCCEEDED':
      if (state.phase !== 'starting') return state;
      return { phase: 'testing', startedAt: event.startedAt, watchId: event.watchId, message: null };

    case 'START_FAILED':
      if (state.phase !== 'starting') return state;
      // A refusal leaves the panel as it was before the press, with the reason shown.
      if (event.refused) return { phase: 'idle', startedAt: null, watchId: null, message: event.message };
      return { phase: 'error', startedAt: null, watchId: null, message: event.message };

    case 'OUTPUT_CHANGED':
      // The relay reconnected and the media server opened a new private address.
      if (state.phase !== 'testing' || state.watchId === event.watchId) return state;
      return { ...state, watchId: event.watchId };

    case 'END_REQUESTED':
      if (state.phase === 'testing' || state.phase === 'starting') return { ...state, phase: 'ending', message: null };
      return state;

    case 'END_COMPLETED':
      if (state.phase !== 'ending') return state;
      return INITIAL_TEST_STREAM_STATE;

    case 'GO_LIVE_REQUESTED':
      if (state.phase === 'testing') return { ...state, phase: 'switching', message: null };
      if (state.phase === 'starting' || state.phase === 'ending' || state.phase === 'switching') return withMessage(state, MESSAGE_BUSY);
      return state;

    case 'SWITCH_COMPLETED':
      if (state.phase !== 'switching') return state;
      return INITIAL_TEST_STREAM_STATE;

    case 'SWITCH_FAILED':
      // The broadcast's own start flips "live" on and off while the switch is
      // still waiting for its answer, which moves the phase on before this
      // event arrives. The failure still has to reach the host, in either order.
      if (state.phase !== 'switching' && state.phase !== 'live' && state.phase !== 'idle') return state;
      return { phase: 'error', startedAt: null, watchId: null, message: event.message };

    case 'RELAY_LOST':
      if (state.phase !== 'testing' && state.phase !== 'starting') return state;
      return { phase: 'error', startedAt: null, watchId: null, message: event.message };

    case 'LIVE_ON':
      // The broadcast owns the relay now; no test can be left over.
      return { phase: 'live', startedAt: null, watchId: null, message: null };

    case 'LIVE_OFF':
      return state.phase === 'live' ? INITIAL_TEST_STREAM_STATE : state;

    case 'DISMISS':
      return state.phase === 'error' ? INITIAL_TEST_STREAM_STATE : state.message ? { ...state, message: null } : state;
  }
}

/** The test is on the media server (or about to be), so the relay is not free. */
export function isTestRelayInUse(state: TestStreamState): boolean {
  return state.phase === 'starting' || state.phase === 'testing' || state.phase === 'ending' || state.phase === 'switching';
}

/** The studio shows "TEST - not public" for this phase. */
export function isTestOnAir(state: TestStreamState): boolean {
  return state.phase === 'testing';
}

export interface TestStartContext {
  /** The media server advertises the test in /health. */
  supported: boolean;
  /** Why not, when the media server is old or unreachable. */
  unsupportedReason: string;
  isHost: boolean;
}

/** Whether a test can start now, and if not, the plain-words reason. */
export function getTestStartBlocker(state: TestStreamState, context: TestStartContext): string | null {
  if (!context.isHost) return 'Only the host can run a test stream.';
  if (!context.supported) return context.unsupportedReason;
  if (state.phase === 'live') return MESSAGE_LIVE_BLOCKS_TEST;
  if (state.phase === 'testing') return 'A test is already running.';
  if (state.phase === 'starting' || state.phase === 'ending' || state.phase === 'switching') return MESSAGE_BUSY;
  return null;
}

/** Whether the normal Go Live may start now. During a test it goes through the switch instead. */
export function getGoLiveBlocker(state: TestStreamState): string | null {
  if (state.phase === 'testing') return MESSAGE_TEST_BLOCKS_LIVE;
  if (state.phase === 'starting' || state.phase === 'ending' || state.phase === 'switching') return MESSAGE_BUSY;
  return null;
}

export const TEST_BANNER_LABEL = 'TEST - not public';

/** What the host sees, by phase. Guests only ever see the banner label. */
export function describeTestPhase(state: TestStreamState): { label: string; tone: 'neutral' | 'test' | 'live' | 'error' } {
  switch (state.phase) {
    case 'starting': return { label: 'Starting test...', tone: 'test' };
    case 'testing': return { label: TEST_BANNER_LABEL, tone: 'test' };
    case 'ending': return { label: 'Ending test...', tone: 'test' };
    case 'switching': return { label: 'Going live...', tone: 'test' };
    case 'live': return { label: 'LIVE', tone: 'live' };
    case 'error': return { label: 'Test stopped', tone: 'error' };
    default: return { label: 'Not live', tone: 'neutral' };
  }
}
