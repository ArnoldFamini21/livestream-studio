/**
 * How many broadcasts this media server runs at once. Each live relay costs a
 * backup recorder, an encoder or copy relay per destination and an HLS writer;
 * the free Render instance (0.1 CPU, 512 MB) carries exactly one. A second
 * broadcast would starve the first, so it is refused instead.
 */

export const DEFAULT_MAX_RELAY_SESSIONS = 1;
const MAX_RELAY_SESSIONS_CEILING = 16;

export function getMaxRelaySessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MAX_RELAY_SESSIONS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_RELAY_SESSIONS;
  return Math.min(MAX_RELAY_SESSIONS_CEILING, Math.floor(raw));
}

export interface RelaySessionLike {
  started: boolean;
  stopping: boolean;
}

/** Started broadcasts other than `exclude`; a session registered under two sockets counts once. */
export function countActiveRelaySessions<T extends RelaySessionLike>(sessions: Iterable<T>, exclude?: T): number {
  const active = new Set<T>();
  for (const session of sessions) {
    if (session !== exclude && session.started && !session.stopping) active.add(session);
  }
  return active.size;
}

export function isRelayCapacityAvailable<T extends RelaySessionLike>(
  sessions: Iterable<T>,
  current: T,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return countActiveRelaySessions(sessions, current) < getMaxRelaySessions(env);
}
