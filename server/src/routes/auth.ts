import { Router, type Request, type Response } from 'express';
import type { AccountLogoutResponse, AccountSessionResponse } from '@studio/shared';
import {
  AccountAuthError,
  getAccountSession,
  getValidAccountSessionToken,
  InMemoryAccountAuthStore,
  loginAccount,
  logoutAccount,
  registerAccount,
  type AccountAuthStore,
} from '../services/accountAuth.js';

const ACCOUNT_SESSION_COOKIE = 'studio_account_session';
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const authRouter = Router();

let accountAuthStore: AccountAuthStore = new InMemoryAccountAuthStore();

export function configureAccountAuthStore(store: AccountAuthStore | null) {
  accountAuthStore = store || new InMemoryAccountAuthStore();
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
    const result = await registerAccount(accountAuthStore, req.body);
    setAccountSessionCookie(req, res, result.session.token);
    res.status(201).json(result);
  } catch (err) {
    sendAccountAuthError(res, err);
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const result = await loginAccount(accountAuthStore, req.body);
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
