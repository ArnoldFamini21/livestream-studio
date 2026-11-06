import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Room, RoomRegistrationSettings, RoomSettings } from '@studio/shared';

/**
 * A studio's own description, signed by the server and kept by the host.
 *
 * Without a database, a restart of the free instance (every deploy, or a crash)
 * forgets every studio. The host's browser keeps this ticket next to its host
 * token, so when it reconnects to a server that no longer knows the studio,
 * the server can rebuild it (same id, name, settings, password and watch link)
 * and guests reconnecting a moment later find it again instead of a dead end.
 * Only the holder of the host token can use the ticket: it carries a hash of
 * that token, never the token itself.
 */

export const ROOM_RESTORE_TICKET_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TICKET_LENGTH = 8 * 1024;

export interface RoomRestoreTicketClaims {
  v: 1;
  purpose: 'room-restore';
  room: Pick<Room, 'id' | 'name' | 'createdAt' | 'hostName' | 'scheduledFor'> & {
    settings: RoomSettings;
    registration?: RoomRegistrationSettings;
  };
  hostTokenHash: string;
  watchId: string;
  creatorIp: string;
  createdByOwner?: boolean;
  /** The studio's /watch/<roomId> links predate private watch ids and keep working. */
  legacyWatchByRoomId?: boolean;
  passwordHash?: string;
  passwordSalt?: string;
  iat: number;
  exp: number;
}

export function hashHostToken(hostToken: string): string {
  return createHash('sha256').update(hostToken).digest('base64url');
}

export function signRoomRestoreTicket(claims: RoomRestoreTicketClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`room-restore.${body}`).digest('base64url');
  return `${body}.${signature}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** The ticket's claims when it is genuine, unexpired, for this studio and this host token; otherwise null. */
export function verifyRoomRestoreTicket(
  ticket: unknown,
  secret: string,
  expected: { roomId: string; hostToken: string },
  now = Date.now(),
): RoomRestoreTicketClaims | null {
  if (typeof ticket !== 'string' || ticket.length > MAX_TICKET_LENGTH) return null;
  const [body, signature, extra] = ticket.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expectedSignature = createHmac('sha256', secret).update(`room-restore.${body}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expectedSignature.length || !timingSafeEqual(provided, expectedSignature)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(claims) || claims.v !== 1 || claims.purpose !== 'room-restore') return null;
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (!isRecord(claims.room) || claims.room.id !== expected.roomId) return null;
  if (typeof claims.room.name !== 'string' || typeof claims.room.createdAt !== 'string' || !isRecord(claims.room.settings)) return null;
  if (typeof claims.watchId !== 'string' || !/^[A-Za-z0-9_-]{12,64}$/.test(claims.watchId)) return null;
  if (typeof claims.hostTokenHash !== 'string') return null;
  const presentedHash = Buffer.from(hashHostToken(expected.hostToken));
  const ticketHash = Buffer.from(claims.hostTokenHash);
  if (presentedHash.length !== ticketHash.length || !timingSafeEqual(presentedHash, ticketHash)) return null;
  return claims as unknown as RoomRestoreTicketClaims;
}
