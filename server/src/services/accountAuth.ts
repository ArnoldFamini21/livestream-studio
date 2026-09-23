import { randomBytes, randomUUID, scryptSync, createHash, timingSafeEqual } from 'crypto';
import pg from 'pg';
import type {
  AccountAuthResponse,
  AccountChangePasswordResponse,
  AccountRevokeSessionsResponse,
  AccountSessionResponse,
  AccountSessionSummary,
  AccountUser,
} from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 80;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_USER_AGENT_LENGTH = 256;
/** Last-seen times are refreshed at most this often, to keep reads cheap. */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** Reset emails one account may be sent per hour. */
const MAX_PASSWORD_RESETS_PER_HOUR = 3;
const MAX_SESSIONS_LISTED = 50;

export class AccountAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AccountAuthError';
  }
}

export interface AccountAuthStore {
  init(): Promise<void>;
  createUser(record: AccountUserRecord): Promise<AccountUserRecord>;
  findUserByEmail(email: string): Promise<AccountUserRecord | null>;
  findUserById(id: string): Promise<AccountUserRecord | null>;
  saveSession(record: AccountSessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<AccountSessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  touchSession(tokenHash: string, lastSeenAt: string): Promise<void>;
  listSessionsForUser(userId: string): Promise<AccountSessionRecord[]>;
  /** Delete every session of a user except `keepTokenHash`; returns how many were removed. */
  deleteSessionsForUser(userId: string, keepTokenHash?: string): Promise<number>;
  updateUserPassword(userId: string, verifier: { passwordHash: string; passwordSalt: string }, updatedAt: string): Promise<void>;
  saveResetToken(record: AccountResetTokenRecord): Promise<void>;
  /** Remove and return a reset token; each token works once. */
  consumeResetToken(tokenHash: string): Promise<AccountResetTokenRecord | null>;
  countResetTokensSince(userId: string, since: string): Promise<number>;
  deleteResetTokensForUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AccountResetTokenRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccountUserRecord extends AccountUser {
  passwordHash: string;
  passwordSalt: string;
}

export interface AccountSessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt?: string;
  userAgent?: string;
}

/** Request details recorded with a session so the owner can recognize it later. */
export interface AccountRequestContext {
  userAgent?: string;
}

interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?: () => Promise<void>;
}

function firstConfiguredDatabaseUrl(env: Record<string, string | undefined>): string {
  for (const key of DATABASE_URL_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return '';
}

function isDisabled(value: string | undefined): boolean {
  return value ? DISABLE_VALUES.has(value.trim().toLowerCase()) : false;
}

function parsePostgresSsl(env: Record<string, string | undefined>): false | { rejectUnauthorized: boolean } | undefined {
  const value = (env.PGSSLMODE || env.POSTGRES_SSL || env.DATABASE_SSL || '').trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'disable' || value === 'false' || value === '0') return false;
  if (value === 'no-verify' || value === 'prefer' || value === 'require' || value === 'true' || value === '1') {
    return { rejectUnauthorized: false };
  }
  if (value === 'verify-full' || value === 'verify-ca') return { rejectUnauthorized: true };
  return undefined;
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLength);
}

export function normalizeAccountEmail(value: unknown): string {
  const email = safeText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function normalizeAccountName(value: unknown, fallbackEmail: string): string {
  const name = safeText(value, MAX_NAME_LENGTH);
  if (name) return name;
  return fallbackEmail.split('@')[0]?.slice(0, MAX_NAME_LENGTH) || 'Studio Host';
}

function normalizePassword(value: unknown): string {
  if (typeof value !== 'string') return '';
  const password = value.replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) return '';
  return password;
}

function safeIsoDate(value: unknown): string {
  // node-postgres returns timestamptz columns as Date instances.
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  }
  if (typeof value !== 'string') return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

export function createPasswordVerifier(password: string): { passwordHash: string; passwordSalt: string } {
  const passwordSalt = randomBytes(16).toString('base64url');
  const passwordHash = scryptSync(password, passwordSalt, 32).toString('base64url');
  return { passwordHash, passwordSalt };
}

export function verifyAccountPassword(record: AccountUserRecord, password: string): boolean {
  const expected = Buffer.from(record.passwordHash, 'base64url');
  if (expected.length !== 32) return false;
  const actual = scryptSync(password, record.passwordSalt, 32);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createAccountSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashAccountSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function getValidAccountSessionToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return TOKEN_PATTERN.test(token) ? token : '';
}

