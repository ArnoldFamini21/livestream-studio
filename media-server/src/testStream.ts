import { randomBytes } from 'node:crypto';
import type { RtmpRelayStartPayload } from '@studio/shared';

/**
 * A private test stream: the studio's program goes through the media server
 * exactly as in a broadcast, but to no destination at all. The output is
 * published as HLS under a random id that only the studio that started the
 * test is told, never under the studio's public watch id.
 */

const TEST_WATCH_ID_PREFIX = 't-';

/** 144 random bits: unguessable, and it matches the watch-id pattern used for HLS folders. */
export function createTestWatchId(randomSource: (size: number) => Buffer = randomBytes): string {
  return `${TEST_WATCH_ID_PREFIX}${randomSource(18).toString('base64url')}`;
}

export function isTestWatchId(value: string): boolean {
  return value.startsWith(TEST_WATCH_ID_PREFIX);
}

/** Tests need the shared encode: the private output is a copy of it. */
export function isTestStreamSupported(encodeOnce: boolean): boolean {
  return encodeOnce;
}

/**
 * Whether a start message may open a test session. A message marked as a test
 * can never carry a destination, so a client bug cannot publish a test.
 */
export function getTestStartIssue(
  payload: Pick<RtmpRelayStartPayload, 'test' | 'destinations'>,
  encodeOnce: boolean
): string | null {
  if (payload.test !== true) return null;
  if (!isTestStreamSupported(encodeOnce)) {
    return 'This media server cannot run a private test (it needs the shared encode).';
  }
  if (!Array.isArray(payload.destinations) || payload.destinations.length > 0) {
    return 'A test stream never sends to a destination. Nothing was started.';
  }
  return null;
}

/** What a test session may do, for guards at every place a destination could be started. */
export function mayStartDestination(session: { test: boolean }): boolean {
  return !session.test;
}

/** Why a new session is refused while another one runs; names the test when it is one. */
export function getCapacityRefusal(options: { incomingIsTest: boolean; runningIsTest: boolean }): { code: string; message: string } {
  if (options.runningIsTest && options.incomingIsTest) {
    return { code: 'RELAY_CAPACITY_REACHED', message: 'A test stream is already running. End it before starting another.' };
  }
  if (options.runningIsTest) {
    return { code: 'RELAY_CAPACITY_REACHED', message: 'A test stream is still running. End the test before going live.' };
  }
  if (options.incomingIsTest) {
    return { code: 'RELAY_CAPACITY_REACHED', message: 'A live broadcast is running. A test cannot run at the same time.' };
  }
  return { code: 'RELAY_CAPACITY_REACHED', message: 'This media server is already running another broadcast. Try again when it ends.' };
}

export const BROADCAST_HELD_CODE = 'TEST_BLOCKED_BY_HELD_BROADCAST';

/**
 * A test must never touch a broadcast that is waiting for its studio to come
 * back: it would otherwise take the "same studio restarting with new settings"
 * path and end the public broadcast. Decided before any state of the new
 * session exists. Only a test is refused; a normal start keeps its rules.
 */
export function getHeldBroadcastRefusal(options: {
  incomingIsTest: boolean;
  roomHasHeldBroadcast: boolean;
}): { code: string; message: string } | null {
  if (!options.incomingIsTest || !options.roomHasHeldBroadcast) return null;
  return {
    code: BROADCAST_HELD_CODE,
    message: 'Your broadcast is still on the air, waiting for you. Press Go Live to continue it. A test can run after the broadcast ends.',
  };
}

/** A real broadcast of this room whose studio connection dropped and that is still on its slate. */
export function isHeldRealBroadcast(
  candidate: { clientGone: boolean; started: boolean; stopping: boolean; test: boolean; claims?: { roomId: string } | null },
  roomId: string
): boolean {
  return candidate.clientGone && candidate.started && !candidate.stopping && !candidate.test && candidate.claims?.roomId === roomId;
}
