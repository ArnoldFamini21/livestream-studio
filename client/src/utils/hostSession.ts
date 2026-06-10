import type { ParticipantRole } from '@studio/shared';

export const HOST_STUDIOS_STORAGE_KEY = 'livestream-studio:scheduled-studios';

const HOST_TOKEN_PREFIX = 'hostToken:';
const USER_NAME_KEY = 'userName';
const USER_ROLE_KEY = 'userRole';

export interface SavedHostStudio {
  id: string;
  name?: string;
  hostName: string;
  hostToken: string;
  createdAt?: string;
  scheduledFor?: string;
  passwordProtected?: boolean;
  status?: string;
}

export interface HostSession {
  roomId: string;
  hostName: string;
  hostToken: string;
  source: 'session' | 'saved';
}

function getSessionItem(key: string): string {
  try {
    return sessionStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function setSessionItem(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in restrictive browser modes.
  }
}

function removeSessionItem(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in restrictive browser modes.
  }
}

function getLocalItem(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function setLocalItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Host access still works for the current tab via sessionStorage.
  }
}

function isValidHostToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

function hostTokenKey(roomId: string): string {
  return `${HOST_TOKEN_PREFIX}${roomId}`;
}

export function getStoredUserName(): string {
  return getSessionItem(USER_NAME_KEY);
}

export function getStoredParticipantRole(): ParticipantRole {
  const role = getSessionItem(USER_ROLE_KEY);
  return role === 'host' || role === 'co-host' || role === 'guest' ? role : 'guest';
}

export function readSavedHostStudios(): SavedHostStudio[] {
  try {
    const parsed = JSON.parse(getLocalItem(HOST_STUDIOS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SavedHostStudio => (
        item &&
        typeof item.id === 'string' &&
        typeof item.hostName === 'string' &&
        typeof item.hostToken === 'string' &&
        isValidHostToken(item.hostToken)
      ))
      .sort((a, b) => {
        const aTime = Date.parse(a.scheduledFor || a.createdAt || '');
        const bTime = Date.parse(b.scheduledFor || b.createdAt || '');
        if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
        if (!Number.isFinite(aTime)) return 1;
        if (!Number.isFinite(bTime)) return -1;
        return aTime - bTime;
      });
  } catch {
    return [];
  }
}

export function getSavedHostStudio(roomId: string): SavedHostStudio | null {
  return readSavedHostStudios().find((studio) => studio.id === roomId) || null;
}

export function upsertSavedHostStudio(studio: SavedHostStudio): SavedHostStudio[] {
  if (!isValidHostToken(studio.hostToken)) return readSavedHostStudios();
  const next = [studio, ...readSavedHostStudios().filter((item) => item.id !== studio.id)]
    .slice(0, 20)
    .sort((a, b) => {
      const aTime = Date.parse(a.scheduledFor || a.createdAt || '');
      const bTime = Date.parse(b.scheduledFor || b.createdAt || '');
      if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
      if (!Number.isFinite(aTime)) return 1;
      if (!Number.isFinite(bTime)) return -1;
      return aTime - bTime;
    });
  setLocalItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeSavedHostStudio(roomId: string): SavedHostStudio[] {
  const next = readSavedHostStudios().filter((item) => item.id !== roomId);
  setLocalItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(next));
  removeSessionItem(hostTokenKey(roomId));
  return next;
}

export function getHostSession(roomId: string): HostSession | null {
  const sessionHostToken = getSessionItem(hostTokenKey(roomId));
  const savedHostStudio = getSavedHostStudio(roomId);
  const hasValidSessionToken = isValidHostToken(sessionHostToken);
  const hostToken = hasValidSessionToken ? sessionHostToken : savedHostStudio?.hostToken || '';
  if (!isValidHostToken(hostToken)) return null;

  return {
    roomId,
    hostName: hasValidSessionToken
      ? getStoredUserName() || savedHostStudio?.hostName || 'Host'
      : savedHostStudio?.hostName || getStoredUserName() || 'Host',
    hostToken,
    source: hasValidSessionToken ? 'session' : 'saved',
  };
}

export function persistHostSession(input: { roomId: string; hostName: string; hostToken: string }) {
  if (!isValidHostToken(input.hostToken)) return;
  setSessionItem(USER_ROLE_KEY, 'host');
  setSessionItem(USER_NAME_KEY, input.hostName || 'Host');
  setSessionItem(hostTokenKey(input.roomId), input.hostToken);
}
