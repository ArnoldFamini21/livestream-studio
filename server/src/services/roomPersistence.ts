import pg from 'pg';
import type { Room, RoomSettings, RoomStatus } from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface RoomSnapshot {
  room: Room;
  hostToken: string;
  creatorIp: string;
  hasBeenJoined: boolean;
  passwordHash?: string;
  passwordSalt?: string;
}

export interface RoomSnapshotStore {
  init(): Promise<void>;
  loadRoomSnapshots(): Promise<RoomSnapshot[]>;
  saveRoomSnapshot(snapshot: RoomSnapshot): Promise<void>;
  deleteRoomSnapshot(roomId: string): Promise<void>;
  close(): Promise<void>;
}

interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?: () => Promise<void>;
}

interface PgRoomRow {
  room_id?: unknown;
  room?: unknown;
  host_token?: unknown;
  creator_ip?: unknown;
  has_been_joined?: unknown;
  password_hash?: unknown;
  password_salt?: unknown;
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

function safeIsoDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeRoomStatus(value: unknown): RoomStatus {
  return value === 'scheduled' || value === 'ended' ? value : 'waiting';
}

function normalizeRoomSettings(value: unknown): RoomSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<RoomSettings>
    : {};
  const resolution = input.resolution === '720p' || input.resolution === '1080p' || input.resolution === '4k'
    ? input.resolution
    : '1080p';
  const frameRate = Number(input.frameRate);
  const maxParticipants = Number(input.maxParticipants);

  return {
    maxParticipants: Number.isFinite(maxParticipants) ? Math.min(Math.max(Math.trunc(maxParticipants), 1), 50) : 7,
    resolution,
    frameRate: Number.isFinite(frameRate) ? Math.min(Math.max(Math.trunc(frameRate), 1), 120) : 30,
    enableRecording: input.enableRecording !== false,
    enableStreaming: input.enableStreaming === true,
    greenRoomEnabled: input.greenRoomEnabled !== false,
    passwordProtected: input.passwordProtected === true,
  };
}

export function normalizeRoomSnapshot(value: unknown): RoomSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<RoomSnapshot>;
  const roomInput = input.room && typeof input.room === 'object'
    ? input.room as Partial<Room>
    : {};

  const id = safeText(roomInput.id, 80);
  const name = safeText(roomInput.name, 100);
  const hostToken = safeText(input.hostToken, 256);
  const creatorIp = safeText(input.creatorIp, 120) || 'unknown';
  const createdAt = safeIsoDate(roomInput.createdAt);
  if (!id || !name || !createdAt || !/^[A-Za-z0-9_-]{16,256}$/.test(hostToken)) {
    return null;
  }

  const hostName = safeText(roomInput.hostName, 50);
  const scheduledFor = safeIsoDate(roomInput.scheduledFor);
  const passwordHash = safeText(input.passwordHash, 256);
  const passwordSalt = safeText(input.passwordSalt, 128);

  return {
    room: {
      id,
      name,
      hostId: '',
      coHostIds: [],
      createdAt,
      status: normalizeRoomStatus(roomInput.status),
      settings: normalizeRoomSettings(roomInput.settings),
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(hostName ? { hostName } : {}),
    },
    hostToken,
    creatorIp,
    hasBeenJoined: input.hasBeenJoined === true,
    ...(passwordHash ? { passwordHash } : {}),
    ...(passwordSalt ? { passwordSalt } : {}),
  };
}

export function buildPersistentRoomSnapshot(snapshot: RoomSnapshot): RoomSnapshot {
  const normalized = normalizeRoomSnapshot({
    ...snapshot,
    room: {
      ...snapshot.room,
      hostId: '',
      coHostIds: [],
      status: snapshot.room.status === 'scheduled' || snapshot.room.status === 'ended'
        ? snapshot.room.status
        : 'waiting',
    },
  });
  if (!normalized) throw new Error('Invalid room snapshot');
  return normalized;
}

export function getPostgresRoomSnapshotConfig(env: Record<string, string | undefined>) {
  if (isDisabled(env.ROOM_PERSISTENCE_DISABLED)) return null;
  const connectionString = firstConfiguredDatabaseUrl(env);
  if (!connectionString) return null;
  return {
    connectionString,
    ssl: parsePostgresSsl(env),
  };
}

export class PostgresRoomSnapshotStore implements RoomSnapshotStore {
  constructor(private readonly db: PgQueryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_room_snapshots (
        room_id text PRIMARY KEY,
        room jsonb NOT NULL,
        host_token text NOT NULL,
        creator_ip text NOT NULL,
        has_been_joined boolean NOT NULL DEFAULT false,
        password_hash text,
        password_salt text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_room_snapshots_updated_at_idx
        ON studio_room_snapshots (updated_at)
    `);
  }

  async loadRoomSnapshots(): Promise<RoomSnapshot[]> {
    const result = await this.db.query(`
      SELECT room_id, room, host_token, creator_ip, has_been_joined, password_hash, password_salt
      FROM studio_room_snapshots
      WHERE room->>'status' <> 'ended'
      ORDER BY created_at ASC
      LIMIT 1000
    `);

    return result.rows
      .map((row) => this.normalizeRow(row))
      .filter((snapshot): snapshot is RoomSnapshot => Boolean(snapshot));
  }

  async saveRoomSnapshot(snapshot: RoomSnapshot): Promise<void> {
    const normalized = buildPersistentRoomSnapshot(snapshot);
    await this.db.query(`
      INSERT INTO studio_room_snapshots (
        room_id,
        room,
        host_token,
        creator_ip,
        has_been_joined,
        password_hash,
        password_salt,
        created_at,
        updated_at
      )
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8::timestamptz, now())
      ON CONFLICT (room_id) DO UPDATE SET
        room = EXCLUDED.room,
        host_token = EXCLUDED.host_token,
        creator_ip = EXCLUDED.creator_ip,
        has_been_joined = EXCLUDED.has_been_joined,
        password_hash = EXCLUDED.password_hash,
        password_salt = EXCLUDED.password_salt,
        updated_at = now()
    `, [
      normalized.room.id,
      JSON.stringify(normalized.room),
      normalized.hostToken,
      normalized.creatorIp,
      normalized.hasBeenJoined,
      normalized.passwordHash || null,
      normalized.passwordSalt || null,
      normalized.room.createdAt,
    ]);
  }

  async deleteRoomSnapshot(roomId: string): Promise<void> {
    const normalizedRoomId = safeText(roomId, 80);
    if (!normalizedRoomId) return;
    await this.db.query('DELETE FROM studio_room_snapshots WHERE room_id = $1', [normalizedRoomId]);
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }

  private normalizeRow(row: PgRoomRow): RoomSnapshot | null {
    return normalizeRoomSnapshot({
      room: row.room,
      hostToken: row.host_token,
      creatorIp: row.creator_ip,
      hasBeenJoined: row.has_been_joined === true,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
    });
  }
}

export function createRoomSnapshotStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): RoomSnapshotStore | null {
  const config = getPostgresRoomSnapshotConfig(env);
  if (!config) return null;
  return new PostgresRoomSnapshotStore(new Pool(config));
}
