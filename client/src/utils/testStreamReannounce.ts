/**
 * The signaling server forgets a private test when the host's connection
 * drops, so guests and co-hosts lose the "TEST - not public" label while the
 * test itself keeps running in the host's browser. After the host rejoins it
 * says so again, the way a real broadcast does.
 */
export interface TestReannounceInput {
  /** This browser's test is running right now (the host started it here). */
  testRunningHere: boolean;
  /** The media connection that carries the test is still up. */
  relayActive: boolean;
  /** The rejoining participant is the host. A guest or co-host never announces a test. */
  isHost: boolean;
  /** The room is live after this join; a test is never announced then. */
  roomLive: boolean;
  /** The server already lists a running test after this join. */
  serverKnowsTest: boolean;
}

export function shouldReannounceTest(input: TestReannounceInput): boolean {
  if (!input.testRunningHere || !input.relayActive || !input.isHost) return false;
  if (input.roomLive || input.serverKnowsTest) return false;
  return true;
}
