export const GUEST_INVITE_STUDIO_PARAM = 'studio';

export interface GuestInviteEmailInput {
  roomName: string;
  inviteUrl: string;
  hostName?: string | null;
  status?: string | null;
  scheduledLabel?: string | null;
  passwordProtected?: boolean;
  recipientEmail?: string | null;
}

export function normalizeInviteStudioName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export function normalizeInviteEmailRecipient(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/[\x00-\x1F\x7F\s]+/g, '')
    .slice(0, 320);
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

export function buildGuestInviteDetails(input: GuestInviteEmailInput): string {
  const roomName = normalizeInviteStudioName(input.roomName) || 'Studio Invite';
  const hostName = normalizeInviteStudioName(input.hostName);
  const status = normalizeInviteStudioName(input.status);
  const scheduledLabel = typeof input.scheduledLabel === 'string' ? input.scheduledLabel.trim().slice(0, 120) : '';

  return [
    roomName,
    hostName ? `Host: ${hostName}` : null,
    status ? `Status: ${status}` : null,
    scheduledLabel ? `Time: ${scheduledLabel}` : null,
    `Join: ${input.inviteUrl}`,
    input.passwordProtected ? 'Password protected. Ask the host for the password.' : null,
  ].filter(Boolean).join('\n');
}

export function buildGuestInviteEmailHref(input: GuestInviteEmailInput): string {
  const recipientEmail = normalizeInviteEmailRecipient(input.recipientEmail);
  const roomName = normalizeInviteStudioName(input.roomName) || 'Studio';
  const subject = encodeURIComponent(`Join ${roomName}`);
  const body = encodeURIComponent(buildGuestInviteDetails(input));

  return `mailto:${recipientEmail ? encodeURIComponent(recipientEmail) : ''}?subject=${subject}&body=${body}`;
}
