import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Lets the media server's SFU get Cloudflare TURN credentials from this
 * server, so the Cloudflare key only has to be set on one Render service.
 *
 * The request is authenticated with LIVE_STREAM_TOKEN_SECRET, which both
 * services already share: header `X-Studio-Internal-Signature: <unixSeconds>.<sig>`
 * where sig = base64url(HMAC-SHA256(secret, "studio-sfu-turn:v1:<unixSeconds>")).
 * The timestamp must be within INTERNAL_TURN_MAX_SKEW_SECONDS of this server's clock.
 * media-server/src/sfuIceServers.ts builds the same signature.
 */

export const INTERNAL_TURN_SIGNATURE_HEADER = 'x-studio-internal-signature';
export const INTERNAL_TURN_MAX_SKEW_SECONDS = 120;
export const INTERNAL_TURN_PATH = '/internal/sfu-turn-credentials';

export function internalTurnSignatureMessage(timestampSeconds: number): string {
  return `studio-sfu-turn:v1:${timestampSeconds}`;
}

export function signInternalTurnRequest(secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(internalTurnSignatureMessage(timestampSeconds)).digest('base64url');
  return `${timestampSeconds}.${signature}`;
}

export function verifyInternalTurnSignature(
  header: string | undefined,
  secret: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || !header || header.length > 200) return false;
  const match = /^(\d{9,12})\.([A-Za-z0-9_-]{43})$/.exec(header.trim());
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > INTERNAL_TURN_MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signInternalTurnRequest(secret, timestamp).split('.')[1]);
  const actual = Buffer.from(match[2]);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Same rule as the media tokens: 32+ characters, a fixed dev secret outside production. */
export function getInternalTurnSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.LIVE_STREAM_TOKEN_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (env.NODE_ENV !== 'production') return 'development-live-stream-token-secret';
  return null;
}
