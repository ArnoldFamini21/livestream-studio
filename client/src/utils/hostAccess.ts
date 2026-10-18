import type { RoomRegistrationSettings } from '@studio/shared';
import { getValidHostToken } from './hostSession.ts';

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
  registration?: RoomRegistrationSettings;
}

export type CreatedRoomWithDetails = CreatedRoomResponse & {
  id: string;
  name: string;
};

export interface CreatedRoomHostAccessResolution {
  room: CreatedRoomWithDetails;
  legacyHostless: boolean;
}

export function hasCreatedRoomDetails(room: CreatedRoomResponse): room is CreatedRoomWithDetails {
  return typeof room.id === 'string' && typeof room.name === 'string';
}

export async function resolveCreatedRoomHostAccess(
  room: CreatedRoomWithDetails
): Promise<CreatedRoomHostAccessResolution> {
  if (getValidHostToken(room.hostToken)) return { room, legacyHostless: false };
  // Creation must return the capability. An IP-based recovery request or local
  // "host" marker cannot establish ownership of a room.
  throw new Error('Studio was created without a private host credential. Please create a new studio.');
}
