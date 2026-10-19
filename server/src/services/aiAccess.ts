import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getAccountSessionForRequest } from '../routes/auth.js';

const DEFAULT_GLOBAL_HOURLY_BUDGET = 60;
const DEFAULT_ACTOR_HOURLY_BUDGET = 15;
const DEFAULT_MAX_CONCURRENT = 3;
const BUDGET_WINDOW_MS = 60 * 60 * 1000;
const MAX_ACTOR_BUCKETS = 10_000;

interface BudgetWindow {
  count: number;
  resetAt: number;
}

export interface AiUsageGuardOptions {
  globalHourlyBudget?: number;
  actorHourlyBudget?: number;
  maxConcurrent?: number;
  windowMs?: number;
}

export class AiUsageGuard {
  private globalWindow: BudgetWindow = { count: 0, resetAt: 0 };
  private readonly actorWindows = new Map<string, BudgetWindow>();
  private activeCount = 0;
  private readonly globalHourlyBudget: number;
  private readonly actorHourlyBudget: number;
  private readonly maxConcurrent: number;
  private readonly windowMs: number;

  constructor(options: AiUsageGuardOptions = {}) {
    this.globalHourlyBudget = Math.max(
      1,
      options.globalHourlyBudget ?? (Number(process.env.OPENAI_HOURLY_BUDGET) || DEFAULT_GLOBAL_HOURLY_BUDGET)
    );
    this.actorHourlyBudget = Math.max(
      1,
      options.actorHourlyBudget ?? (Number(process.env.OPENAI_ACTOR_HOURLY_BUDGET) || DEFAULT_ACTOR_HOURLY_BUDGET)
    );
    this.maxConcurrent = Math.max(
      1,
      options.maxConcurrent ?? (Number(process.env.OPENAI_MAX_CONCURRENT) || DEFAULT_MAX_CONCURRENT)
    );
    this.windowMs = Math.max(1_000, options.windowMs ?? BUDGET_WINDOW_MS);
  }

  acquire(actorKey: string, nowMs = Date.now()): { ok: true; release: () => void } | { ok: false; status: number; code: string; error: string; retryAfterSeconds?: number } {
    if (this.activeCount >= this.maxConcurrent) {
      return {
        ok: false,
        status: 429,
        code: 'AI_CONCURRENCY_LIMIT',
        error: 'AI processing is busy right now. Please try again in a moment.',
        retryAfterSeconds: 5,
      };
    }

    if (nowMs > this.globalWindow.resetAt) {
      this.globalWindow = { count: 0, resetAt: nowMs + this.windowMs };
    }
    if (this.globalWindow.count >= this.globalHourlyBudget) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.globalWindow.resetAt - nowMs) / 1000));
      return {
        ok: false,
        status: 429,
        code: 'AI_GLOBAL_BUDGET_EXCEEDED',
        error: 'The studio AI hourly budget has been reached. Please try again later.',
        retryAfterSeconds,
      };
    }

    const normalizedActor = actorKey.trim() || 'anonymous';
    let actorWindow = this.actorWindows.get(normalizedActor);
    if (!actorWindow || nowMs > actorWindow.resetAt) {
      if (this.actorWindows.size >= MAX_ACTOR_BUCKETS && !this.actorWindows.has(normalizedActor)) {
        const oldestKey = this.actorWindows.keys().next().value;
        if (oldestKey !== undefined) this.actorWindows.delete(oldestKey);
      }
      actorWindow = { count: 0, resetAt: nowMs + this.windowMs };
      this.actorWindows.set(normalizedActor, actorWindow);
    }

    if (actorWindow.count >= this.actorHourlyBudget) {
      const retryAfterSeconds = Math.max(1, Math.ceil((actorWindow.resetAt - nowMs) / 1000));
      return {
        ok: false,
        status: 429,
        code: 'AI_ACTOR_BUDGET_EXCEEDED',
        error: 'Your hourly AI request limit has been reached. Please try again later.',
        retryAfterSeconds,
      };
    }

    this.globalWindow.count += 1;
    actorWindow.count += 1;
    this.activeCount += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
      },
    };
  }
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() || '';
  return value?.trim() || '';
}

function safeTokenMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseAllowedEmails(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const item of raw.split(',')) {
    const email = item.trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

export interface AuthorizeAiRequestOptions {
  env?: NodeJS.ProcessEnv;
  resolveAccountUser?: (req: Request) => Promise<{ id: string; email: string } | null>;
}

export async function authorizeAiRequest(
  req: Request,
  options: AuthorizeAiRequestOptions = {}
): Promise<{ ok: true; actorKey: string } | { ok: false; status: number; code: string; error: string }> {
  const env = options.env || process.env;
  const allowedEmails = parseAllowedEmails(env.OPENAI_ALLOWED_ACCOUNT_EMAILS);
  const configuredToken = (env.OPENAI_ACCESS_TOKEN || '').trim();
  const requireAccountAuth =
    env.OPENAI_REQUIRE_ACCOUNT_AUTH === 'true' ||
    allowedEmails.size > 0;

  if (configuredToken) {
    const headerToken = getHeaderValue(req.headers['x-studio-ai-token']);
    const authHeader = getHeaderValue(req.headers.authorization);
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (safeTokenMatch(headerToken, configuredToken) || safeTokenMatch(bearer, configuredToken)) {
      return { ok: true, actorKey: 'token:operator' };
    }
    if (!requireAccountAuth) {
      return {
        ok: false,
        status: 401,
        code: 'AI_AUTH_REQUIRED',
        error: 'A valid studio AI access token is required.',
      };
    }
  }

  const resolveUser = options.resolveAccountUser || (async (request: Request) => {
    const session = await getAccountSessionForRequest(request);
    return session.user ? { id: session.user.id, email: session.user.email } : null;
  });

  const user = await resolveUser(req).catch(() => null);
  if (requireAccountAuth) {
    if (!user) {
      return {
        ok: false,
        status: 401,
        code: 'AI_ACCOUNT_REQUIRED',
        error: 'Sign in to your studio account to use AI features.',
      };
    }
    if (allowedEmails.size > 0 && !allowedEmails.has(user.email.trim().toLowerCase())) {
      return {
        ok: false,
        status: 403,
        code: 'AI_ACCOUNT_NOT_ENTITLED',
        error: 'Your account is not enabled for AI features on this server.',
      };
    }
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return {
    ok: true,
    actorKey: user ? `account:${user.id}` : `ip:${ip}`,
  };
}

const defaultAiUsageGuard = new AiUsageGuard();

export function createAiRouteAccessMiddleware(
  guard: AiUsageGuard = defaultAiUsageGuard,
  options: AuthorizeAiRequestOptions = {}
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = await authorizeAiRequest(req, options);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, code: auth.code });
      return;
    }

    const lease = guard.acquire(auth.actorKey);
    if (!lease.ok) {
      if (lease.retryAfterSeconds) {
        res.setHeader('Retry-After', String(lease.retryAfterSeconds));
      }
      res.status(lease.status).json({ error: lease.error, code: lease.code });
      return;
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      lease.release();
    };
    res.on('finish', cleanup);
    res.on('close', cleanup);
    next();
  };
}
