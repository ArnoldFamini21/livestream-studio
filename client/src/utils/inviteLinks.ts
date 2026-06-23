export const GUEST_INVITE_STUDIO_PARAM = 'studio';

export function normalizeInviteStudioName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export function buildGuestInviteUrl(baseUrl: string, roomId: string, roomName?: string): string {
  const normalizedBase = (baseUrl || '').replace(/\/+$/, '');
  const url = `${normalizedBase}/join/${encodeURIComponent(roomId)}`;
  const studioName = normalizeInviteStudioName(roomName);
  if (!studioName) return url;
  return `${url}?${GUEST_INVITE_STUDIO_PARAM}=${encodeURIComponent(studioName)}`;
}

export function getInviteStudioName(searchParams: URLSearchParams): string {
  return normalizeInviteStudioName(searchParams.get(GUEST_INVITE_STUDIO_PARAM));
}
