import pg from 'pg';
import type {
  RecordingCatalogEntry,
  RecordingCatalogListResponse,
  RecordingExportJobStatusValue,
} from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const MAX_CATALOG_RECORDINGS_PER_ROOM = 250;

export class RecordingCatalogError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RecordingCatalogError';
  }
}

export interface RecordingCatalogStore {
  init(): Promise<void>;
  upsertRecording(entry: RecordingCatalogEntry): Promise<RecordingCatalogEntry>;
  listRoomRecordings(roomId: string): Promise<RecordingCatalogEntry[]>;
  deleteRecording(roomId: string, recordingId: string): Promise<void>;
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

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLength);
}

function safeIsoDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function readNonNegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(max, Math.floor(number));
}

function readNullableDuration(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function readExportStatus(value: unknown): RecordingExportJobStatusValue | null {
  return value === 'queued' || value === 'running' || value === 'ready' || value === 'error'
    ? value
    : null;
}

function readSafeHttpUrl(value: unknown, maxLength = 2048): string {
  const text = safeText(value, maxLength);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, maxLength) : '';
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function normalizeRecordingCatalogEntry(
  roomId: string,
  roomName: string,
  value: unknown,
  now = new Date()
): RecordingCatalogEntry {
  if (!isRecord(value)) {
    throw new RecordingCatalogError(400, 'RECORDING_CATALOG_INVALID', 'Invalid recording catalog entry.');
  }

  const id = safeText(value.id, 128);
  const normalizedRoomId = safeText(roomId, 80);
  const normalizedRoomName = safeText(value.roomName, 120) || safeText(roomName, 120);
  const createdAt = safeIsoDate(value.createdAt);
  if (!id || !normalizedRoomId || !normalizedRoomName || !createdAt) {
    throw new RecordingCatalogError(400, 'RECORDING_CATALOG_INVALID', 'Recording id, room id, room name, and createdAt are required.');
  }

  const entry: RecordingCatalogEntry = {
    id,
    roomId: normalizedRoomId,
    roomName: normalizedRoomName,
    createdAt,
    updatedAt: now.toISOString(),
    durationSeconds: readNullableDuration(value.durationSeconds),
    trackCount: readNonNegativeInteger(value.trackCount, 500),
    totalBytes: readNonNegativeInteger(value.totalBytes),
    markerCount: readNonNegativeInteger(value.markerCount, 5000),
  };

  if (isRecord(value.cloud) && value.cloud.provider === 'google-drive') {
    const uploadedAt = safeIsoDate(value.cloud.uploadedAt);
    if (uploadedAt) {
      const expiresAt = safeIsoDate(value.cloud.expiresAt);
      entry.cloud = {
        provider: 'google-drive',
        fileCount: readNonNegativeInteger(value.cloud.fileCount, 500),
        totalBytes: readNonNegativeInteger(value.cloud.totalBytes),
        uploadedAt,
        expiresAt: expiresAt || null,
        permanent: value.cloud.permanent === true,
      };
    }
  }

  if (isRecord(value.mediaExport)) {
    const status = readExportStatus(value.mediaExport.status);
    const uploadId = safeText(value.mediaExport.uploadId, 128);
    const exportId = safeText(value.mediaExport.exportId, 128);
    const updatedAt = safeIsoDate(value.mediaExport.updatedAt);
    if (status && uploadId && exportId && updatedAt) {
      const mp4ShareUrl = readSafeHttpUrl(value.mediaExport.mp4ShareUrl);
      entry.mediaExport = {
        status,
        uploadId,
        exportId,
        updatedAt,
        readyMp4: value.mediaExport.readyMp4 === true,
        ...(mp4ShareUrl ? { mp4ShareUrl } : {}),
        artifactCount: readNonNegativeInteger(value.mediaExport.artifactCount, 1000),
        readyArtifactCount: readNonNegativeInteger(value.mediaExport.readyArtifactCount, 1000),
      };
    }
  }

  return entry;
}

export function buildRecordingCatalogListResponse(
  roomId: string,
  recordings: RecordingCatalogEntry[],
  now = new Date()
): RecordingCatalogListResponse {
  return {
    roomId,
    exportedAt: now.toISOString(),
    recordings: recordings
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_CATALOG_RECORDINGS_PER_ROOM),
  };
}

