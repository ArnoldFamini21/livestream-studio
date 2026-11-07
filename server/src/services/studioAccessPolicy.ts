import { timingSafeEqual } from 'node:crypto';

/** Env-only studio creation policy, shared by the HTTP guard and signaling (no request or store imports). */

export interface StudioCreationPolicy {
  /** True when an owner allowlist or a create secret is configured. */
  gated: boolean;
  ownerEmails: Set<string>;
  createSecret: string;
}

export function parseEmailList(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const item of (raw || '').split(',')) {
    const email = item.trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

export function getStudioCreationPolicy(env: NodeJS.ProcessEnv = process.env): StudioCreationPolicy {
  const ownerEmails = parseEmailList(env.STUDIO_OWNER_EMAILS);
  const createSecret = (env.STUDIO_CREATE_SECRET || '').trim();
  return { gated: ownerEmails.size > 0 || createSecret.length > 0, ownerEmails, createSecret };
}

export function isStudioCreationGated(env: NodeJS.ProcessEnv = process.env): boolean {
  return getStudioCreationPolicy(env).gated;
}

export function isStudioOwnerEmail(email: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!email) return false;
  return getStudioCreationPolicy(env).ownerEmails.has(email.trim().toLowerCase());
}

export function safeSecretMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
