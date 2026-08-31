import pg from 'pg';
import type { Room, RoomRegistrant, RoomRegistrationSettings, RoomSettings, RoomStatus, StudioBrandingPayload } from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const MAX_PERSISTED_REGISTRANTS = 1000;
// Matches the per-room caps the signaling server enforces on issue (40 + 20).
const MAX_PERSISTED_INVITES = 80;

/**
 * A guest or co-host invite link, stored as a hash of the token rather than
 * the token itself: an emailed invite has to outlive a restart, but a leaked
 * snapshot must not hand anyone a working link.
 */
export interface PersistedRoomInvite {
  kind: 'guest' | 'co-host';
  tokenHash: string;
  issuedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface RoomSnapshot {
  room: Room;
  hostToken: string;
  creatorIp: string;
  hasBeenJoined: boolean;
  registrants?: RoomRegistrant[];
  studioBranding?: StudioBrandingPayload;
  passwordHash?: string;
  passwordSalt?: string;
  invites?: PersistedRoomInvite[];
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
  room?: unknown;
  host_token?: unknown;
  creator_ip?: unknown;
  has_been_joined?: unknown;
  registrants?: unknown;
  studio_branding?: unknown;
  password_hash?: unknown;
  password_salt?: unknown;
  invites?: unknown;
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
  if (value === 'scheduled') return 'scheduled';
  if (value === 'ended') return 'ended';
  return 'waiting';
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

function normalizeRegistration(value: unknown): RoomRegistrationSettings {
  const input = value && typeof value === 'object'
    ? value as Partial<RoomRegistrationSettings>
    : {};
  return {
    enabled: input.enabled === true,
    fields: ['name', 'email'],
  };
}

function normalizeRegistrant(value: unknown, roomId: string): RoomRegistrant | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<RoomRegistrant>;
  const id = safeText(input.id, 80);
  const name = safeText(input.name, 80);
  const email = safeText(input.email, 254).toLowerCase();
  const registeredAt = safeIsoDate(input.registeredAt);
  if (!id || !name || !registeredAt || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return {
    id,
    roomId,
    name,
    email,
    registeredAt,
  };
}

function normalizeInvites(value: unknown): PersistedRoomInvite[] {
  if (!Array.isArray(value)) return [];
  const invites: PersistedRoomInvite[] = [];
  for (const item of value.slice(0, MAX_PERSISTED_INVITES)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Partial<PersistedRoomInvite>;
    const kind = entry.kind === 'co-host' ? 'co-host' : entry.kind === 'guest' ? 'guest' : null;
    const tokenHash = safeText(entry.tokenHash, 128);
    const issuedBy = safeText(entry.issuedBy, 120);
    const createdAt = safeIsoDate(entry.createdAt);
    const expiresAt = safeIsoDate(entry.expiresAt);
    if (!kind || !tokenHash || !createdAt || !expiresAt) continue;
    // A raw token would be 20-120 url-safe chars; a sha256 base64url digest is
    // always 43. Refusing anything else keeps a raw token out of the store.
    if (tokenHash.length !== 43) continue;
    invites.push({ kind, tokenHash, issuedBy, createdAt, expiresAt });
  }
  return invites;
}

function normalizeRegistrants(value: unknown, roomId: string): RoomRegistrant[] {
  if (!Array.isArray(value)) return [];
  const byEmail = new Map<string, RoomRegistrant>();
  for (const item of value.slice(0, MAX_PERSISTED_REGISTRANTS)) {
    const registrant = normalizeRegistrant(item, roomId);
    if (registrant) byEmail.set(registrant.email, registrant);
  }
  return Array.from(byEmail.values()).sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
}

function normalizeStudioBranding(value: unknown): StudioBrandingPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<StudioBrandingPayload>;
  const brandColor = safeText(input.brandColor, 24);
  if (!/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(brandColor)) return undefined;
  const logoUrl = typeof input.logoUrl === 'string' ? input.logoUrl.trim().slice(0, 600_000) : null;
  const stageBackground = input.stageBackground && typeof input.stageBackground === 'object'
    ? input.stageBackground
    : { type: 'none' as const, value: '' };
  const waitingRoomInput = input.waitingRoom && typeof input.waitingRoom === 'object'
    ? input.waitingRoom
    : {};

  return {
    brandColor,
    logoUrl: logoUrl && !logoUrl.startsWith('blob:') ? logoUrl : null,
    stageBackground,
    waitingRoom: {
      headline: safeText((waitingRoomInput as { headline?: unknown }).headline, 80) || "You're in the green room",
      message: safeText((waitingRoomInput as { message?: unknown }).message, 220) || 'The host can see that you arrived and will bring you on stage when ready.',
      backgroundMode: (waitingRoomInput as { backgroundMode?: unknown }).backgroundMode === 'studio' ? 'studio' : 'brand',
      showLogo: (waitingRoomInput as { showLogo?: unknown }).showLogo !== false,
    },
    ...(safeIsoDate(input.updatedAt) ? { updatedAt: safeIsoDate(input.updatedAt) } : {}),
    ...(safeText(input.updatedBy, 80) ? { updatedBy: safeText(input.updatedBy, 80) } : {}),
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
  const studioBranding = normalizeStudioBranding(input.studioBranding);
  const invites = normalizeInvites(input.invites);

  return {
    room: {
      id,
      name,
      hostId: '',
      coHostIds: [],
      createdAt,
      status: normalizeRoomStatus(roomInput.status),
      settings: normalizeRoomSettings(roomInput.settings),
      registration: normalizeRegistration(roomInput.registration),
      ...(scheduledFor ? { scheduledFor } : {}),
      ...(hostName ? { hostName } : {}),
    },
    hostToken,
    creatorIp,
    hasBeenJoined: input.hasBeenJoined === true,
    registrants: normalizeRegistrants(input.registrants, id),
    ...(studioBranding ? { studioBranding } : {}),
    ...(passwordHash ? { passwordHash } : {}),
    ...(passwordSalt ? { passwordSalt } : {}),
    ...(invites.length > 0 ? { invites } : {}),
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
        registrants jsonb NOT NULL DEFAULT '[]'::jsonb,
        studio_branding jsonb,
        password_hash text,
        password_salt text,
        invites jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Existing deployments predate the invites column.
    await this.db.query(`
      ALTER TABLE studio_room_snapshots
        ADD COLUMN IF NOT EXISTS invites jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_room_snapshots_updated_at_idx
        ON studio_room_snapshots (updated_at)
    `);
  }

  async loadRoomSnapshots(): Promise<RoomSnapshot[]> {
    const result = await this.db.query(`
      SELECT room, host_token, creator_ip, has_been_joined, registrants, studio_branding, password_hash, password_salt, invites
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
        registrants,
        studio_branding,
        password_hash,
        password_salt,
        invites,
        created_at,
        updated_at
      )
      VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::timestamptz, now())
      ON CONFLICT (room_id) DO UPDATE SET
        room = EXCLUDED.room,
        host_token = EXCLUDED.host_token,
        creator_ip = EXCLUDED.creator_ip,
        has_been_joined = EXCLUDED.has_been_joined,
        registrants = EXCLUDED.registrants,
        studio_branding = EXCLUDED.studio_branding,
        password_hash = EXCLUDED.password_hash,
        password_salt = EXCLUDED.password_salt,
        invites = EXCLUDED.invites,
        updated_at = now()
    `, [
      normalized.room.id,
      JSON.stringify(normalized.room),
      normalized.hostToken,
      normalized.creatorIp,
      normalized.hasBeenJoined,
      JSON.stringify(normalized.registrants || []),
      normalized.studioBranding ? JSON.stringify(normalized.studioBranding) : null,
      normalized.passwordHash || null,
      normalized.passwordSalt || null,
      JSON.stringify(normalized.invites || []),
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
      registrants: row.registrants,
      studioBranding: row.studio_branding,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
      invites: row.invites,
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
