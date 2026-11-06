import { randomBytes } from 'node:crypto';
import type { ParticipantRole, PresentationRenderTokenClaims } from '@studio/shared';

/**
 * Deck uploads are converted on the media server (LibreOffice), which shares
 * the instance with the live relay. Only admitted hosts and co-hosts may use
 * it; they ask signaling for this short-lived, single-purpose token and send
 * it as a bearer token with each render request.
 */
export const PRESENTATION_RENDER_TOKEN_TTL_MS = 10 * 60 * 1000;

export function buildPresentationRenderClaims(
  input: { roomId: string; participantId: string; role: Extract<ParticipantRole, 'host' | 'co-host'> },
  nowMs = Date.now()
): PresentationRenderTokenClaims {
  return {
    v: 1,
    purpose: 'presentation-render',
    roomId: input.roomId,
    participantId: input.participantId,
    role: input.role,
    iat: nowMs,
    exp: nowMs + PRESENTATION_RENDER_TOKEN_TTL_MS,
    nonce: randomBytes(12).toString('base64url'),
  };
}
