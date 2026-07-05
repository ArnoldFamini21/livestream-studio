import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LiveStreamTokenClaims, ParticipantRole, RecordingUploadTokenClaims } from '@studio/shared';

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

export function signLiveStreamToken(claims: LiveStreamTokenClaims | RecordingUploadTokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${signBody(body, secret)}`;
}

function verifyTokenPayload(token: string, secret: string): unknown {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) {
    throw new Error('Malformed live stream token');
  }

  const expected = signBody(body, secret);
  if (!safeSignatureEquals(signature, expected)) {
    throw new Error('Invalid live stream token signature');
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid live stream token payload');
  }

  return claims;
}

function isParticipantRole(value: unknown): value is ParticipantRole {
  return value === 'host' || value === 'co-host' || value === 'guest';
}

export function verifyLiveStreamToken(token: string, secret: string, now = Date.now()): LiveStreamTokenClaims {
  const claims = verifyTokenPayload(token, secret) as Partial<LiveStreamTokenClaims> | null;

  if (
    !claims ||
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

  return claims as LiveStreamTokenClaims;
}

export function verifyRecordingUploadToken(
  token: string,
  secret: string,
  now = Date.now()
): RecordingUploadTokenClaims {
  const claims = verifyTokenPayload(token, secret) as Partial<RecordingUploadTokenClaims> | null;
  if (
    !claims ||
    claims.v !== 1 ||
    claims.purpose !== 'recording-upload' ||
    typeof claims.roomId !== 'string' ||
    typeof claims.participantId !== 'string' ||
    typeof claims.participantName !== 'string' ||
    !isParticipantRole(claims.role) ||
    typeof claims.sessionId !== 'string' ||
    typeof claims.nonce !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    throw new Error('Invalid recording upload token claims');
  }
  if (claims.exp <= now) {
    throw new Error('Recording upload token expired');
  }
  return claims as RecordingUploadTokenClaims;
}
