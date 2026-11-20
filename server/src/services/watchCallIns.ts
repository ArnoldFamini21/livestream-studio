import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  isValidViewerId,
  maskProfanity,
  sanitizeViewerText,
  type AudienceCallPublicStatus,
  type AudienceCallReceipt,
  type AudienceCallRequest,
  type WatchEventState,
} from '@studio/shared';

const PENDING_MS = 5 * 60_000;
const RESOLVED_MS = 2 * 60_000;
const NETWORK_WINDOW_MS = 60_000;
const KEY = /^[A-Za-z0-9_-]{24}$/;

interface Entry {
  request: AudienceCallRequest;
  key: string;
  viewerId: string;
  network: string;
  createdAt: number;
  expiresAt: number;
  status: AudienceCallPublicStatus;
}

export class WatchCallInError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function cleanText(raw: unknown, limit: number): string {
  const result = sanitizeViewerText(raw, limit);
  if (result.ok) return maskProfanity(result.text).text;
  if (result.reason === 'empty' || raw === undefined) return '';
  throw new WatchCallInError(400, 'The name or note is invalid or too long.');
}

export class WatchCallIns {
  private enabled = false;
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onChange: () => void) {}

  state(now = Date.now()): WatchEventState {
    this.prune(now);
    return {
      callInsEnabled: this.enabled,
      callIns: Array.from(this.entries.values())
        .filter((entry) => entry.status.state === 'waiting')
        .map((entry) => entry.request),
    };
  }

  isEnabled(): boolean { return this.enabled; }

  setEnabled(enabled: boolean, now = Date.now()): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.prune(now);
    if (!enabled) {
      for (const entry of this.entries.values()) {
        if (entry.status.state === 'waiting') this.resolve(entry, { state: 'declined' }, now);
      }
    }
    this.onChange();
  }

  request(raw: { viewerId?: unknown; name?: unknown; note?: unknown }, network: string, now = Date.now()): AudienceCallReceipt {
    if (!this.enabled) throw new WatchCallInError(403, 'Call-ins are turned off.');
    if (!isValidViewerId(raw?.viewerId)) throw new WatchCallInError(400, 'Reload the watch page and try again.');
    const name = cleanText(raw.name, 40);
    if (!name) throw new WatchCallInError(400, 'Enter your name before requesting to join.');
    const note = cleanText(raw.note, 200);
    this.prune(now);
    const entries = Array.from(this.entries.values());
    const recent = entries.filter((entry) => now - entry.createdAt < NETWORK_WINDOW_MS);
    if (entries.some((entry) => entry.viewerId === raw.viewerId &&
      (entry.status.state === 'waiting' || entry.status.state === 'approved')) ||
      recent.some((entry) => entry.viewerId === raw.viewerId)) {
      throw new WatchCallInError(429, 'A recent request already exists. Wait a minute and try again.');
    }
    if (recent.filter((entry) => entry.network === network).length >= 12 ||
      entries.filter((entry) => entry.status.state === 'waiting').length >= 24 ||
      entries.length >= 120) throw new WatchCallInError(429, 'The call-in queue is busy. Please try again soon.');
    const id = randomBytes(18).toString('base64url');
    const key = randomBytes(18).toString('base64url');
    this.entries.set(id, {
      request: { id, name, note }, key, viewerId: raw.viewerId, network, createdAt: now,
      expiresAt: now + PENDING_MS, status: { state: 'waiting' },
    });
    this.onChange();
    return { id, key };
  }

  status(id: string, key: string, now = Date.now()): AudienceCallPublicStatus | null {
    if (this.prune(now)) this.onChange();
    return this.findOwn(id, key)?.status ?? null;
  }

  cancel(id: string, key: string, now = Date.now()): boolean {
    this.prune(now);
    const entry = this.findOwn(id, key);
    if (!entry || entry.status.state !== 'waiting') return false;
    this.resolve(entry, { state: 'cancelled' }, now);
    this.onChange();
    return true;
  }

  decide(id: string, decision: 'approve' | 'decline', approve: () => { roomId: string; guestInvite: string; expiresAt: string }, now = Date.now()): boolean {
    this.prune(now);
    const entry = this.entries.get(id);
    if (!this.enabled || !entry || entry.status.state !== 'waiting') return false;
    this.resolve(entry, decision === 'approve' ? { state: 'approved', ...approve() } : { state: 'declined' }, now);
    this.onChange();
    return true;
  }

  private resolve(entry: Entry, status: AudienceCallPublicStatus, now: number) {
    entry.status = status;
    entry.expiresAt = now + RESOLVED_MS;
  }

  private findOwn(id: string, key: string): Entry | undefined {
    const entry = this.entries.get(id);
    if (!entry || !KEY.test(key) || !timingSafeEqual(Buffer.from(key), Buffer.from(entry.key))) return undefined;
    return entry;
  }

  private prune(now: number): boolean {
    let removedPending = false;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      removedPending ||= entry.status.state === 'waiting';
      this.entries.delete(id);
    }
    return removedPending;
  }
}
