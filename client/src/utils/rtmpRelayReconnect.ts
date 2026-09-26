/**
 * When the studio's connection to the media server drops mid-broadcast (a
 * Wi-Fi blip), keep trying with growing gaps: 1.5, 3, 6, 12, then every
 * 15 s, about two minutes in all. Before, two attempts 1.5 s apart meant any
 * outage over ~3 s ended the broadcast. The count starts over once the relay
 * has been connected again for RELAY_STABLE_AFTER_MS.
 */
export const MAX_RELAY_RECONNECT_ATTEMPTS = 10;
export const RELAY_RECONNECT_DELAY_MS = 1_500;
export const RELAY_RECONNECT_MAX_DELAY_MS = 15_000;
export const RELAY_STABLE_AFTER_MS = 30_000;

export function getRelayReconnectDelayMs(attempt: number): number {
  return Math.min(RELAY_RECONNECT_MAX_DELAY_MS, RELAY_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

/** Attempts already used, given when the relay last (re)connected. */
export function getRelayAttemptsUsed(attemptsUsed: number, connectedAtMs: number | null, nowMs: number): number {
  if (connectedAtMs !== null && nowMs - connectedAtMs >= RELAY_STABLE_AFTER_MS) return 0;
  return attemptsUsed;
}

export interface RelayReconnectPlan {
  attempt: number;
  maxAttempts: number;
  message: string;
}

export function getRelayReconnectPlan(
  attemptsUsed: number,
  reason: string,
  maxAttempts = MAX_RELAY_RECONNECT_ATTEMPTS
): RelayReconnectPlan | null {
  if (!Number.isFinite(attemptsUsed) || attemptsUsed < 0) return null;
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) return null;
  if (attemptsUsed >= maxAttempts) return null;

  const attempt = Math.floor(attemptsUsed) + 1;
  const detail = reason.trim() || 'Media relay connection dropped.';
  return {
    attempt,
    maxAttempts,
    message: `${detail} Reconnecting (${attempt}/${maxAttempts})...`,
  };
}