export class InMemoryRecordingCatalogStore implements RecordingCatalogStore {
  private readonly recordingsByRoom = new Map<string, Map<string, RecordingCatalogEntry>>();

  async init(): Promise<void> {}

  async upsertRecording(entry: RecordingCatalogEntry): Promise<RecordingCatalogEntry> {
    let roomRecordings = this.recordingsByRoom.get(entry.roomId);
    if (!roomRecordings) {
      roomRecordings = new Map();
      this.recordingsByRoom.set(entry.roomId, roomRecordings);
    }
    roomRecordings.set(entry.id, entry);
    if (roomRecordings.size > MAX_CATALOG_RECORDINGS_PER_ROOM) {
      const oldest = Array.from(roomRecordings.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) roomRecordings.delete(oldest.id);
    }
    return entry;
  }

  async listRoomRecordings(roomId: string): Promise<RecordingCatalogEntry[]> {
    return Array.from(this.recordingsByRoom.get(roomId)?.values() || [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_CATALOG_RECORDINGS_PER_ROOM);
  }

  async deleteRecording(roomId: string, recordingId: string): Promise<void> {
    this.recordingsByRoom.get(roomId)?.delete(recordingId);
  }

  async close(): Promise<void> {}
}

export class PostgresRecordingCatalogStore implements RecordingCatalogStore {
  constructor(private readonly db: PgQueryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_recording_catalog (
        room_id text NOT NULL,
        recording_id text NOT NULL,
        room_name text NOT NULL,
        recording jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, recording_id)
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_recording_catalog_room_updated_at_idx
        ON studio_recording_catalog (room_id, updated_at DESC)
    `);
  }

  async upsertRecording(entry: RecordingCatalogEntry): Promise<RecordingCatalogEntry> {
    await this.db.query(`
      INSERT INTO studio_recording_catalog (
        room_id,
        recording_id,
        room_name,
        recording,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
      ON CONFLICT (room_id, recording_id) DO UPDATE SET
        room_name = EXCLUDED.room_name,
        recording = EXCLUDED.recording,
        updated_at = EXCLUDED.updated_at
    `, [
      entry.roomId,
      entry.id,
      entry.roomName,
      JSON.stringify(entry),
      entry.createdAt,
      entry.updatedAt,
    ]);
    return entry;
  }

  async listRoomRecordings(roomId: string): Promise<RecordingCatalogEntry[]> {
    const result = await this.db.query(`
      SELECT recording
      FROM studio_recording_catalog
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [roomId, MAX_CATALOG_RECORDINGS_PER_ROOM]);

    return result.rows
      .map((row) => normalizeStoredRecording(row.recording))
      .filter((entry): entry is RecordingCatalogEntry => Boolean(entry));
  }

  async deleteRecording(roomId: string, recordingId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM studio_recording_catalog WHERE room_id = $1 AND recording_id = $2',
      [roomId, recordingId]
    );
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}

function normalizeStoredRecording(value: unknown): RecordingCatalogEntry | null {
  if (!isRecord(value)) return null;
  try {
    return normalizeRecordingCatalogEntry(
      safeText(value.roomId, 80),
      safeText(value.roomName, 120),
      value,
      safeIsoDate(value.updatedAt) ? new Date(safeIsoDate(value.updatedAt)) : new Date()
    );
  } catch {
    return null;
  }
}

export function getPostgresRecordingCatalogConfig(env: Record<string, string | undefined>) {
  if (isDisabled(env.RECORDING_CATALOG_PERSISTENCE_DISABLED)) return null;
  const connectionString = firstConfiguredDatabaseUrl(env);
  if (!connectionString) return null;
  return {
    connectionString,
    ssl: parsePostgresSsl(env),
  };
}

export function createRecordingCatalogStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): RecordingCatalogStore | null {
  const config = getPostgresRecordingCatalogConfig(env);
  if (!config) return null;
  return new PostgresRecordingCatalogStore(new Pool(config));
}
