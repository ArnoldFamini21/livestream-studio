export const GUEST_INVITE_STUDIO_PARAM = 'studio';
export const GUEST_INVITE_TOKEN_PARAM = 'guestInvite';

export interface GuestInviteEmailInput {
  roomName: string;
  inviteUrl: string;
  hostName?: string | null;
  status?: string | null;
  scheduledLabel?: string | null;
  passwordProtected?: boolean;
  recipientEmail?: string | null;
}

export interface GuestPreparationSheetInput extends GuestInviteEmailInput {
  generatedAt?: string | null;
  registrationEnabled?: boolean;
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

function normalizeInviteUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function buildGuestInviteUrl(baseUrl: string, roomId: string, roomName?: string): string {
  const normalizedBase = (baseUrl || '').replace(/\/+$/, '');
  const url = `${normalizedBase}/join/${encodeURIComponent(roomId)}`;
  const studioName = normalizeInviteStudioName(roomName);
  if (!studioName) return url;
  return `${url}?${GUEST_INVITE_STUDIO_PARAM}=${encodeURIComponent(studioName)}`;
}

export function buildSecureGuestInviteUrl(baseInviteUrl: string, token: string): string {
  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (!trimmedToken) return baseInviteUrl;
  try {
    const url = new URL(baseInviteUrl);
    url.searchParams.set(GUEST_INVITE_TOKEN_PARAM, trimmedToken);
    return url.toString();
  } catch {
    const separator = baseInviteUrl.includes('?') ? '&' : '?';
    return `${baseInviteUrl}${separator}${GUEST_INVITE_TOKEN_PARAM}=${encodeURIComponent(trimmedToken)}`;
  }
}

export function getInviteStudioName(searchParams: URLSearchParams): string {
  return normalizeInviteStudioName(searchParams.get(GUEST_INVITE_STUDIO_PARAM));
}

export function getGuestInviteToken(searchParams: URLSearchParams): string {
  const token = searchParams.get(GUEST_INVITE_TOKEN_PARAM) || '';
  return /^[A-Za-z0-9_-]{20,120}$/.test(token) ? token : '';
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

export function buildGuestPreparationSheet(input: GuestPreparationSheetInput): string {
  const roomName = normalizeInviteStudioName(input.roomName) || 'Studio';
  const hostName = normalizeInviteStudioName(input.hostName);
  const status = normalizeInviteStudioName(input.status);
  const scheduledLabel = typeof input.scheduledLabel === 'string' ? input.scheduledLabel.trim().slice(0, 120) : '';
  const generatedAt = typeof input.generatedAt === 'string' ? input.generatedAt.trim().slice(0, 120) : '';
  const inviteUrl = normalizeInviteUrl(input.inviteUrl);

  return [
    `Guest preparation sheet: ${roomName}`,
    hostName ? `Host: ${hostName}` : null,
    status ? `Status: ${status}` : null,
    scheduledLabel ? `Time: ${scheduledLabel}` : null,
    generatedAt ? `Generated: ${generatedAt}` : null,
    '',
    'Join details',
    inviteUrl ? `Join link: ${inviteUrl}` : 'Join link: Not configured',
    input.passwordProtected ? 'Password: ask the host for the password before the session.' : 'Password: not required.',
    input.registrationEnabled ? 'Registration: enter your name and email before joining.' : 'Registration: not required.',
    '',
    'Before you join',
    '1. Use an updated Chrome, Edge, or Safari browser.',
    '2. Allow camera and microphone permissions when prompted.',
    '3. Use headphones or earbuds to avoid echo.',
    '4. Join 10-15 minutes early for camera and microphone checks.',
    '5. Close noisy apps and pause downloads before entering the studio.',
    '6. Use a stable connection; wired internet is best when available.',
    '',
    'On camera',
    '1. Face a light source and keep your background tidy.',
    '2. Keep your camera at eye level.',
    '3. Stay in the green room until the host brings you on stage.',
    '4. Keep the invite link private unless the host says otherwise.',
  ].filter(Boolean).join('\n');
}
