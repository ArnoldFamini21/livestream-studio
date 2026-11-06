/**
 * Single-use invite tokens (co-host and secure guest links) travel in the URL
 * fragment, like host tokens: browsers never send the fragment to the static
 * host, so the token stays out of Hostinger access logs, and it is stripped
 * from the address bar (and so from history) as soon as the join page reads
 * it. Links sent before this change carried the token in the query string;
 * those are still accepted.
 */

export const CO_HOST_INVITE_PARAM = 'invite';
export const LEGACY_CO_HOST_INVITE_PARAM = 'token';
export const GUEST_INVITE_HASH_PARAM = 'guestInvite';

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;
const PENDING_INVITE_KEY_PREFIX = 'studioPendingInvite:';

export interface InviteTokens {
  coHost: string;
  guest: string;
}

export interface InviteLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface InviteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function validToken(value: string | null | undefined): string {
  const token = (value || '').trim();
  return INVITE_TOKEN_PATTERN.test(token) ? token : '';
}

function parseHash(hash: string): URLSearchParams {
  const normalized = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    return new URLSearchParams(normalized);
  } catch {
    return new URLSearchParams();
  }
}

function setHashParam(baseUrl: string, name: string, value: string): string {
  try {
    const url = new URL(baseUrl);
    const params = parseHash(url.hash);
    params.set(name, value);
    url.hash = params.toString();
    return url.toString();
  } catch {
    const [withoutHash, existingHash = ''] = baseUrl.split('#');
    const params = parseHash(existingHash);
    params.set(name, value);
    return `${withoutHash}#${params.toString()}`;
  }
}

/** A co-host link: the role is visible in the query, the token only in the fragment. */
export function buildCoHostInviteUrl(baseInviteUrl: string, token: string): string {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  let withRole: string;
  try {
    const url = new URL(baseInviteUrl);
    url.searchParams.set('role', 'co-host');
    withRole = url.toString();
  } catch {
    const separator = baseInviteUrl.includes('?') ? '&' : '?';
    withRole = `${baseInviteUrl}${separator}role=co-host`;
  }
  return trimmed ? setHashParam(withRole, CO_HOST_INVITE_PARAM, trimmed) : withRole;
}

/** A single-use guest link with the token in the fragment. */
export function buildSecureGuestInviteUrl(baseInviteUrl: string, token: string): string {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!trimmed) return baseInviteUrl;
  return setHashParam(baseInviteUrl, GUEST_INVITE_HASH_PARAM, trimmed);
}

/** Tokens in a URL: the fragment first, then the query string of older links. */
export function readInviteTokensFromUrl(search: string, hash: string): InviteTokens {
  const query = new URLSearchParams(search);
  const fragment = parseHash(hash);
  return {
    coHost: validToken(fragment.get(CO_HOST_INVITE_PARAM))
      || validToken(query.get(CO_HOST_INVITE_PARAM))
      || validToken(query.get(LEGACY_CO_HOST_INVITE_PARAM)),
    guest: validToken(fragment.get(GUEST_INVITE_HASH_PARAM)) || validToken(query.get(GUEST_INVITE_HASH_PARAM)),
  };
}

/** The same location without any invite token, or null when there was none to remove. */
export function stripInviteTokensFromUrl(location: InviteLocation): string | null {
  const query = new URLSearchParams(location.search);
  const fragment = parseHash(location.hash);
  let changed = false;
  for (const name of [CO_HOST_INVITE_PARAM, LEGACY_CO_HOST_INVITE_PARAM, GUEST_INVITE_HASH_PARAM]) {
    if (query.has(name)) { query.delete(name); changed = true; }
    if (fragment.has(name)) { fragment.delete(name); changed = true; }
  }
  if (!changed) return null;
  const search = query.toString();
  const hash = fragment.toString();
  return `${location.pathname}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`;
}

/**
 * Read the invite tokens for this studio once: from the URL when present
 * (keeping them in this tab's sessionStorage so a reload before pressing Join
 * still works, then removing them from the address bar), otherwise from what
 * an earlier read in this tab kept.
 */
export function captureInviteTokens(
  roomId: string | undefined,
  location: InviteLocation,
  storage: InviteStorage | null,
  replaceUrl: (url: string) => void
): InviteTokens {
  const empty: InviteTokens = { coHost: '', guest: '' };
  if (!roomId) return empty;
  const key = `${PENDING_INVITE_KEY_PREFIX}${roomId}`;
  const fromUrl = readInviteTokensFromUrl(location.search, location.hash);
  if (fromUrl.coHost || fromUrl.guest) {
    try { storage?.setItem(key, JSON.stringify(fromUrl)); } catch { /* storage is optional */ }
    const cleaned = stripInviteTokensFromUrl(location);
    if (cleaned) {
      try { replaceUrl(cleaned); } catch { /* the token still works; it just stays visible */ }
    }
    return fromUrl;
  }
  try {
    const stored = JSON.parse(storage?.getItem(key) || 'null') as Partial<InviteTokens> | null;
    if (stored && typeof stored === 'object') {
      return { coHost: validToken(stored.coHost), guest: validToken(stored.guest) };
    }
  } catch {
    /* fall through */
  }
  return empty;
}

/** Forget a kept invite once it was redeemed (or the visitor joined some other way). */
export function clearPendingInviteTokens(roomId: string | undefined, storage: InviteStorage | null): void {
  if (!roomId) return;
  try { storage?.removeItem(`${PENDING_INVITE_KEY_PREFIX}${roomId}`); } catch { /* storage is optional */ }
}

export function getBrowserInviteStorage(): InviteStorage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
