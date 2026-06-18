export const MAX_RELAY_RECONNECT_ATTEMPTS = 2;
export const RELAY_RECONNECT_DELAY_MS = 1_500;

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
