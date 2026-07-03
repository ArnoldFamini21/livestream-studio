import pg from 'pg';
import type {
  RoomStatus,
  WorkspaceStudioCatalogEntry,
  WorkspaceStudioCatalogListResponse,
} from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const MAX_STUDIOS_PER_ROOM = 100;
const HOST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const ROOM_STATUSES: RoomStatus[] = ['waiting', 'scheduled', 'live', 'recording', 'ended'];

export class WorkspaceStudioCatalogError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceStudioCatalogError';
  }
}

export interface WorkspaceStudioCatalogStore {
  init(): Promise<void>;
  upsertStudio(roomId: string, entry: WorkspaceStudioCatalogEntry): Promise<WorkspaceStudioCatalogEntry>;
  listRoomStudios(roomId: string): Promise<WorkspaceStudioCatalogEntry[]>;
  deleteStudio(roomId: string, studioId: string): Promise<void>;
  close(): Promise<void>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLength);
}

function safeIsoDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function safeHostToken(value: unknown): string {
  const token = safeText(value, 256);
  return HOST_TOKEN_PATTERN.test(token) ? token : '';
}

function safeRoomStatus(value: unknown): RoomStatus | undefined {
  return typeof value === 'string' && ROOM_STATUSES.includes(value as RoomStatus)
    ? value as RoomStatus
    : undefined;
}

function getStudioSortTime(entry: WorkspaceStudioCatalogEntry): number {
  const scheduledAt = entry.scheduledFor ? Date.parse(entry.scheduledFor) : NaN;
  if (Number.isFinite(scheduledAt)) return scheduledAt;
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function normalizeWorkspaceStudioCatalogEntry(
  value: unknown,
  now = new Date()
): WorkspaceStudioCatalogEntry {
  if (!isRecord(value)) {
    throw new WorkspaceStudioCatalogError(400, 'WORKSPACE_STUDIO_CATALOG_INVALID', 'Invalid workspace studio catalog entry.');
  }

  const id = safeText(value.id, 80);
  const name = safeText(value.name, 120);
  const hostName = safeText(value.hostName, 80);
  const hostToken = safeHostToken(value.hostToken);
  const createdAt = safeIsoDate(value.createdAt);
  if (!id || !name || !hostName || !hostToken || !createdAt) {
    throw new WorkspaceStudioCatalogError(
      400,
      'WORKSPACE_STUDIO_CATALOG_INVALID',
      'Studio id, name, hostName, hostToken, and createdAt are required.'
    );
  }

  const scheduledFor = safeIsoDate(value.scheduledFor);
  const status = safeRoomStatus(value.status);
  return {
    id,
    name,
    hostName,
    hostToken,
    createdAt,
    ...(scheduledFor ? { scheduledFor } : {}),
    passwordProtected: value.passwordProtected === true,
    registrationEnabled: value.registrationEnabled === true,
    ...(status ? { status } : {}),
    updatedAt: now.toISOString(),
  };
}

export function buildWorkspaceStudioCatalogListResponse(
  roomId: string,
  studios: WorkspaceStudioCatalogEntry[],
  now = new Date()
): WorkspaceStudioCatalogListResponse {
  return {
    roomId,
    exportedAt: now.toISOString(),
    studios: studios
      .slice()
      .sort((a, b) => getStudioSortTime(b) - getStudioSortTime(a))
      .slice(0, MAX_STUDIOS_PER_ROOM),
  };
}

export class InMemoryWorkspaceStudioCatalogStore implements WorkspaceStudioCatalogStore {
  private readonly studiosByRoom = new Map<string, Map<string, WorkspaceStudioCatalogEntry>>();

  async init(): Promise<void> {}

  async upsertStudio(roomId: string, entry: WorkspaceStudioCatalogEntry): Promise<WorkspaceStudioCatalogEntry> {
    let roomStudios = this.studiosByRoom.get(roomId);
    if (!roomStudios) {
      roomStudios = new Map();
      this.studiosByRoom.set(roomId, roomStudios);
    }
    roomStudios.set(entry.id, entry);
    if (roomStudios.size > MAX_STUDIOS_PER_ROOM) {
      const oldest = Array.from(roomStudios.values()).sort((a, b) => getStudioSortTime(a) - getStudioSortTime(b))[0];
      if (oldest) roomStudios.delete(oldest.id);
    }
    return entry;
  }

  async listRoomStudios(roomId: string): Promise<WorkspaceStudioCatalogEntry[]> {
    return Array.from(this.studiosByRoom.get(roomId)?.values() || [])
      .sort((a, b) => getStudioSortTime(b) - getStudioSortTime(a))
      .slice(0, MAX_STUDIOS_PER_ROOM);
  }

  async deleteStudio(roomId: string, studioId: string): Promise<void> {
    this.studiosByRoom.get(roomId)?.delete(studioId);
  }

  async close(): Promise<void> {}
}

export class PostgresWorkspaceStudioCatalogStore implements WorkspaceStudioCatalogStore {
  constructor(private readonly db: PgQueryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_workspace_studio_catalog (
        room_id text NOT NULL,
        studio_id text NOT NULL,
        studio jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, studio_id)
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_workspace_studio_catalog_room_updated_at_idx
        ON studio_workspace_studio_catalog (room_id, updated_at DESC)
    `);
  }

  async upsertStudio(roomId: string, entry: WorkspaceStudioCatalogEntry): Promise<WorkspaceStudioCatalogEntry> {
    await this.db.query(`
      INSERT INTO studio_workspace_studio_catalog (
        room_id,
        studio_id,
        studio,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
      ON CONFLICT (room_id, studio_id) DO UPDATE SET
        studio = EXCLUDED.studio,
        updated_at = EXCLUDED.updated_at
    `, [
      roomId,
      entry.id,
      JSON.stringify(entry),
      entry.scheduledFor || entry.createdAt,
      entry.updatedAt,
    ]);
    return entry;
  }

  async listRoomStudios(roomId: string): Promise<WorkspaceStudioCatalogEntry[]> {
    const result = await this.db.query(`
      SELECT studio
      FROM studio_workspace_studio_catalog
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [roomId, MAX_STUDIOS_PER_ROOM]);

    return result.rows
      .map((row) => normalizeStoredStudio(row.studio))
      .filter((entry): entry is WorkspaceStudioCatalogEntry => Boolean(entry));
  }

  async deleteStudio(roomId: string, studioId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM studio_workspace_studio_catalog WHERE room_id = $1 AND studio_id = $2',
      [roomId, studioId]
    );
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}

function normalizeStoredStudio(value: unknown): WorkspaceStudioCatalogEntry | null {
  if (!isRecord(value)) return null;
  try {
    return normalizeWorkspaceStudioCatalogEntry(
      value,
      safeIsoDate(value.updatedAt) ? new Date(safeIsoDate(value.updatedAt)) : new Date()
    );
  } catch {
    return null;
  }
}

export function getPostgresWorkspaceStudioCatalogConfig(env: Record<string, string | undefined>) {
  if (isDisabled(env.WORKSPACE_STUDIO_CATALOG_PERSISTENCE_DISABLED)) return null;
  const connectionString = firstConfiguredDatabaseUrl(env);
  if (!connectionString) return null;
  return {
    connectionString,
    ssl: parsePostgresSsl(env),
  };
}

export function createWorkspaceStudioCatalogStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): WorkspaceStudioCatalogStore | null {
  const config = getPostgresWorkspaceStudioCatalogConfig(env);
  if (!config) return null;
  return new PostgresWorkspaceStudioCatalogStore(new Pool(config));
}
