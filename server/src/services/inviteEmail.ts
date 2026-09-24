import type { AccountEmail } from './accountMailer.js';

export type InviteEmailRole = 'guest' | 'co-host';

export interface InviteEmailRequest {
  to: string;
  role: InviteEmailRole;
  inviteUrl: string;
  roomName: string;
  hostName?: string;
  expiresAt?: string;
  scheduledFor?: string;
  passwordProtected?: boolean;
}

export class InviteEmailError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_TEXT = 120;

function cleanText(value: unknown, max = MAX_TEXT): string {
  return (typeof value === 'string' ? value : '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, max);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Validate a request to email an invite. The link must point at one of the
 * studio's own origins: this endpoint must never send someone else's URL from
 * the studio's address.
 */
export function validateInviteEmailRequest(body: unknown, allowedOrigins: Iterable<string>): InviteEmailRequest {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const to = cleanText(input.to, 254);
  if (!EMAIL_PATTERN.test(to)) throw new InviteEmailError(400, 'INVALID_EMAIL', 'Enter a valid email address');

  const role = input.role === 'co-host' ? 'co-host' : input.role === 'guest' ? 'guest' : null;
  if (!role) throw new InviteEmailError(400, 'INVALID_ROLE', 'Invite role must be guest or co-host');

  const inviteUrl = cleanText(input.inviteUrl, 2048);
  let origin = '';
  try {
    const parsed = new URL(inviteUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    origin = parsed.origin;
  } catch {
    throw new InviteEmailError(400, 'INVALID_INVITE_URL', 'Invite link is not a valid URL');
  }
  if (!new Set(allowedOrigins).has(origin)) {
    throw new InviteEmailError(400, 'INVALID_INVITE_URL', 'Invite link must point at this studio');
  }

  const roomName = cleanText(input.roomName) || 'Studio';
  const hostName = cleanText(input.hostName) || undefined;
  const expiresAt = cleanText(input.expiresAt, 40);
  const scheduledFor = cleanText(input.scheduledFor, 40);
  return {
    to,
    role,
    inviteUrl,
    roomName,
    hostName,
    expiresAt: expiresAt && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : undefined,
    scheduledFor: scheduledFor && Number.isFinite(Date.parse(scheduledFor)) ? scheduledFor : undefined,
    passwordProtected: input.passwordProtected === true,
  };
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('en-PH', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Manila' }) + ' (Manila time)';
}

/** The invite email, as plain text and simple HTML that survives every mail client. */
export function buildInviteEmail(request: InviteEmailRequest): AccountEmail {
  const roleLabel = request.role === 'co-host' ? 'co-host' : 'guest';
  const from = request.hostName ? `${request.hostName} invited you` : 'You are invited';
  const subject = `${from} to join "${request.roomName}" as a ${roleLabel}`;
  const when = formatWhen(request.scheduledFor);
  const expires = formatWhen(request.expiresAt);

  const lines = [
    `${from} to join "${request.roomName}" as a ${roleLabel}.`,
    '',
    when ? `When: ${when}` : null,
    `Join here: ${request.inviteUrl}`,
    '',
    'Before you join: use Chrome, Edge, or Safari on a computer or phone, allow the camera and microphone, and wear headphones if you can.',
    request.passwordProtected ? 'This link opens the studio without the room password.' : null,
    expires ? `This link expires on ${expires}.` : null,
    request.role === 'guest' ? 'You will wait in the green room until the host brings you on stage.' : 'As a co-host you can manage guests and the stage alongside the host.',
  ].filter((line): line is string => line !== null);

  const paragraphs = [
    `<p style="font-size:16px;margin:0 0 16px">${escapeHtml(from)} to join <strong>${escapeHtml(request.roomName)}</strong> as a ${roleLabel}.</p>`,
    when ? `<p style="margin:0 0 16px"><strong>When:</strong> ${escapeHtml(when)}</p>` : '',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(request.inviteUrl)}" style="display:inline-block;background:#6d5dfc;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Join the studio</a></p>`,
    `<p style="margin:0 0 8px;color:#555">Or copy this link: <a href="${escapeHtml(request.inviteUrl)}">${escapeHtml(request.inviteUrl)}</a></p>`,
    `<p style="margin:16px 0 8px;color:#555">Before you join: use Chrome, Edge, or Safari on a computer or phone, allow the camera and microphone, and wear headphones if you can.</p>`,
    request.passwordProtected ? `<p style="margin:0 0 8px;color:#555">This link opens the studio without the room password.</p>` : '',
    expires ? `<p style="margin:0 0 8px;color:#555">This link expires on ${escapeHtml(expires)}.</p>` : '',
    `<p style="margin:0;color:#555">${request.role === 'guest' ? 'You will wait in the green room until the host brings you on stage.' : 'As a co-host you can manage guests and the stage alongside the host.'}</p>`,
  ].filter(Boolean).join('\n');

  return {
    to: request.to,
    subject,
    text: lines.join('\n'),
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;padding:24px;max-width:560px">${paragraphs}</body></html>`,
  };
}
