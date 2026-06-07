import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LiveStreamTokenClaims } from '@studio/shared';

export function getLiveStreamTokenSecret(): string | null {
  const secret = process.env.LIVE_STREAM_TOKEN_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== 'production') return 'development-live-stream-token-secret';
  return null;
}

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function safeSignatureEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function signLiveStreamToken(claims: LiveStreamTokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${signBody(body, secret)}`;
}

export function verifyLiveStreamToken(token: string, secret: string, now = Date.now()): LiveStreamTokenClaims {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) {
    throw new Error('Malformed live stream token');
  }

  const expected = signBody(body, secret);
  if (!safeSignatureEquals(signature, expected)) {
    throw new Error('Invalid live stream token signature');
  }

  let claims: LiveStreamTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LiveStreamTokenClaims;
  } catch {
    throw new Error('Invalid live stream token payload');
  }

  if (
    claims.v !== 1 ||
    typeof claims.roomId !== 'string' ||
    typeof claims.participantId !== 'string' ||
    typeof claims.nonce !== 'string' ||
    typeof claims.exp !== 'number' ||
    (claims.role !== 'host' && claims.role !== 'co-host')
  ) {
    throw new Error('Invalid live stream token claims');
  }

  if (claims.exp <= now) {
    throw new Error('Live stream token expired');
  }

  return claims;
}