function publicUser(record: AccountUserRecord): AccountUser {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function makeSession(
  now: Date,
  userId: string,
  context: AccountRequestContext = {},
  token = createAccountSessionToken()
): { token: string; record: AccountSessionRecord } {
  return {
    token,
    record: {
      tokenHash: hashAccountSessionToken(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      lastSeenAt: now.toISOString(),
      userAgent: safeText(context.userAgent, MAX_USER_AGENT_LENGTH),
    },
  };
}

/**
 * The id shown for a session. It is derived from the token hash, so the
 * listing never exposes anything that could authenticate a request.
 */
export function getAccountSessionPublicId(tokenHash: string): string {
  return createHash('sha256').update(`account-session:${tokenHash}`).digest('base64url').slice(0, 22);
}

export async function registerAccount(
  store: AccountAuthStore,
  input: { email: unknown; name: unknown; password: unknown },
  now = new Date(),
  context: AccountRequestContext = {}
): Promise<AccountAuthResponse> {
  const email = normalizeAccountEmail(input.email);
  const password = normalizePassword(input.password);
  if (!email) {
    throw new AccountAuthError(400, 'ACCOUNT_EMAIL_INVALID', 'Enter a valid email address.');
  }
  if (!password) {
    throw new AccountAuthError(400, 'ACCOUNT_PASSWORD_INVALID', `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
  }

  const existing = await store.findUserByEmail(email);
  if (existing) {
    throw new AccountAuthError(409, 'ACCOUNT_EMAIL_EXISTS', 'An account already exists for that email.');
  }

  const verifier = createPasswordVerifier(password);
  const user = await store.createUser({
    id: randomUUID(),
    email,
    name: normalizeAccountName(input.name, email),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...verifier,
  });
  const session = makeSession(now, user.id, context);
  await store.saveSession(session.record);
  return {
    user: publicUser(user),
    session: {
      token: session.token,
      expiresAt: session.record.expiresAt,
    },
  };
}

export async function loginAccount(
  store: AccountAuthStore,
  input: { email: unknown; password: unknown },
  now = new Date(),
  context: AccountRequestContext = {}
): Promise<AccountAuthResponse> {
  const email = normalizeAccountEmail(input.email);
  const password = normalizePassword(input.password);
  if (!email || !password) {
    throw new AccountAuthError(401, 'ACCOUNT_CREDENTIALS_INVALID', 'Email or password is incorrect.');
  }

  const user = await store.findUserByEmail(email);
  if (!user || !verifyAccountPassword(user, password)) {
    throw new AccountAuthError(401, 'ACCOUNT_CREDENTIALS_INVALID', 'Email or password is incorrect.');
  }

  const session = makeSession(now, user.id, context);
  await store.saveSession(session.record);
  return {
    user: publicUser(user),
    session: {
      token: session.token,
      expiresAt: session.record.expiresAt,
    },
  };
}

export async function getAccountSession(
  store: AccountAuthStore,
  token: string,
  now = new Date()
): Promise<AccountSessionResponse> {
  const sessionToken = getValidAccountSessionToken(token);
  if (!sessionToken) return { user: null };
  const session = await store.findSession(hashAccountSessionToken(sessionToken));
  if (!session) return { user: null };
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    await store.deleteSession(session.tokenHash);
    return { user: null };
  }

  const user = await store.findUserById(session.userId);
  if (!user) {
    await store.deleteSession(session.tokenHash);
    return { user: null };
  }

  const lastSeen = Date.parse(session.lastSeenAt || session.createdAt);
  if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen >= SESSION_TOUCH_INTERVAL_MS) {
    await store.touchSession(session.tokenHash, now.toISOString());
  }

  return {
    user: publicUser(user),
    session: {
      expiresAt: session.expiresAt,
    },
  };
}

interface AuthenticatedAccount {
  user: AccountUserRecord;
  session: AccountSessionRecord;
}

async function requireAccount(store: AccountAuthStore, token: string, now: Date): Promise<AuthenticatedAccount> {
  const sessionToken = getValidAccountSessionToken(token);
  const session = sessionToken ? await store.findSession(hashAccountSessionToken(sessionToken)) : null;
  const user = session && Date.parse(session.expiresAt) > now.getTime()
    ? await store.findUserById(session.userId)
    : null;
  if (!session || !user) {
    throw new AccountAuthError(401, 'ACCOUNT_SIGNED_OUT', 'Sign in to manage your account.');
  }
  return { user, session };
}

/**
 * Change the password of the signed-in account. The current password is
 * required, and every other device is signed out; this one stays signed in.
 */
export async function changeAccountPassword(
  store: AccountAuthStore,
  token: string,
  input: { currentPassword: unknown; newPassword: unknown },
  now = new Date()
): Promise<AccountChangePasswordResponse> {
  const { user, session } = await requireAccount(store, token, now);
  const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  if (!currentPassword || !verifyAccountPassword(user, currentPassword)) {
    throw new AccountAuthError(403, 'ACCOUNT_PASSWORD_INCORRECT', 'Current password is incorrect.');
  }
  const newPassword = normalizePassword(input.newPassword);
  if (!newPassword) {
    throw new AccountAuthError(400, 'ACCOUNT_PASSWORD_INVALID', `New password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (newPassword === currentPassword) {
    throw new AccountAuthError(400, 'ACCOUNT_PASSWORD_UNCHANGED', 'Choose a password different from the current one.');
  }

  await store.updateUserPassword(user.id, createPasswordVerifier(newPassword), now.toISOString());
  await store.deleteResetTokensForUser(user.id);
  const signedOutSessions = await store.deleteSessionsForUser(user.id, session.tokenHash);
  return { ok: true, signedOutSessions };
}

export async function listAccountSessions(
  store: AccountAuthStore,
  token: string,
  now = new Date()
): Promise<AccountSessionSummary[]> {
  const { user, session: current } = await requireAccount(store, token, now);
  const sessions = await store.listSessionsForUser(user.id);
  return sessions
    .filter((session) => Date.parse(session.expiresAt) > now.getTime())
    .map((session) => ({
      id: getAccountSessionPublicId(session.tokenHash),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt || session.createdAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent || '',
      current: session.tokenHash === current.tokenHash,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, MAX_SESSIONS_LISTED);
}

/** Sign out one session of the signed-in account, found by its public id. */
export async function revokeAccountSession(
  store: AccountAuthStore,
  token: string,
  sessionId: unknown,
  now = new Date()
): Promise<{ revokedCurrent: boolean }> {
  const { user, session: current } = await requireAccount(store, token, now);
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  const target = id
    ? (await store.listSessionsForUser(user.id)).find((session) => getAccountSessionPublicId(session.tokenHash) === id)
    : undefined;
  if (!target) {
    throw new AccountAuthError(404, 'ACCOUNT_SESSION_NOT_FOUND', 'That session has already ended.');
  }
  await store.deleteSession(target.tokenHash);
  return { revokedCurrent: target.tokenHash === current.tokenHash };
}

export async function revokeOtherAccountSessions(
  store: AccountAuthStore,
  token: string,
  now = new Date()
): Promise<AccountRevokeSessionsResponse> {
  const { user, session } = await requireAccount(store, token, now);
  return { ok: true, revoked: await store.deleteSessionsForUser(user.id, session.tokenHash) };
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(`password-reset:${token}`).digest('base64url');
}

export interface PasswordResetDelivery {
  email: string;
  name: string;
  token: string;
  expiresAt: string;
}

/**
 * Start a password reset. The outcome never reveals whether the email has an
 * account: unknown emails and rate-limited accounts return exactly as a
 * delivered reset does. `deliver` sends the link (by email).
 */
export async function requestPasswordReset(
  store: AccountAuthStore,
  input: { email: unknown },
  deliver: (delivery: PasswordResetDelivery) => Promise<void>,
  now = new Date()
): Promise<{ delivered: boolean }> {
  const email = normalizeAccountEmail(input.email);
  if (!email) {
    throw new AccountAuthError(400, 'ACCOUNT_EMAIL_INVALID', 'Enter a valid email address.');
  }
  const user = await store.findUserByEmail(email);
  if (!user) return { delivered: false };

  const since = new Date(now.getTime() - PASSWORD_RESET_TTL_MS).toISOString();
  if (await store.countResetTokensSince(user.id, since) >= MAX_PASSWORD_RESETS_PER_HOUR) {
    return { delivered: false };
  }

  const token = createAccountSessionToken();
  const record: AccountResetTokenRecord = {
    tokenHash: hashPasswordResetToken(token),
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString(),
  };
  await store.saveResetToken(record);
  await deliver({ email: user.email, name: user.name, token, expiresAt: record.expiresAt });
  return { delivered: true };
}

/**
 * Finish a password reset with the emailed token. The token works once and
 * expires after an hour. Every existing session and outstanding reset link is
 * cancelled, and the caller is signed in with a fresh session.
 */
export async function confirmPasswordReset(
  store: AccountAuthStore,
  input: { token: unknown; newPassword: unknown },
  now = new Date(),
  context: AccountRequestContext = {}
): Promise<AccountAuthResponse> {
  const invalid = new AccountAuthError(400, 'ACCOUNT_RESET_INVALID', 'This reset link is invalid or has expired. Request a new one.');
  const token = getValidAccountSessionToken(input.token);
  if (!token) throw invalid;
  const newPassword = normalizePassword(input.newPassword);
  if (!newPassword) {
    throw new AccountAuthError(400, 'ACCOUNT_PASSWORD_INVALID', `New password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
  }

  const reset = await store.consumeResetToken(hashPasswordResetToken(token));
  if (!reset || Date.parse(reset.expiresAt) <= now.getTime()) throw invalid;
  const user = await store.findUserById(reset.userId);
  if (!user) throw invalid;

  await store.updateUserPassword(user.id, createPasswordVerifier(newPassword), now.toISOString());
  await store.deleteResetTokensForUser(user.id);
  await store.deleteSessionsForUser(user.id);
  const session = makeSession(now, user.id, context);
  await store.saveSession(session.record);
  return {
    user: publicUser({ ...user, updatedAt: now.toISOString() }),
    session: {
      token: session.token,
      expiresAt: session.record.expiresAt,
    },
  };
}

export async function logoutAccount(store: AccountAuthStore, token: string): Promise<void> {
  const sessionToken = getValidAccountSessionToken(token);
  if (!sessionToken) return;
  await store.deleteSession(hashAccountSessionToken(sessionToken));
}

export class InMemoryAccountAuthStore implements AccountAuthStore {
  private readonly usersById = new Map<string, AccountUserRecord>();
  private readonly userIdsByEmail = new Map<string, string>();
  private readonly sessionsByTokenHash = new Map<string, AccountSessionRecord>();
  private readonly resetTokensByHash = new Map<string, AccountResetTokenRecord>();
  /** Reset requests are counted even after their tokens are used or cancelled. */
  private resetRequestLog: Array<{ userId: string; createdAt: string }> = [];

  async init(): Promise<void> {}

  async createUser(record: AccountUserRecord): Promise<AccountUserRecord> {
    if (this.userIdsByEmail.has(record.email)) {
      throw new AccountAuthError(409, 'ACCOUNT_EMAIL_EXISTS', 'An account already exists for that email.');
    }
    this.usersById.set(record.id, record);
    this.userIdsByEmail.set(record.email, record.id);
    return record;
  }

  async findUserByEmail(email: string): Promise<AccountUserRecord | null> {
    const id = this.userIdsByEmail.get(email);
    return id ? this.usersById.get(id) || null : null;
  }

  async findUserById(id: string): Promise<AccountUserRecord | null> {
    return this.usersById.get(id) || null;
  }

  async saveSession(record: AccountSessionRecord): Promise<void> {
    this.sessionsByTokenHash.set(record.tokenHash, record);
  }

  async findSession(tokenHash: string): Promise<AccountSessionRecord | null> {
    return this.sessionsByTokenHash.get(tokenHash) || null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessionsByTokenHash.delete(tokenHash);
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    const session = this.sessionsByTokenHash.get(tokenHash);
    if (session) session.lastSeenAt = lastSeenAt;
  }

  async listSessionsForUser(userId: string): Promise<AccountSessionRecord[]> {
    return Array.from(this.sessionsByTokenHash.values())
      .filter((session) => session.userId === userId)
      .map((session) => ({ ...session }));
  }

  async deleteSessionsForUser(userId: string, keepTokenHash?: string): Promise<number> {
    let removed = 0;
    for (const [tokenHash, session] of this.sessionsByTokenHash) {
      if (session.userId !== userId || tokenHash === keepTokenHash) continue;
      this.sessionsByTokenHash.delete(tokenHash);
      removed += 1;
    }
    return removed;
  }

  async updateUserPassword(userId: string, verifier: { passwordHash: string; passwordSalt: string }, updatedAt: string): Promise<void> {
    const user = this.usersById.get(userId);
    if (user) this.usersById.set(userId, { ...user, ...verifier, updatedAt });
  }

  async saveResetToken(record: AccountResetTokenRecord): Promise<void> {
    this.resetTokensByHash.set(record.tokenHash, { ...record });
    this.resetRequestLog.push({ userId: record.userId, createdAt: record.createdAt });
  }

  async consumeResetToken(tokenHash: string): Promise<AccountResetTokenRecord | null> {
    const record = this.resetTokensByHash.get(tokenHash) || null;
    this.resetTokensByHash.delete(tokenHash);
    return record;
  }

  async countResetTokensSince(userId: string, since: string): Promise<number> {
    this.resetRequestLog = this.resetRequestLog.filter((entry) => entry.createdAt >= since);
    return this.resetRequestLog.filter((entry) => entry.userId === userId).length;
  }

  async deleteResetTokensForUser(userId: string): Promise<void> {
    for (const [tokenHash, record] of this.resetTokensByHash) {
      if (record.userId === userId) this.resetTokensByHash.delete(tokenHash);
    }
  }

  async close(): Promise<void> {}
}

export class PostgresAccountAuthStore implements AccountAuthStore {
  constructor(private readonly db: PgQueryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_accounts (
        id text PRIMARY KEY,
        email text NOT NULL UNIQUE,
        name text NOT NULL,
        password_hash text NOT NULL,
        password_salt text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_account_sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES studio_accounts(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_account_sessions_user_expires_at_idx
        ON studio_account_sessions (user_id, expires_at DESC)
    `);
    // Added with session management; existing rows keep NULL until next use.
    await this.db.query(`
      ALTER TABLE studio_account_sessions
        ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
        ADD COLUMN IF NOT EXISTS user_agent text
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_account_password_resets (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES studio_accounts(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_account_password_resets_user_created_at_idx
        ON studio_account_password_resets (user_id, created_at DESC)
    `);
  }

  async createUser(record: AccountUserRecord): Promise<AccountUserRecord> {
    try {
      await this.db.query(`
        INSERT INTO studio_accounts (
          id,
          email,
          name,
          password_hash,
          password_salt,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
      `, [
        record.id,
        record.email,
        record.name,
        record.passwordHash,
        record.passwordSalt,
        record.createdAt,
        record.updatedAt,
      ]);
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AccountAuthError(409, 'ACCOUNT_EMAIL_EXISTS', 'An account already exists for that email.');
      }
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<AccountUserRecord | null> {
    const result = await this.db.query(`
      SELECT *
      FROM studio_accounts
      WHERE email = $1
      LIMIT 1
    `, [email]);
    return normalizeStoredUser(result.rows[0]);
  }

  async findUserById(id: string): Promise<AccountUserRecord | null> {
    const result = await this.db.query(`
      SELECT *
      FROM studio_accounts
      WHERE id = $1
      LIMIT 1
    `, [id]);
    return normalizeStoredUser(result.rows[0]);
  }

  async saveSession(record: AccountSessionRecord): Promise<void> {
    await this.db.query(`
      INSERT INTO studio_account_sessions (
        token_hash,
        user_id,
        created_at,
        expires_at,
        last_seen_at,
        user_agent
      )
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6)
      ON CONFLICT (token_hash) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at,
        last_seen_at = EXCLUDED.last_seen_at,
        user_agent = EXCLUDED.user_agent
    `, [
      record.tokenHash,
      record.userId,
      record.createdAt,
      record.expiresAt,
      record.lastSeenAt || record.createdAt,
      record.userAgent || null,
    ]);
  }

  async findSession(tokenHash: string): Promise<AccountSessionRecord | null> {
    const result = await this.db.query(`
      SELECT *
      FROM studio_account_sessions
      WHERE token_hash = $1
      LIMIT 1
    `, [tokenHash]);
    return normalizeStoredSession(result.rows[0]);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM studio_account_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    await this.db.query(
      'UPDATE studio_account_sessions SET last_seen_at = $2::timestamptz WHERE token_hash = $1',
      [tokenHash, lastSeenAt]
    );
  }

  async listSessionsForUser(userId: string): Promise<AccountSessionRecord[]> {
    const result = await this.db.query(`
      SELECT *
      FROM studio_account_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 200
    `, [userId]);
    return result.rows
      .map((row) => normalizeStoredSession(row))
      .filter((session): session is AccountSessionRecord => Boolean(session));
  }

  async deleteSessionsForUser(userId: string, keepTokenHash?: string): Promise<number> {
    const result = await this.db.query(`
      DELETE FROM studio_account_sessions
      WHERE user_id = $1 AND token_hash <> $2
      RETURNING token_hash
    `, [userId, keepTokenHash || '']);
    return result.rows.length;
  }

  async updateUserPassword(userId: string, verifier: { passwordHash: string; passwordSalt: string }, updatedAt: string): Promise<void> {
    await this.db.query(`
      UPDATE studio_accounts
      SET password_hash = $2, password_salt = $3, updated_at = $4::timestamptz
      WHERE id = $1
    `, [userId, verifier.passwordHash, verifier.passwordSalt, updatedAt]);
  }

  async saveResetToken(record: AccountResetTokenRecord): Promise<void> {
    // Rows are kept for a day after creation so the hourly limit still
    // counts links that were used or cancelled.
    await this.db.query(`
      DELETE FROM studio_account_password_resets
      WHERE created_at < $1::timestamptz - interval '1 day'
    `, [record.createdAt]);
    await this.db.query(`
      INSERT INTO studio_account_password_resets (token_hash, user_id, created_at, expires_at)
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
    `, [record.tokenHash, record.userId, record.createdAt, record.expiresAt]);
  }

  async consumeResetToken(tokenHash: string): Promise<AccountResetTokenRecord | null> {
    // One statement marks the token used, so two concurrent redemptions
    // cannot both succeed.
    const result = await this.db.query(`
      UPDATE studio_account_password_resets
      SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL
      RETURNING *
    `, [tokenHash]);
    return normalizeStoredResetToken(result.rows[0]);
  }

  async countResetTokensSince(userId: string, since: string): Promise<number> {
    const result = await this.db.query(`
      SELECT count(*)::int AS count
      FROM studio_account_password_resets
      WHERE user_id = $1 AND created_at >= $2::timestamptz
    `, [userId, since]);
    return Number(result.rows[0]?.count) || 0;
  }

  async deleteResetTokensForUser(userId: string): Promise<void> {
    await this.db.query(`
      UPDATE studio_account_password_resets
      SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL
    `, [userId]);
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}

function normalizeStoredUser(value: Record<string, unknown> | undefined): AccountUserRecord | null {
  if (!value) return null;
  const id = safeText(value.id, 80);
  const email = normalizeAccountEmail(value.email);
  const name = safeText(value.name, MAX_NAME_LENGTH);
  const passwordHash = safeText(value.password_hash ?? value.passwordHash, 256);
  const passwordSalt = safeText(value.password_salt ?? value.passwordSalt, 128);
  const createdAt = safeIsoDate(value.created_at ?? value.createdAt);
  const updatedAt = safeIsoDate(value.updated_at ?? value.updatedAt);
  if (!id || !email || !name || !passwordHash || !passwordSalt || !createdAt || !updatedAt) return null;
  return {
    id,
    email,
    name,
    passwordHash,
    passwordSalt,
    createdAt,
    updatedAt,
  };
}

function normalizeStoredSession(value: Record<string, unknown> | undefined): AccountSessionRecord | null {
  if (!value) return null;
  const tokenHash = safeText(value.token_hash ?? value.tokenHash, 128);
  const userId = safeText(value.user_id ?? value.userId, 80);
  const createdAt = safeIsoDate(value.created_at ?? value.createdAt);
  const expiresAt = safeIsoDate(value.expires_at ?? value.expiresAt);
  if (!tokenHash || !userId || !createdAt || !expiresAt) return null;
  const lastSeenAt = safeIsoDate(value.last_seen_at ?? value.lastSeenAt);
  const userAgent = safeText(value.user_agent ?? value.userAgent, MAX_USER_AGENT_LENGTH);
  return {
    tokenHash,
    userId,
    createdAt,
    expiresAt,
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

function normalizeStoredResetToken(value: Record<string, unknown> | undefined): AccountResetTokenRecord | null {
  if (!value) return null;
  const tokenHash = safeText(value.token_hash ?? value.tokenHash, 128);
  const userId = safeText(value.user_id ?? value.userId, 80);
  const createdAt = safeIsoDate(value.created_at ?? value.createdAt);
  const expiresAt = safeIsoDate(value.expires_at ?? value.expiresAt);
  if (!tokenHash || !userId || !createdAt || !expiresAt) return null;
  return { tokenHash, userId, createdAt, expiresAt };
}

export function getPostgresAccountAuthConfig(env: Record<string, string | undefined>) {
  if (isDisabled(env.ACCOUNT_AUTH_PERSISTENCE_DISABLED)) return null;
  const connectionString = firstConfiguredDatabaseUrl(env);
  if (!connectionString) return null;
  return {
    connectionString,
    ssl: parsePostgresSsl(env),
  };
}

export function createAccountAuthStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): AccountAuthStore | null {
  const config = getPostgresAccountAuthConfig(env);
  if (!config) return null;
  return new PostgresAccountAuthStore(new Pool(config));
}
