import { getValidHostToken, isLegacyHostlessCreateResponse } from './hostSession.ts';
import { postJson } from './apiClient.ts';

const HOST_ACCESS_RECOVERY_TIMEOUT_MS = 15_000;

export interface CreatedRoomResponse {
  id?: unknown;
  name?: unknown;
  status?: string;
  createdAt?: string;
  hostName?: string;
  hostToken?: unknown;
  hostId?: unknown;
  coHostIds?: unknown;
  scheduledFor?: string;
  settings?: {
    passwordProtected?: boolean;
  };
}

export type CreatedRoomWithDetails = CreatedRoomResponse & {
  id: string;
  name: string;
};

export interface CreatedRoomHostAccessResolution {
  room: CreatedRoomWithDetails;
  legacyHostless: boolean;
}

export interface ResolveCreatedRoomHostAccessOptions {
  preferLegacyFallback?: boolean;
}

export function hasCreatedRoomDetails(room: CreatedRoomResponse): room is CreatedRoomWithDetails {
  return typeof room.id === 'string' && typeof room.name === 'string';
}

async function recoverHostAccess(room: CreatedRoomWithDetails): Promise<CreatedRoomWithDetails> {
  if (typeof room.id !== 'string' || getValidHostToken(room.hostToken)) return room;

  try {
    const recoveredRoom = await postJson<CreatedRoomResponse>(
      `/api/rooms/${encodeURIComponent(room.id)}/host-access`,
      {},
      { timeoutMs: HOST_ACCESS_RECOVERY_TIMEOUT_MS }
    );
    return {
      ...room,
      ...recoveredRoom,
      id: room.id,
      name: typeof recoveredRoom.name === 'string' ? recoveredRoom.name : room.name,
      settings: recoveredRoom.settings || room.settings,
      hostName: recoveredRoom.hostName || room.hostName,
    };
  } catch (err) {
    console.warn('Host access recovery failed:', err);
    return room;
  }
}

export async function resolveCreatedRoomHostAccess(
  room: CreatedRoomWithDetails,
  options: ResolveCreatedRoomHostAccessOptions = {}
): Promise<CreatedRoomHostAccessResolution> {
  if (getValidHostToken(room.hostToken)) return { room, legacyHostless: false };
  if (options.preferLegacyFallback && isLegacyHostlessCreateResponse(room)) {
    return { room, legacyHostless: true };
  }

  const recoveredRoom = await recoverHostAccess(room);
  if (getValidHostToken(recoveredRoom.hostToken)) {
    return { room: recoveredRoom, legacyHostless: false };
  }

  return {
    room: recoveredRoom,
    legacyHostless: isLegacyHostlessCreateResponse(recoveredRoom),
  };
}
