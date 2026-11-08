import type { JoinRoomPayload, ParticipantRole } from '@studio/shared';
import { STUDIO_CAPABILITIES } from '@studio/shared';

/**
 * Keeping a studio seat through dropped connections and server restarts.
 *
 * - The resume token (from room-joined) lives in sessionStorage: it belongs to
 *   this tab, survives a reload, and is presented on every rejoin so the server
 *   hands back the same participant id, role and place within its grace window.
 *   Healthy peer connections then stay up.
 * - Once a resume token exists, single-use invite tokens are not sent again:
 *   they were spent on the first join, and re-sending them used to eject
 *   co-hosts and secure-link guests on every reconnect.
 * - The host's restore ticket lives in localStorage next to the host token, so
 *   the host can rebuild the studio on a server that restarted without a
 *   database.
 */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeSession(): StorageLike | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

function safeLocal(): StorageLike | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function read(storage: StorageLike | null, key: string): string | undefined {
  try { return storage?.getItem(key) || undefined; } catch { return undefined; }
}

function write(storage: StorageLike | null, key: string, value: string | null | undefined): void {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch {
    // Private mode or a full quota: the seat simply is not resumable.
  }
}

const resumeKey = (roomId: string) => `studioResumeToken:${roomId}`;
const restoreKey = (roomId: string) => `studioRestoreTicket:${roomId}`;

export function getStudioResumeToken(roomId: string, storage: StorageLike | null = safeSession()): string | undefined {
  return read(storage, resumeKey(roomId));
}

export function saveStudioResumeToken(roomId: string, token: string | null | undefined, storage: StorageLike | null = safeSession()): void {
  write(storage, resumeKey(roomId), token);
}

export function getStudioRestoreTicket(roomId: string, storage: StorageLike | null = safeLocal()): string | undefined {
  return read(storage, restoreKey(roomId));
}

export function saveStudioRestoreTicket(roomId: string, ticket: string | null | undefined, storage: StorageLike | null = safeLocal()): void {
  write(storage, restoreKey(roomId), ticket);
}

export interface StudioJoinInput {
  roomId: string;
  name: string;
  role: ParticipantRole;
  hostToken?: string;
  coHostInviteToken?: string;
  guestInviteToken?: string;
  roomPassword?: string;
  joinSessionId?: string;
  resumeToken?: string;
  restoreTicket?: string;
  /** Host only: the owner's saved studio access key. */
  studioAccessKey?: string;
}

/** The join-room payload for a first join or a rejoin. */
export function buildStudioJoinPayload(input: StudioJoinInput): JoinRoomPayload {
  const resuming = Boolean(input.resumeToken);
  const payload: JoinRoomPayload = {
    roomId: input.roomId,
    name: input.name,
    role: input.role,
    // What this client understands, so peers send it only what it can handle (program return, talkback).
    capabilities: [...STUDIO_CAPABILITIES],
  };
  if (input.role === 'host' && input.hostToken) payload.hostToken = input.hostToken;
  if (input.role === 'host' && input.restoreTicket) payload.restoreTicket = input.restoreTicket;
  // Proves the owner's older studios are theirs (YouTube/Facebook chat keys, restore after restarts).
  if (input.role === 'host' && input.hostToken && input.studioAccessKey) payload.studioAccessKey = input.studioAccessKey;
  // Spent single-use links are not re-sent on a rejoin; the seat (or, after
  // the grace window, the redeemed invite) carries the role instead.
  if (!resuming && input.role === 'co-host' && input.coHostInviteToken) payload.coHostInviteToken = input.coHostInviteToken;
  if (!resuming && input.role === 'guest' && input.guestInviteToken) payload.guestInviteToken = input.guestInviteToken;
  if (input.role !== 'host' && input.roomPassword && !payload.coHostInviteToken) payload.roomPassword = input.roomPassword;
  if (input.joinSessionId) payload.joinSessionId = input.joinSessionId;
  if (input.resumeToken) payload.resumeToken = input.resumeToken;
  return payload;
}

/**
 * After a server restart without a database, guests reconnect before the host
 * has rebuilt the studio and are told it does not exist. Keep asking for a
 * while (2 s, 4 s, ... capped at 15 s, for about three minutes) before
 * concluding the studio really ended.
 */
export const ROOM_LOST_RETRY_WINDOW_MS = 3 * 60_000;

export function getRoomLostRetryDelayMs(attempt: number): number {
  return Math.min(15_000, 2_000 * 2 ** Math.max(0, Math.min(attempt, 6)));
}

export function shouldKeepRetryingLostRoom(firstLostAtMs: number, nowMs: number): boolean {
  return nowMs - firstLostAtMs < ROOM_LOST_RETRY_WINDOW_MS;
}
