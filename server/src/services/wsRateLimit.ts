/**
 * Per-socket message budgets for the signaling WebSocket.
 *
 * WebRTC negotiation is bursty: a host (re)connecting to several guests sends
 * an offer and a dozen or more trickled ICE candidates per peer within a second
 * or two, and an ICE restart after a network change does it again. Dropping any
 * of those leaves a guest's tile blank, so offers, answers and candidates get a
 * separate, much larger budget than ordinary studio messages (chat, reactions,
 * media state), whose budget stays tight to blunt floods.
 */

export const WS_CONTROL_RATE_LIMIT_MAX = 100;
export const WS_RELAY_RATE_LIMIT_MAX = 600;
export const WS_RATE_LIMIT_WINDOW_MS = 10_000;

const RELAY_MESSAGE_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'recording-transfer-signal']);

export type WsRateBucket = 'control' | 'relay';

export function getWsRateBucket(type: unknown): WsRateBucket {
  return typeof type === 'string' && RELAY_MESSAGE_TYPES.has(type) ? 'relay' : 'control';
}

interface BucketState {
  count: number;
  resetAt: number;
  /** The client was told about this window's limit already. */
  notified: boolean;
}

export interface WsRateLimitResult {
  allowed: boolean;
  /** Tell the client once per window, not once per dropped message. */
  notify: boolean;
  bucket: WsRateBucket;
}

export class WsRateLimiter<Key extends object> {
  private readonly buckets = new WeakMap<Key, Record<WsRateBucket, BucketState>>();

  constructor(
    private readonly limits: Record<WsRateBucket, number> = { control: WS_CONTROL_RATE_LIMIT_MAX, relay: WS_RELAY_RATE_LIMIT_MAX },
    private readonly windowMs = WS_RATE_LIMIT_WINDOW_MS,
  ) {}

  check(key: Key, type: unknown, now = Date.now()): WsRateLimitResult {
    const bucket = getWsRateBucket(type);
    let state = this.buckets.get(key);
    if (!state) {
      state = {
        control: { count: 0, resetAt: now + this.windowMs, notified: false },
        relay: { count: 0, resetAt: now + this.windowMs, notified: false },
      };
      this.buckets.set(key, state);
    }
    const entry = state[bucket];
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + this.windowMs;
      entry.notified = false;
    }
    entry.count += 1;
    if (entry.count <= this.limits[bucket]) return { allowed: true, notify: false, bucket };
    const notify = !entry.notified;
    entry.notified = true;
    return { allowed: false, notify, bucket };
  }

  forget(key: Key): void {
    this.buckets.delete(key);
  }
}

/** Largest SDP we relay; real offers with simulcast and many candidates stay well under this. */
export const MAX_RELAYED_SDP_LENGTH = 48 * 1024;
/** Largest single ICE candidate line we relay. */
export const MAX_RELAYED_CANDIDATE_LENGTH = 1024;
