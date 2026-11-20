import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  WATCH_INVITE_TTL_MS,
  WATCH_PLAYBACK_TTL_MS,
  WATCH_TOKEN_PATTERN,
  validateWatchGrantClaims,
  type Room,
  type WatchGrantClaims,
  type WatchGrantPurpose,
} from '@studio/shared';

export function getWatchAccessSecret(): string | null {
  const secret = process.env.LIVE_STREAM_TOKEN_SECRET;
  if (secret && secret.length >= 32) return secret;
  return process.env.NODE_ENV !== 'production' ? 'development-live-stream-token-secret' : null;
}

export function issueWatchGrant(
  purpose: WatchGrantPurpose,
  watchId: string,
  secret: string,
  maxExpiry = Number.MAX_SAFE_INTEGER,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const ttl = purpose === 'watch-invite' ? WATCH_INVITE_TTL_MS : WATCH_PLAYBACK_TTL_MS;
  const claims: WatchGrantClaims = {
    v: 1, purpose, watchId, nonce: randomBytes(16).toString('base64url'), exp: Math.min(now + ttl, maxExpiry),
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${signature}`, expiresAt: new Date(claims.exp).toISOString() };
}

export function verifyWatchGrant(
  token: unknown,
  purpose: WatchGrantPurpose,
  watchId: string,
  secret: string,
  now = Date.now(),
): WatchGrantClaims | null {
  if (typeof token !== 'string' || !WATCH_TOKEN_PATTERN.test(token)) return null;
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    return validateWatchGrantClaims(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), purpose, watchId, now);
  } catch {
    return null;
  }
}

export function authorizeWatchViewer(req: Request, res: Response, found: { room: Room; watchId: string }): boolean {
  if (!found.room.registration?.enabled && !found.room.registration?.inviteOnly) return true;
  res.setHeader('Cache-Control', 'no-store');
  const secret = getWatchAccessSecret();
  const token = /^Bearer ([^ ]+)$/i.exec(req.get('Authorization') || '')?.[1];
  if (secret && verifyWatchGrant(token, 'watch-playback', found.watchId, secret)) return true;
  res.status(401).json({ error: 'Register again to watch this broadcast.', code: 'WATCH_ACCESS_REQUIRED' });
  return false;
}
