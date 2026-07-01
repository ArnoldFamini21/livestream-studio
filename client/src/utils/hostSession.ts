import type { ParticipantRole } from '@studio/shared';

export const HOST_STUDIOS_STORAGE_KEY = 'livestream-studio:host-studios';

const HOST_TOKEN_PREFIX = 'hostToken:';
const LEGACY_HOST_SESSION_PREFIX = 'legacyHost:';
const LEGACY_HOST_STUDIOS_STORAGE_KEY = 'livestream-studio:scheduled-studios';
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
  source: 'url' | 'session' | 'saved' | 'legacy';
}

export interface LegacyHostlessCreateResponseLike {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  hostName?: unknown;
  hostToken?: unknown;
  hostId?: unknown;
  coHostIds?: unknown;
  settings?: unknown;
}

const LEGACY_HOST_SESSION_VERSION = 'v2';
const LEGACY_HOST_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

export function isValidHostToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

export function getValidHostToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return isValidHostToken(normalized) ? normalized : '';
}

export function isLegacyHostlessCreateResponse(room: LegacyHostlessCreateResponseLike): boolean {
  if (getValidHostToken(room.hostToken)) return false;
  if (typeof room.hostId === 'string' || Array.isArray(room.coHostIds)) return true;
  if (typeof room.id !== 'string' || typeof room.name !== 'string') return false;
  return (
    typeof room.status === 'string' ||
    typeof room.hostName === 'string' ||
    isRecord(room.settings)
  );
}

function sortHostStudios(rooms: SavedHostStudio[]): SavedHostStudio[] {
  return rooms.sort((a, b) => {
    const aTime = Date.parse(a.scheduledFor || a.createdAt || '');
    const bTime = Date.parse(b.scheduledFor || b.createdAt || '');
    if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return 0;
    if (!Number.isFinite(aTime)) return 1;
    if (!Number.isFinite(bTime)) return -1;
    return aTime - bTime;
  });
}

function parseSavedHostStudios(raw: string): SavedHostStudio[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedHostStudio => (
      item &&
      typeof item.id === 'string' &&
      typeof item.hostName === 'string' &&
      typeof item.hostToken === 'string' &&
      isValidHostToken(item.hostToken)
    ));
  } catch {
    return [];
  }
}

function mergeHostStudios(primary: SavedHostStudio[], legacy: SavedHostStudio[]): SavedHostStudio[] {
  const byId = new Map<string, SavedHostStudio>();
  for (const studio of legacy) byId.set(studio.id, studio);
  for (const studio of primary) byId.set(studio.id, studio);
  return sortHostStudios(Array.from(byId.values()));
}

function hostTokenKey(roomId: string): string {
  return `${HOST_TOKEN_PREFIX}${roomId}`;
}

function legacyHostKey(roomId: string): string {
  return `${LEGACY_HOST_SESSION_PREFIX}${roomId}`;
}

function createLegacyHostMarker(nowMs = Date.now()): string {
  return `${LEGACY_HOST_SESSION_VERSION}:${Math.floor(nowMs)}`;
}

function isFreshLegacyHostMarker(value: string, nowMs = Date.now()): boolean {
  const [version, issuedAt] = value.split(':');
  if (version !== LEGACY_HOST_SESSION_VERSION || !issuedAt) return false;
  const issuedAtMs = Number(issuedAt);
  return Number.isFinite(issuedAtMs) && issuedAtMs > 0 && nowMs - issuedAtMs <= LEGACY_HOST_SESSION_TTL_MS;
}

export function buildHostEntryPath(roomId: string, hostToken?: string): string {
  const path = `/join/${encodeURIComponent(roomId)}?role=host`;
  if (!hostToken || !isValidHostToken(hostToken)) return path;
  return `${path}#hostToken=${encodeURIComponent(hostToken)}`;
}

