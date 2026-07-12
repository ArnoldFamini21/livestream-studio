import type { ParticipantRole } from '@studio/shared';
import { verifyLiveStreamToken, verifyRecordingUploadToken, verifySfuToken } from './auth.js';

/**
 * Authentication for the `/sfu` control-plane socket.
 *
 * The first frame a client sends must be `{ type: 'sfu-auth', token }`. Hosts
 * Every admitted participant receives a purpose-scoped SFU token from the
 * signaling server. Legacy live-stream and recording-upload tokens remain
 * accepted during rolling deployment so existing sessions do not break.
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
    const claims = verifySfuToken(token, secret, now);
    return { roomId: claims.roomId, participantId: claims.participantId, role: claims.role };
  } catch {
    // Accept short-lived legacy tokens while the signaling server rolls out.
  }
  try {
    const claims = verifyLiveStreamToken(token, secret, now);
    return { roomId: claims.roomId, participantId: claims.participantId, role: claims.role };
  } catch {
    // Fall through to the participant-scoped recording token guests may hold.
  }
  const claims = verifyRecordingUploadToken(token, secret, now);
  return { roomId: claims.roomId, participantId: claims.participantId, role: claims.role };
}
