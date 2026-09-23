import { Router, type Request, type Response } from 'express';
import type {
  AccountCapabilitiesResponse,
  AccountLogoutResponse,
  AccountPasswordResetRequestResponse,
  AccountSessionResponse,
  AccountSessionsResponse,
} from '@studio/shared';
import {
  AccountAuthError,
  changeAccountPassword,
  confirmPasswordReset,
  getAccountSession,
  getValidAccountSessionToken,
  InMemoryAccountAuthStore,
  listAccountSessions,
  loginAccount,
  logoutAccount,
  normalizeAccountEmail,
  registerAccount,
  requestPasswordReset,
  revokeAccountSession,
  revokeOtherAccountSessions,
  type AccountAuthStore,
  type AccountRequestContext,
} from '../services/accountAuth.js';
import {
  buildPasswordResetEmail,
  buildPasswordResetLink,
  createAccountMailerFromEnv,
  getPasswordResetUrlBase,
  type AccountMailer,
} from '../services/accountMailer.js';

const ACCOUNT_SESSION_COOKIE = 'studio_account_session';
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const authRouter = Router();

let accountAuthStore: AccountAuthStore = new InMemoryAccountAuthStore();

export function configureAccountAuthStore(store: AccountAuthStore | null) {
  accountAuthStore = store || new InMemoryAccountAuthStore();
}

let accountMailer: AccountMailer | null | undefined;
let resetUrlBase = '';

/** Override the email sender (tests); `null` disables password reset emails. */
export function configureAccountMailer(mailer: AccountMailer | null, urlBase?: string) {
  accountMailer = mailer;
  resetUrlBase = urlBase || '';
}

function getAccountMailer(): AccountMailer | null {
  if (accountMailer === undefined) accountMailer = createAccountMailerFromEnv(process.env);
  return accountMailer;
}

function requestContext(req: Request): AccountRequestContext {
  return { userAgent: req.get('user-agent') || '' };
}

function isSecureRequest(req: Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return req.secure || proto === 'https' || process.env.NODE_ENV === 'production';
}

function setAccountSessionCookie(req: Request, res: Response, token: string) {
  const secure = isSecureRequest(req);
  res.cookie(ACCOUNT_SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearAccountSessionCookie(req: Request, res: Response) {
  const secure = isSecureRequest(req);
  res.clearCookie(ACCOUNT_SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
  });
}

function readCookie(req: Request, name: string): string {
  const cookieHeader = req.headers.cookie;
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return '';
}

function readAccountSessionToken(req: Request): string {
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return getValidAccountSessionToken(bearer) || getValidAccountSessionToken(readCookie(req, ACCOUNT_SESSION_COOKIE));
}

export function getAccountSessionForRequest(req: Request): Promise<AccountSessionResponse> {
  return getAccountSession(accountAuthStore, readAccountSessionToken(req));
}

function sendAccountAuthError(res: Response, err: unknown) {
  if (err instanceof AccountAuthError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  console.error('Account auth route failed:', err instanceof Error ? err.message : err);
  res.status(500).json({ error: 'Account service failed. Please try again.', code: 'ACCOUNT_AUTH_FAILED' });
}

authRouter.post('/register', async (req, res) => {
  try {
    const result = await registerAccount(accountAuthStore, req.body, new Date(), requestContext(req));
    setAccountSessionCookie(req, res, result.session.token);
    res.status(201).json(result);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const result = await loginAccount(accountAuthStore, req.body, new Date(), requestContext(req));
    setAccountSessionCookie(req, res, result.session.token);
    res.json(result);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.get('/session', async (req, res) => {
  try {
    const token = readAccountSessionToken(req);
    const session: AccountSessionResponse = await getAccountSession(accountAuthStore, token);
    res.json(session);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.post('/logout', async (req, res) => {
  try {
    await logoutAccount(accountAuthStore, readAccountSessionToken(req));
    clearAccountSessionCookie(req, res);
    const response: AccountLogoutResponse = { ok: true };
    res.json(response);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.get('/capabilities', (_req, res) => {
  const response: AccountCapabilitiesResponse = { passwordReset: Boolean(getAccountMailer()) };
  res.json(response);
});

authRouter.post('/password', async (req, res) => {
  try {
    res.json(await changeAccountPassword(accountAuthStore, readAccountSessionToken(req), req.body || {}));
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.get('/sessions', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const response: AccountSessionsResponse = {
      sessions: await listAccountSessions(accountAuthStore, readAccountSessionToken(req)),
    };
    res.json(response);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.post('/sessions/revoke-others', async (req, res) => {
  try {
    res.json(await revokeOtherAccountSessions(accountAuthStore, readAccountSessionToken(req)));
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const result = await revokeAccountSession(accountAuthStore, readAccountSessionToken(req), req.params.sessionId);
    if (result.revokedCurrent) clearAccountSessionCookie(req, res);
    res.json({ ok: true, revokedCurrent: result.revokedCurrent });
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.post('/password-reset/request', (req, res) => {
  const mailer = getAccountMailer();
  if (!mailer) {
    res.status(503).json({ error: 'Password reset by email is not set up on this server.', code: 'ACCOUNT_RESET_UNAVAILABLE' });
    return;
  }
  const email = normalizeAccountEmail(req.body?.email);
  if (!email) {
    res.status(400).json({ error: 'Enter a valid email address.', code: 'ACCOUNT_EMAIL_INVALID' });
    return;
  }

  // Answer before looking the email up, so neither the response nor its
  // timing reveals whether the address has an account.
  const response: AccountPasswordResetRequestResponse = { ok: true };
  res.json(response);

  const base = resetUrlBase || getPasswordResetUrlBase(process.env);
  void requestPasswordReset(accountAuthStore, { email }, async (delivery) => {
    await mailer.send(buildPasswordResetEmail(delivery, buildPasswordResetLink(base, delivery.token)));
  }).catch((err) => {
    console.error('Password reset email failed:', err instanceof Error ? err.message : err);
  });
});

authRouter.post('/password-reset/confirm', async (req, res) => {
  try {
    const result = await confirmPasswordReset(accountAuthStore, req.body || {}, new Date(), requestContext(req));
    setAccountSessionCookie(req, res, result.session.token);
    res.json(result);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});