export function buildHostEntryUrl(baseUrl: string, roomId: string, hostToken?: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${buildHostEntryPath(roomId, hostToken)}`;
}

export function readHostTokenFromHash(hash: string): string {
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!normalized) return '';
  try {
    const params = new URLSearchParams(normalized);
    const token = params.get('hostToken') || params.get('host') || '';
    return isValidHostToken(token) ? token : '';
  } catch {
    return '';
  }
}

export function getUrlHostToken(): string {
  if (typeof window === 'undefined') return '';
  return readHostTokenFromHash(window.location.hash || '');
}

export function clearUrlHostToken() {
  if (typeof window === 'undefined') return;
  if (!readHostTokenFromHash(window.location.hash || '')) return;
  const cleanUrl = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, '', cleanUrl);
}

export function getStoredUserName(): string {
  return getSessionItem(USER_NAME_KEY);
}

export function getStoredParticipantRole(): ParticipantRole {
  const role = getSessionItem(USER_ROLE_KEY);
  return role === 'host' || role === 'co-host' || role === 'guest' ? role : 'guest';
}

export function readSavedHostStudios(): SavedHostStudio[] {
  const primary = parseSavedHostStudios(getLocalItem(HOST_STUDIOS_STORAGE_KEY));
  const legacy = parseSavedHostStudios(getLocalItem(LEGACY_HOST_STUDIOS_STORAGE_KEY));
  const rooms = mergeHostStudios(primary, legacy);
  if (legacy.length > 0 && primary.length !== rooms.length) {
    setLocalItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(rooms.slice(0, 20)));
  }
  return rooms;
}

export function getSavedHostStudio(roomId: string): SavedHostStudio | null {
  return readSavedHostStudios().find((studio) => studio.id === roomId) || null;
}

export function upsertSavedHostStudio(studio: SavedHostStudio): SavedHostStudio[] {
  if (!isValidHostToken(studio.hostToken)) return readSavedHostStudios();
  const next = sortHostStudios([studio, ...readSavedHostStudios().filter((item) => item.id !== studio.id)]).slice(0, 20);
  setLocalItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeSavedHostStudio(roomId: string): SavedHostStudio[] {
  const next = readSavedHostStudios().filter((item) => item.id !== roomId);
  setLocalItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(next));
  const nextLegacy = parseSavedHostStudios(getLocalItem(LEGACY_HOST_STUDIOS_STORAGE_KEY))
    .filter((item) => item.id !== roomId);
  setLocalItem(LEGACY_HOST_STUDIOS_STORAGE_KEY, JSON.stringify(nextLegacy));
  removeSessionItem(hostTokenKey(roomId));
  removeSessionItem(legacyHostKey(roomId));
  return next;
}

export function getHostSession(roomId: string, urlHostToken = ''): HostSession | null {
  const savedHostStudio = getSavedHostStudio(roomId);
  if (isValidHostToken(urlHostToken)) {
    return {
      roomId,
      hostName: savedHostStudio?.hostName || getStoredUserName() || 'Host',
      hostToken: urlHostToken,
      source: 'url',
    };
  }

  const sessionHostToken = getSessionItem(hostTokenKey(roomId));
  const hasValidSessionToken = isValidHostToken(sessionHostToken);
  const hostToken = hasValidSessionToken ? sessionHostToken : savedHostStudio?.hostToken || '';
  if (!isValidHostToken(hostToken)) return getLegacyHostSession(roomId);

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
  removeSessionItem(legacyHostKey(input.roomId));
}

export function getLegacyHostSession(roomId: string): HostSession | null {
  const marker = getSessionItem(legacyHostKey(roomId));
  if (getSessionItem(USER_ROLE_KEY) !== 'host' || !isFreshLegacyHostMarker(marker)) return null;
  return {
    roomId,
    hostName: getStoredUserName() || 'Host',
    hostToken: '',
    source: 'legacy',
  };
}

export function persistLegacyHostSession(input: { roomId: string; hostName: string }) {
  setSessionItem(USER_ROLE_KEY, 'host');
  setSessionItem(USER_NAME_KEY, input.hostName || 'Host');
  removeSessionItem(hostTokenKey(input.roomId));
  setSessionItem(legacyHostKey(input.roomId), createLegacyHostMarker());
}
