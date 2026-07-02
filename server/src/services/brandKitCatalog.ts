import pg from 'pg';
import type {
  BrandKitCatalogEntry,
  BrandKitCatalogListResponse,
  BrandKitCatalogStudioTheme,
  CameraShape,
  LogoPlacement,
  LogoPosition,
  LogoSize,
  NameTagStyle,
  StageBackground,
} from '@studio/shared';

const { Pool } = pg;

const DATABASE_URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL'];
const DISABLE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const MAX_BRAND_KITS_PER_ROOM = 100;
const MAX_LOGO_URL_LENGTH = 100_000;
const MAX_BACKGROUND_VALUE_LENGTH = 100_000;

const STUDIO_THEMES: BrandKitCatalogStudioTheme[] = ['dark', 'light', 'colorful'];
const BACKGROUND_TYPES: StageBackground['type'][] = ['color', 'image', 'video', 'gradient', 'none'];
const LOGO_PLACEMENTS: LogoPlacement[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const LOGO_SIZES: LogoSize[] = ['small', 'medium', 'large'];
const CAMERA_SHAPES: CameraShape[] = ['rectangle', 'rounded', 'square', 'circle'];
const NAME_TAG_STYLES: NameTagStyle[] = ['classic', 'minimal', 'block'];

export class BrandKitCatalogError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'BrandKitCatalogError';
  }
}

export interface BrandKitCatalogStore {
  init(): Promise<void>;
  upsertBrandKit(entry: BrandKitCatalogEntry): Promise<BrandKitCatalogEntry>;
  listRoomBrandKits(roomId: string): Promise<BrandKitCatalogEntry[]>;
  deleteBrandKit(roomId: string, brandKitId: string): Promise<void>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAllowed<T extends string>(value: unknown, allowed: T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function normalizeStageBackground(value: unknown): StageBackground {
  if (!isRecord(value) || !isAllowed(value.type, BACKGROUND_TYPES)) return { type: 'none', value: '' };
  const background = {
    type: value.type,
    value: safeText(value.value, MAX_BACKGROUND_VALUE_LENGTH),
  };
  if ((background.type === 'image' || background.type === 'video') && background.value.startsWith('blob:')) {
    return { type: 'none', value: '' };
  }
  return background;
}

function normalizeLogoUrl(value: unknown): string | null {
  const text = safeText(value, MAX_LOGO_URL_LENGTH);
  if (!text || text.startsWith('blob:')) return null;
  if (text.startsWith('data:image/')) return text;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, MAX_LOGO_URL_LENGTH) : null;
  } catch {
    return null;
  }
}

function normalizeLogoPosition(value: unknown): LogoPosition | null {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function normalizeLogoOpacity(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.85;
  return Math.min(1, Math.max(0.2, number));
}

export function normalizeBrandKitCatalogEntry(
  roomId: string,
  value: unknown,
  now = new Date()
): BrandKitCatalogEntry {
  if (!isRecord(value)) {
    throw new BrandKitCatalogError(400, 'BRAND_KIT_CATALOG_INVALID', 'Invalid brand kit catalog entry.');
  }

  const id = safeText(value.id, 128);
  const normalizedRoomId = safeText(roomId, 80);
  const name = safeText(value.name, 32);
  const createdAt = safeIsoDate(value.createdAt);
  if (!id || !normalizedRoomId || !name || !createdAt) {
    throw new BrandKitCatalogError(400, 'BRAND_KIT_CATALOG_INVALID', 'Brand kit id, room id, name, and createdAt are required.');
  }

  return {
    id,
    roomId: normalizedRoomId,
    name,
    createdAt,
    updatedAt: now.toISOString(),
    studioTheme: isAllowed(value.studioTheme, STUDIO_THEMES) ? value.studioTheme : 'dark',
    brandColor: /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(safeText(value.brandColor, 24))
      ? safeText(value.brandColor, 24)
      : '#a78bfa',
    stageBackground: normalizeStageBackground(value.stageBackground),
    logoUrl: normalizeLogoUrl(value.logoUrl),
    logoPlacement: isAllowed(value.logoPlacement, LOGO_PLACEMENTS) ? value.logoPlacement : 'top-right',
    logoPosition: normalizeLogoPosition(value.logoPosition),
    logoSize: isAllowed(value.logoSize, LOGO_SIZES) ? value.logoSize : 'medium',
    logoOpacity: normalizeLogoOpacity(value.logoOpacity),
    cameraShape: isAllowed(value.cameraShape, CAMERA_SHAPES) ? value.cameraShape : 'rectangle',
    nameTagStyle: isAllowed(value.nameTagStyle, NAME_TAG_STYLES) ? value.nameTagStyle : 'classic',
  };
}

export function buildBrandKitCatalogListResponse(
  roomId: string,
  brandKits: BrandKitCatalogEntry[],
  now = new Date()
): BrandKitCatalogListResponse {
  return {
    roomId,
    exportedAt: now.toISOString(),
    brandKits: brandKits
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_BRAND_KITS_PER_ROOM),
  };
}

