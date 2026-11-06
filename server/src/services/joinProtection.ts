import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Join-time protection for the signaling server.
 *
 * The studio runs on a 0.1-CPU free instance, where one scrypt hash takes
 * hundreds of milliseconds. Password checks therefore run off the event loop
 * (libuv thread pool) and one at a time, so a flood of guesses cannot stall
 * signaling for everyone else, and repeated wrong guesses from one address are
 * locked out with a growing backoff.
 */

const SCRYPT_KEY_LENGTH = 32;

let passwordQueue: Promise<unknown> = Promise.resolve();

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_LENGTH, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Compare a password with a stored scrypt verifier without blocking the event loop. Checks run one at a time. */
export function verifyPasswordHashAsync(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const run = passwordQueue.then(async () => {
    const actual = await scryptAsync(password, salt);
    const expected = Buffer.from(expectedHash, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  // A failed check must not wedge the queue for later joins.
  passwordQueue = run.catch(() => undefined);
  return run;
}

export interface PasswordAttemptPolicy {
  /** Wrong guesses allowed before a lockout. */
  maxFailures: number;
  /** First lockout; every further lockout doubles, up to maxLockoutMs. */
  baseLockoutMs: number;
  maxLockoutMs: number;
  /** Failures older than this are forgotten. */
  failureWindowMs: number;
}

export const DEFAULT_PASSWORD_ATTEMPT_POLICY: PasswordAttemptPolicy = {
  maxFailures: 5,
  baseLockoutMs: 60_000,
  maxLockoutMs: 15 * 60_000,
  failureWindowMs: 15 * 60_000,
};

interface AttemptRecord {
  failures: number;
  lockouts: number;
  lockedUntil: number;
  lastFailureAt: number;
}

/** Wrong room-password guesses, per studio and network address, with exponential lockouts. */
export class PasswordAttemptLimiter {
  private readonly records = new Map<string, AttemptRecord>();

  constructor(private readonly policy: PasswordAttemptPolicy = DEFAULT_PASSWORD_ATTEMPT_POLICY) {}

  private key(roomId: string, ip: string) {
    return `${roomId}\u0000${ip}`;
  }

  /** Milliseconds until this address may guess again in this studio; 0 when it may. */
  lockedForMs(roomId: string, ip: string, now = Date.now()): number {
    const record = this.records.get(this.key(roomId, ip));
    if (!record) return 0;
    return Math.max(0, record.lockedUntil - now);
  }

  /** Record a wrong guess; returns the lockout it triggered (0 when none). */
  recordFailure(roomId: string, ip: string, now = Date.now()): number {
    const key = this.key(roomId, ip);
    let record = this.records.get(key);
    if (!record) {
      record = { failures: 0, lockouts: 0, lockedUntil: 0, lastFailureAt: now };
      this.records.set(key, record);
    } else if (now - record.lastFailureAt > this.policy.failureWindowMs) {
      // A quiet spell forgets the guesses, and a long one the escalation too.
      record.failures = 0;
      if (now - record.lastFailureAt > this.policy.failureWindowMs * 4) record.lockouts = 0;
    }
    record.failures += 1;
    record.lastFailureAt = now;
    if (record.failures < this.policy.maxFailures) return 0;
    const lockoutMs = Math.min(this.policy.maxLockoutMs, this.policy.baseLockoutMs * 2 ** record.lockouts);
    record.lockouts += 1;
    record.failures = 0;
    record.lockedUntil = now + lockoutMs;
    return lockoutMs;
  }

  recordSuccess(roomId: string, ip: string): void {
    this.records.delete(this.key(roomId, ip));
  }

  forgetRoom(roomId: string): void {
    const prefix = `${roomId}\u0000`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }

  sweep(now = Date.now()): void {
    for (const [key, record] of this.records) {
      if (record.lockedUntil <= now && now - record.lastFailureAt > this.policy.failureWindowMs) {
        this.records.delete(key);
      }
    }
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * The client address behind Render's proxy. The app trusts exactly one proxy
 * hop (`trust proxy` = 1), so the last X-Forwarded-For entry is the one the
 * proxy added; anything before it was written by the client.
 */
export function getUpgradeRequestIp(req: Pick<IncomingMessage, 'headers' | 'socket'> | undefined): string {
  if (!req) return 'unknown';
  const header = req.headers?.['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header[header.length - 1] : header;
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last.slice(0, 64);
  }
  return (req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

/** Open studio sockets per network address, so one client cannot hold hundreds of connections. */
export class SocketsPerIpLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly maxPerIp = 20) {}

  tryAcquire(ip: string): boolean {
    const current = this.counts.get(ip) || 0;
    if (current >= this.maxPerIp) return false;
    this.counts.set(ip, current + 1);
    return true;
  }

  release(ip: string): void {
    const current = this.counts.get(ip) || 0;
    if (current <= 1) this.counts.delete(ip);
    else this.counts.set(ip, current - 1);
  }

  count(ip: string): number {
    return this.counts.get(ip) || 0;
  }
}
