/** A clean WebSocket handshake also happens during a planned server restart. */
export function shouldReconnectSignaling(code: number, intentional: boolean): boolean {
  if (intentional) return false;
  // Normal departures, moderation, expired/replaced sessions and policy errors
  // require a deliberate new join, not an automatic reconnect loop.
  return code !== 1000 && code !== 1008 && code < 4000;
}
