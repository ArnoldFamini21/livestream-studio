import pg from 'pg';
import type {
  WorkspaceTeamCatalogListResponse,
  WorkspaceTeamCatalogMember,
  WorkspaceTeamCatalogRole,
} from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const MAX_TEAM_MEMBERS_PER_ROOM = 100;
const WORKSPACE_TEAM_ROLES: WorkspaceTeamCatalogRole[] = ['owner', 'producer', 'editor', 'guest-manager'];

export class WorkspaceTeamCatalogError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceTeamCatalogError';
  }
}

export interface WorkspaceTeamCatalogStore {
  init(): Promise<void>;
  upsertMember(entry: WorkspaceTeamCatalogMember): Promise<WorkspaceTeamCatalogMember>;
  listRoomMembers(roomId: string): Promise<WorkspaceTeamCatalogMember[]>;
  deleteMember(roomId: string, memberId: string): Promise<void>;
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

function safeEmail(value: unknown): string {
  const email = safeText(value, 254).toLowerCase();
  if (!email) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function safeRole(value: unknown): WorkspaceTeamCatalogRole {
  return typeof value === 'string' && WORKSPACE_TEAM_ROLES.includes(value as WorkspaceTeamCatalogRole)
    ? value as WorkspaceTeamCatalogRole
    : 'producer';
}

export function normalizeWorkspaceTeamCatalogMember(
  roomId: string,
  value: unknown,
  now = new Date()
): WorkspaceTeamCatalogMember {
  if (!isRecord(value)) {
    throw new WorkspaceTeamCatalogError(400, 'WORKSPACE_TEAM_CATALOG_INVALID', 'Invalid workspace team catalog member.');
  }

  const normalizedRoomId = safeText(roomId, 80);
  const id = safeText(value.id, 128);
  const name = safeText(value.name, 80);
  const createdAt = safeIsoDate(value.createdAt);
  if (!normalizedRoomId || !id || !name || !createdAt) {
    throw new WorkspaceTeamCatalogError(400, 'WORKSPACE_TEAM_CATALOG_INVALID', 'Team member id, room id, name, and createdAt are required.');
  }

  return {
    id,
    roomId: normalizedRoomId,
    name,
    email: safeEmail(value.email),
    role: safeRole(value.role),
    createdAt,
    updatedAt: now.toISOString(),
  };
}

export function buildWorkspaceTeamCatalogListResponse(
  roomId: string,
  members: WorkspaceTeamCatalogMember[],
  now = new Date()
): WorkspaceTeamCatalogListResponse {
  return {
    roomId,
    exportedAt: now.toISOString(),
    members: members
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_TEAM_MEMBERS_PER_ROOM),
  };
}

export class InMemoryWorkspaceTeamCatalogStore implements WorkspaceTeamCatalogStore {
  private readonly membersByRoom = new Map<string, Map<string, WorkspaceTeamCatalogMember>>();

  async init(): Promise<void> {}

  async upsertMember(entry: WorkspaceTeamCatalogMember): Promise<WorkspaceTeamCatalogMember> {
    let roomMembers = this.membersByRoom.get(entry.roomId);
    if (!roomMembers) {
      roomMembers = new Map();
      this.membersByRoom.set(entry.roomId, roomMembers);
    }
    roomMembers.set(entry.id, entry);
    if (roomMembers.size > MAX_TEAM_MEMBERS_PER_ROOM) {
      const oldest = Array.from(roomMembers.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) roomMembers.delete(oldest.id);
    }
    return entry;
  }

  async listRoomMembers(roomId: string): Promise<WorkspaceTeamCatalogMember[]> {
    return Array.from(this.membersByRoom.get(roomId)?.values() || [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_TEAM_MEMBERS_PER_ROOM);
  }

  async deleteMember(roomId: string, memberId: string): Promise<void> {
    this.membersByRoom.get(roomId)?.delete(memberId);
  }

  async close(): Promise<void> {}
}

export class PostgresWorkspaceTeamCatalogStore implements WorkspaceTeamCatalogStore {
  constructor(private readonly db: PgQueryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_workspace_team_catalog (
        room_id text NOT NULL,
        member_id text NOT NULL,
        member jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, member_id)
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_workspace_team_catalog_room_updated_at_idx
        ON studio_workspace_team_catalog (room_id, updated_at DESC)
    `);
  }

  async upsertMember(entry: WorkspaceTeamCatalogMember): Promise<WorkspaceTeamCatalogMember> {
    await this.db.query(`
      INSERT INTO studio_workspace_team_catalog (
        room_id,
        member_id,
        member,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
      ON CONFLICT (room_id, member_id) DO UPDATE SET
        member = EXCLUDED.member,
        updated_at = EXCLUDED.updated_at
    `, [
      entry.roomId,
      entry.id,
      JSON.stringify(entry),
      entry.createdAt,
      entry.updatedAt,
    ]);
    return entry;
  }

  async listRoomMembers(roomId: string): Promise<WorkspaceTeamCatalogMember[]> {
    const result = await this.db.query(`
      SELECT member
      FROM studio_workspace_team_catalog
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [roomId, MAX_TEAM_MEMBERS_PER_ROOM]);

    return result.rows
      .map((row) => normalizeStoredMember(row.member))
      .filter((entry): entry is WorkspaceTeamCatalogMember => Boolean(entry));
  }

  async deleteMember(roomId: string, memberId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM studio_workspace_team_catalog WHERE room_id = $1 AND member_id = $2',
      [roomId, memberId]
    );
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}

function normalizeStoredMember(value: unknown): WorkspaceTeamCatalogMember | null {
  if (!isRecord(value)) return null;
  try {
    return normalizeWorkspaceTeamCatalogMember(
      safeText(value.roomId, 80),
      value,
      safeIsoDate(value.updatedAt) ? new Date(safeIsoDate(value.updatedAt)) : new Date()
    );
  } catch {
    return null;
  }
}

export function getPostgresWorkspaceTeamCatalogConfig(env: Record<string, string | undefined>) {
  if (isDisabled(env.WORKSPACE_TEAM_CATALOG_PERSISTENCE_DISABLED)) return null;
  const connectionString = firstConfiguredDatabaseUrl(env);
  if (!connectionString) return null;
  return {
    connectionString,
    ssl: parsePostgresSsl(env),
  };
}

export function createWorkspaceTeamCatalogStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): WorkspaceTeamCatalogStore | null {
  const config = getPostgresWorkspaceTeamCatalogConfig(env);
  if (!config) return null;
  return new PostgresWorkspaceTeamCatalogStore(new Pool(config));
}
