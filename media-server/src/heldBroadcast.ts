import { STUDIO_RECONNECT_HOLD_MS } from './relayResume.js';

/**
 * What an authorised studio may learn about its own room's broadcast on hold:
 * whether one waits on the "be right back" slate, how long is left, and for
 * each destination only its display name and whether it is still connected.
 * Never a stream key, never an RTMP URL, never an id.
 */

export type HeldBroadcastState = 'held' | 'broadcast' | 'test' | 'none';

export interface HeldBroadcastDestinationStatus {
  name: string;
  connected: boolean;
}

export interface HeldBroadcastAnswer {
  held: boolean;
  /** What runs in this room: a held broadcast, a running one, a private test, or nothing. */
  state: HeldBroadcastState;
  /** Whole seconds before the hold ends; only while held. */
  secondsLeft?: number;
  /** Only while held. */
  destinations?: HeldBroadcastDestinationStatus[];
}

/** The part of a relay session this answer needs. */
export interface HeldBroadcastCandidate {
  clientGone: boolean;
  started: boolean;
  stopping: boolean;
  test: boolean;
  claims?: { roomId: string } | null;
  slate: { startedAtMs: number } | null;
  /** The destinations as the studio named them (display names are the studio's own text). */
  destinations: Array<{ id: string; name: string }>;
  relays: Map<string, { live: boolean; exited: boolean }>;
  confirmedDestinations: Set<string>;
}

const MAX_NAME_LENGTH = 80;

function displayName(name: string): string {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > MAX_NAME_LENGTH ? `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}…` : trimmed;
}

export function buildHeldBroadcastAnswer(options: {
  roomId: string;
  sessions: Iterable<HeldBroadcastCandidate>;
  nowMs: number;
  holdMs?: number;
}): HeldBroadcastAnswer {
  const holdMs = options.holdMs ?? STUDIO_RECONNECT_HOLD_MS;
  let running: HeldBroadcastState = 'none';
  for (const session of new Set(options.sessions)) {
    if (!session.started || session.stopping || session.claims?.roomId !== options.roomId) continue;
    if (session.test) {
      if (running === 'none') running = 'test';
      continue;
    }
    if (!session.clientGone) {
      running = 'broadcast';
      continue;
    }
    const startedAtMs = session.slate?.startedAtMs ?? options.nowMs;
    const msLeft = startedAtMs + holdMs - options.nowMs;
    // The hold is over (the server stops it within a second): nothing waits any more.
    if (msLeft <= 0) continue;
    return {
      held: true,
      state: 'held',
      secondsLeft: Math.min(Math.ceil(holdMs / 1000), Math.ceil(msLeft / 1000)),
      destinations: session.destinations.map((destination) => {
        const relay = session.relays.get(destination.id);
        return {
          name: displayName(destination.name),
          connected: Boolean(relay && relay.live && !relay.exited && session.confirmedDestinations.has(destination.id)),
        };
      }),
    };
  }
  return { held: false, state: running };
}
