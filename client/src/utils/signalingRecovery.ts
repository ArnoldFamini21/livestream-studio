/** A clean WebSocket handshake also happens during a planned server restart. */
export function shouldReconnectSignaling(code: number, intentional: boolean): boolean {
  if (intentional) return false;
  // Normal departures, moderation, expired/replaced sessions and policy errors
  // require a deliberate new join, not an automatic reconnect loop.
  return code !== 1000 && code !== 1008 && code < 4000;
}

/** How often the studio checks its server connection. */
export const SIGNALING_HEARTBEAT_INTERVAL_MS = 20_000;
/** No word from the server for this long means the connection is dead. */
export const SIGNALING_STALE_AFTER_MS = 45_000;
/** After a wake-up or tab switch, the server must answer within this time. */
export const SIGNALING_WAKE_CHECK_TIMEOUT_MS = 6_000;

export function isSignalingStale(lastMessageAt: number, now: number, staleAfterMs = SIGNALING_STALE_AFTER_MS): boolean {
  return lastMessageAt > 0 && now - lastMessageAt > staleAfterMs;
}
