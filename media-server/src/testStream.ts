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
