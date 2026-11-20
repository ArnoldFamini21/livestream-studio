import { WATCH_TOKEN_PATTERN } from '@studio/shared';

export interface WatchAccess {
  token: string;
  expiresAt: string;
}

const INVITE_PARAM = 'watchInvite';

export function isWatchAccess(value: unknown, now = Date.now()): value is WatchAccess {
  if (!value || typeof value !== 'object') return false;
  const access = value as Partial<WatchAccess>;
  return typeof access.token === 'string' && WATCH_TOKEN_PATTERN.test(access.token) &&
    typeof access.expiresAt === 'string' && Date.parse(access.expiresAt) > now;
}

export function watchAuthHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function buildPrivateWatchUrl(base: string, token: string): string {
  const url = new URL(base);
  url.hash = new URLSearchParams({ [INVITE_PARAM]: token }).toString();
  return url.toString();
}

export function readWatchInvite(watchId: string): string {
  try {
    const token = new URLSearchParams(window.location.hash.slice(1)).get(INVITE_PARAM) ||
      sessionStorage.getItem(`studio:watch-invite:${watchId}`) || '';
    return WATCH_TOKEN_PATTERN.test(token) ? token : '';
  } catch {
    return '';
  }
}

export function captureWatchInvite(watchId: string): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get(INVITE_PARAM);
  if (token === null) return;
  params.delete(INVITE_PARAM);
  try {
    if (WATCH_TOKEN_PATTERN.test(token)) sessionStorage.setItem(`studio:watch-invite:${watchId}`, token);
  } catch { /* Anyone can watch without storage once authorized. */ }
  try {
    const url = new URL(window.location.href);
    url.hash = params.toString();
    window.history.replaceState(window.history.state, '', url);
  } catch { /* Invites still work if the address cannot be changed. */ }
}

export function readWatchAccess(watchId: string): WatchAccess | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(`studio:watch-access:${watchId}`) || 'null');
    return isWatchAccess(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveWatchAccess(watchId: string, access: WatchAccess | null): void {
  try {
    const key = `studio:watch-access:${watchId}`;
    if (access) sessionStorage.setItem(key, JSON.stringify(access));
    else sessionStorage.removeItem(key);
  } catch { /* The current page keeps access in memory. */ }
}
