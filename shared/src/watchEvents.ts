/** Viewer grants are scoped to one canonical watch identifier and one purpose. */
export const WATCH_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const WATCH_PLAYBACK_TTL_MS = 12 * 60 * 60_000;
export const WATCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,640}\.[A-Za-z0-9_-]{43}$/;

export type WatchGrantPurpose = 'watch-invite' | 'watch-playback';

export interface WatchGrantClaims {
  v: 1;
  purpose: WatchGrantPurpose;
  watchId: string;
  nonce: string;
  exp: number;
}

export function validateWatchGrantClaims(
  input: unknown,
  purpose: WatchGrantPurpose,
  watchId: string,
  now: number,
): WatchGrantClaims | null {
  if (!input || typeof input !== 'object') return null;
  const claims = input as Partial<WatchGrantClaims>;
  if (claims.v !== 1 || claims.purpose !== purpose || claims.watchId !== watchId ||
    typeof claims.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(claims.nonce) ||
    typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now) return null;
  return claims as WatchGrantClaims;
}

export interface AudienceCallRequest {
  id: string;
  name: string;
  note: string;
}

export interface WatchEventState {
  callInsEnabled: boolean;
  callIns: AudienceCallRequest[];
}

export type AudienceCallPublicStatus =
  | { state: 'waiting' | 'declined' | 'cancelled' | 'expired' }
  | { state: 'approved'; roomId: string; guestInvite: string; expiresAt: string };

export interface AudienceCallReceipt {
  id: string;
  key: string;
}
