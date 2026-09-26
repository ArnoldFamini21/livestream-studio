/**
 * When a destination's RTMP connection drops mid-broadcast (a YouTube or
 * Facebook ingest hiccup), keep trying for a while with growing gaps, and
 * treat a destination that has been healthy again for a while as a fresh
 * start. Before, each destination got two attempts 1.5 s apart for the whole
 * broadcast: an outage over ~3 s, or a third blip hours later, ended it.
 */
export const DESTINATION_RECONNECT_BASE_DELAY_MS = 1_500;
export const DESTINATION_RECONNECT_MAX_DELAY_MS = 30_000;
/** 1.5 + 3 + 6 + 12 + 24 + 30 + 30 + 30 s: about 2.5 minutes per outage. */
export const MAX_DESTINATION_RECONNECTS = 8;
/** A destination that has never held a connection (wrong key or URL): fail fast. */
export const MAX_UNCONFIRMED_DESTINATION_RECONNECTS = 2;
/** A refused or rejected RTMP connection ends within about a second; this long means it held. */
export const DESTINATION_LIVE_CONFIRM_MS = 3_000;
/** Live this long since the last reconnect: the next drop starts counting from zero. */
export const DESTINATION_STABLE_AFTER_MS = 30_000;

export function getDestinationReconnectDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(DESTINATION_RECONNECT_MAX_DELAY_MS, DESTINATION_RECONNECT_BASE_DELAY_MS * 2 ** exponent);
}

/** Reconnects already used for this outage, given how long the connection that just dropped was live. */
export function getReconnectAttemptsAfterDrop(previousAttempts: number, liveSinceMs: number | null, nowMs: number): number {
  if (liveSinceMs !== null && nowMs - liveSinceMs >= DESTINATION_STABLE_AFTER_MS) return 0;
  return previousAttempts;
}