export class InMemoryBrandKitCatalogStore implements BrandKitCatalogStore {
  private readonly brandKitsByRoom = new Map<string, Map<string, BrandKitCatalogEntry>>();

  async init(): Promise<void> {}

  async upsertBrandKit(entry: BrandKitCatalogEntry): Promise<BrandKitCatalogEntry> {
    let roomBrandKits = this.brandKitsByRoom.get(entry.roomId);
    if (!roomBrandKits) {
      roomBrandKits = new Map();
      this.brandKitsByRoom.set(entry.roomId, roomBrandKits);
    }
    roomBrandKits.set(entry.id, entry);
    if (roomBrandKits.size > MAX_BRAND_KITS_PER_ROOM) {
      const oldest = Array.from(roomBrandKits.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) roomBrandKits.delete(oldest.id);
    }
    return entry;
  }

  async listRoomBrandKits(roomId: string): Promise<BrandKitCatalogEntry[]> {
    return Array.from(this.brandKitsByRoom.get(roomId)?.values() || [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_BRAND_KITS_PER_ROOM);
  }

  async deleteBrandKit(roomId: string, brandKitId: string): Promise<void> {
    this.brandKitsByRoom.get(roomId)?.delete(brandKitId);
  }

  async close(): Promise<void> {}
}

export class PostgresBrandKitCatalogStore implements BrandKitCatalogStore {
  constructor(private readonly db: PgQueryable) {}

  async init(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS studio_brand_kit_catalog (
        room_id text NOT NULL,
        brand_kit_id text NOT NULL,
        brand_kit jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (room_id, brand_kit_id)
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS studio_brand_kit_catalog_room_updated_at_idx
        ON studio_brand_kit_catalog (room_id, updated_at DESC)
    `);
  }

  async upsertBrandKit(entry: BrandKitCatalogEntry): Promise<BrandKitCatalogEntry> {
    await this.db.query(`
      INSERT INTO studio_brand_kit_catalog (
        room_id,
        brand_kit_id,
        brand_kit,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
      ON CONFLICT (room_id, brand_kit_id) DO UPDATE SET
        brand_kit = EXCLUDED.brand_kit,
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

  async listRoomBrandKits(roomId: string): Promise<BrandKitCatalogEntry[]> {
    const result = await this.db.query(`
      SELECT brand_kit
      FROM studio_brand_kit_catalog
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [roomId, MAX_BRAND_KITS_PER_ROOM]);

    return result.rows
      .map((row) => normalizeStoredBrandKit(row.brand_kit))
      .filter((entry): entry is BrandKitCatalogEntry => Boolean(entry));
  }

  async deleteBrandKit(roomId: string, brandKitId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM studio_brand_kit_catalog WHERE room_id = $1 AND brand_kit_id = $2',
      [roomId, brandKitId]
    );
  }

  async close(): Promise<void> {
    await this.db.end?.();
  }
}

function normalizeStoredBrandKit(value: unknown): BrandKitCatalogEntry | null {
  if (!isRecord(value)) return null;
  try {
    return normalizeBrandKitCatalogEntry(
      safeText(value.roomId, 80),
      value,
      safeIsoDate(value.updatedAt) ? new Date(safeIsoDate(value.updatedAt)) : new Date()
    );
  } catch {
    return null;
  }
}

export function getPostgresBrandKitCatalogConfig(env: Record<string, string | undefined>) {
  if (isDisabled(env.BRAND_KIT_CATALOG_PERSISTENCE_DISABLED)) return null;
  const connectionString = firstConfiguredDatabaseUrl(env);
  if (!connectionString) return null;
  return {
    connectionString,
    ssl: parsePostgresSsl(env),
  };
}

export function createBrandKitCatalogStoreFromEnv(
  env: Record<string, string | undefined> = process.env
): BrandKitCatalogStore | null {
  const config = getPostgresBrandKitCatalogConfig(env);
  if (!config) return null;
  return new PostgresBrandKitCatalogStore(new Pool(config));
}
