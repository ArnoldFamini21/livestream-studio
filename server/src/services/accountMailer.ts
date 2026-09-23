/**
 * Sends account emails (password reset links). Configure one provider:
 *   RESEND_API_KEY          Resend (https://resend.com)
 *   POSTMARK_SERVER_TOKEN   Postmark (https://postmarkapp.com)
 * with ACCOUNT_EMAIL_FROM set to a sender address verified with that provider.
 * Outside production, without a provider, the link is logged to the console
 * so resets can be tested locally.
 */

import type { PasswordResetDelivery } from './accountAuth.js';

const DEFAULT_PRODUCTION_CLIENT_URL = 'https://studio.arnoldfamini.com';
const DEFAULT_DEVELOPMENT_CLIENT_URL = 'http://localhost:5173';
const SEND_TIMEOUT_MS = 10_000;

export type AccountMailerProvider = 'resend' | 'postmark' | 'console';

export interface AccountEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface AccountMailer {
  provider: AccountMailerProvider;
  send(email: AccountEmail): Promise<void>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function firstUrl(value: string | undefined): string {
  for (const item of (value || '').split(',')) {
    try {
      const url = new URL(item.trim());
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // Try the next entry.
    }
  }
  return '';
}

/**
 * Where reset links point. Never derived from request headers: a forged
 * Origin would otherwise send a real user's reset token to another site.
 */
export function getPasswordResetUrlBase(env: NodeJS.ProcessEnv = process.env): string {
  return firstUrl(env.ACCOUNT_RESET_URL_BASE)
    || firstUrl(env.CLIENT_URL)
    || firstUrl(env.CLIENT_URLS)
    || (env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_CLIENT_URL : DEFAULT_DEVELOPMENT_CLIENT_URL);
}

/** The token travels in the fragment, which browsers never send to servers or in Referer headers. */
export function buildPasswordResetLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/reset-password#token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}

export function buildPasswordResetEmail(delivery: PasswordResetDelivery, link: string): AccountEmail {
  const name = delivery.name || 'there';
  const text = [
    `Hi ${name},`,
    '',
    'Someone asked to reset the password for your Livestream Studio account.',
    'Open this link within one hour to choose a new password:',
    '',
    link,
    '',
    'If you did not ask for this, you can ignore this email; your password stays the same.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;line-height:1.5">
<p>Hi ${escapeHtml(name)},</p>
<p>Someone asked to reset the password for your Livestream Studio account. Open this link within one hour to choose a new password:</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Choose a new password</a></p>
<p style="color:#555;font-size:13px">If you did not ask for this, you can ignore this email; your password stays the same.</p>
</body></html>`;
  return { to: delivery.email, subject: 'Reset your Livestream Studio password', text, html };
}

async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Email provider returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createAccountMailerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  log: (line: string) => void = console.log
): AccountMailer | null {
  const from = env.ACCOUNT_EMAIL_FROM?.trim();
  const resendKey = env.RESEND_API_KEY?.trim();
  const postmarkToken = env.POSTMARK_SERVER_TOKEN?.trim();

  if (from && resendKey) {
    return {
      provider: 'resend',
      send: (email) => postJson(fetchImpl, 'https://api.resend.com/emails', { Authorization: `Bearer ${resendKey}` }, {
        from, to: [email.to], subject: email.subject, text: email.text, html: email.html,
      }),
    };
  }
  if (from && postmarkToken) {
    return {
      provider: 'postmark',
      send: (email) => postJson(fetchImpl, 'https://api.postmarkapp.com/email', { 'X-Postmark-Server-Token': postmarkToken }, {
        From: from, To: email.to, Subject: email.subject, TextBody: email.text, HtmlBody: email.html, MessageStream: 'outbound',
      }),
    };
  }
  if (env.NODE_ENV !== 'production') {
    return {
      provider: 'console',
      send: async (email) => {
        log(`[account email] To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}`);
      },
    };
  }
  return null;
}
