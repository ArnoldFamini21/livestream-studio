import type { ParticipantRole } from '@studio/shared';
import { verifyLiveStreamToken, verifySfuToken } from './auth.js';

/**
 * Authentication for the `/sfu` control-plane socket.
 *
 * The first frame a client sends must be `{ type: 'sfu-auth', token }`.
 * Every on-stage participant receives a purpose-scoped SFU token (`purpose: 'sfu'`)
 * from the signaling server. Host live-stream tokens remain accepted for operator
 * compatibility, while recording-upload tokens are strictly rejected.
 */

export interface SfuAuthFrame {
  token: string;
}

export interface SfuIdentity {
  roomId: string;
  participantId: string;
  role: ParticipantRole;
  exp: number;
  iat?: number;
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
    return {
      roomId: claims.roomId,
      participantId: claims.participantId,
      role: claims.role,
      exp: claims.exp,
      ...(typeof claims.iat === 'number' ? { iat: claims.iat } : {}),
    };
  } catch {
    // Allow operator live-stream tokens; reject recording-upload or other purpose-scoped tokens.
  }
  const claims = verifyLiveStreamToken(token, secret, now);
  return {
    roomId: claims.roomId,
    participantId: claims.participantId,
    role: claims.role,
    exp: claims.exp,
  };
}
