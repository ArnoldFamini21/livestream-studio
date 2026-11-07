import type { NextFunction, Request, Response } from 'express';
import { getAccountSessionForRequest } from '../routes/auth.js';
import { getStudioCreationPolicy, isStudioCreationGated, safeSecretMatch } from './studioAccessPolicy.js';

export {
  getStudioCreationPolicy,
  isStudioCreationGated,
  isStudioOwnerEmail,
  parseEmailList,
  safeSecretMatch,
  type StudioCreationPolicy,
} from './studioAccessPolicy.js';

/**
 * Who may create a studio.
 *
 * A studio's host token unlocks the owner's media server (live relays,
 * recordings), TURN relay, YouTube/Facebook chat keys and server memory, so
 * creating one is an owner action. The owner proves it with either:
 *   - an account session whose email is listed in STUDIO_OWNER_EMAILS, or
 *   - the X-Studio-Access-Key header matching STUDIO_CREATE_SECRET.
 *
 * When neither variable is set, creation stays open (the behavior before the
 * gate existed) so a deploy never locks the owner out; /health reports it as a
 * production-readiness warning until the owner configures one of them.
 */

export const STUDIO_ACCESS_KEY_HEADER = 'x-studio-access-key';
export const STUDIO_ACCESS_REQUIRED_CODE = 'STUDIO_ACCESS_REQUIRED';
const MAX_ACCESS_KEY_LENGTH = 512;

export type StudioCreatorAuthorization =
  | { ok: true; createdByOwner: boolean; via: 'open' | 'account' | 'access-key' }
  | { ok: false; status: 401 | 403; code: typeof STUDIO_ACCESS_REQUIRED_CODE; error: string };

export interface AuthorizeStudioCreatorOptions {
  env?: NodeJS.ProcessEnv;
  resolveAccountUser?: (req: Request) => Promise<{ id: string; email: string } | null>;
}

function readHeader(req: Request, name: string): string {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_ACCESS_KEY_LENGTH) : '';
}

const defaultResolveAccountUser = async (req: Request) => {
  const session = await getAccountSessionForRequest(req);
  return session.user ? { id: session.user.id, email: session.user.email } : null;
};

export async function authorizeStudioCreator(
  req: Request,
  options: AuthorizeStudioCreatorOptions = {}
): Promise<StudioCreatorAuthorization> {
  const policy = getStudioCreationPolicy(options.env || process.env);
  if (!policy.gated) return { ok: true, createdByOwner: false, via: 'open' };

  const presentedKey = readHeader(req, STUDIO_ACCESS_KEY_HEADER);
  if (policy.createSecret && safeSecretMatch(presentedKey, policy.createSecret)) {
    return { ok: true, createdByOwner: true, via: 'access-key' };
  }

  if (policy.ownerEmails.size > 0) {
    const user = await (options.resolveAccountUser || defaultResolveAccountUser)(req).catch(() => null);
    if (user && policy.ownerEmails.has(user.email.trim().toLowerCase())) {
      return { ok: true, createdByOwner: true, via: 'account' };
    }
    if (user) {
      return {
        ok: false,
        status: 403,
        code: STUDIO_ACCESS_REQUIRED_CODE,
        error: 'This account is not allowed to create studios on this server. Enter the studio access key or sign in as the owner.',
      };
    }
  }

  return {
    ok: false,
    status: presentedKey ? 403 : 401,
    code: STUDIO_ACCESS_REQUIRED_CODE,
    error: presentedKey
      ? 'That studio access key is not correct.'
      : 'Creating a studio on this server needs the owner’s studio access key or owner account.',
  };
}

/** Express guard for the room-creation routes; the result is left in res.locals.studioCreator. */
export function createRequireStudioCreator(options: AuthorizeStudioCreatorOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = await authorizeStudioCreator(req, options);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, code: auth.code });
      return;
    }
    res.locals.studioCreator = auth;
    next();
  };
}

export const requireStudioCreator = createRequireStudioCreator();

let openCreationWarningLogged = false;
/** Logs once per process when studio creation is open to anyone. */
export function warnIfStudioCreationOpen(env: NodeJS.ProcessEnv = process.env, log: (message: string) => void = console.warn): void {
  if (openCreationWarningLogged || isStudioCreationGated(env)) return;
  openCreationWarningLogged = true;
  log('Studio creation is open to anyone: set STUDIO_OWNER_EMAILS or STUDIO_CREATE_SECRET so only the owner can create studios.');
}
