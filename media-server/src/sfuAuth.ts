import type { ParticipantRole } from '@studio/shared';
import { verifyLiveStreamToken, verifyRecordingUploadToken } from './auth.js';

/**
 * Authentication for the `/sfu` control-plane socket.
 *
 * The first frame a client sends must be `{ type: 'sfu-auth', token }`. Hosts
 * and co-hosts present live-stream tokens; guests present their participant-
 * scoped recording-upload tokens (both are signed by the signaling server with
 * the shared LIVE_STREAM_TOKEN_SECRET and carry roomId + participantId).
 */

export interface SfuAuthFrame {
  token: string;
}

export interface SfuIdentity {
  roomId: string;
  participantId: string;
  role: ParticipantRole;
}

export function parseSfuAuthFrame(value: unknown): SfuAuthFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { type, token } = value as { type?: unknown; token?: unknown };
  if (type !== 'sfu-auth') return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
  return { token };
}

export function verifySfuIdentity(token: string, secret: string, now = Date.now()): SfuIdentity {
  try {
    const claims = verifyLiveStreamToken(token, secret, now);
    return { roomId: claims.roomId, participantId: claims.participantId, role: claims.role };
  } catch {
    // Fall through to the participant-scoped token guests hold.
  }
  const claims = verifyRecordingUploadToken(token, secret, now);
  return { roomId: claims.roomId, participantId: claims.participantId, role: claims.role };
}
