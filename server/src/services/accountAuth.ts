import { randomBytes, randomUUID, scryptSync, createHash, timingSafeEqual } from 'crypto';
import pg from 'pg';
import type {
  AccountAuthResponse,
  AccountSessionResponse,
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
  close(): Promise<void>;
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

function makeSession(now: Date, userId: string, token = createAccountSessionToken()): { token: string; record: AccountSessionRecord } {
  return {
    token,
    record: {
      tokenHash: hashAccountSessionToken(token),
      userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    },
  };
}

export async function registerAccount(
  store: AccountAuthStore,
  input: { email: unknown; name: unknown; password: unknown },
  now = new Date()
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
  const session = makeSession(now, user.id);
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
  now = new Date()
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

  const session = makeSession(now, user.id);
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

  return {
    user: publicUser(user),
    session: {
      expiresAt: session.expiresAt,
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
        expires_at
      )
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
      ON CONFLICT (token_hash) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at
    `, [
      record.tokenHash,
      record.userId,
      record.createdAt,
      record.expiresAt,
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
  return {
    tokenHash,
    userId,
    createdAt,
    expiresAt,
  };
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
