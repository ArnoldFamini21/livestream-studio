import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBrandKitCatalogListResponse,
  BrandKitCatalogError,
  getPostgresBrandKitCatalogConfig,
  InMemoryBrandKitCatalogStore,
  normalizeBrandKitCatalogEntry,
  PostgresBrandKitCatalogStore,
} from '../dist/services/brandKitCatalog.js';

const ROOM_ID = 'room-brand-kits';

function brandKitEntry(overrides = {}) {
  return {
    id: 'kit-1',
    name: 'Launch Brand',
    createdAt: '2026-07-02T10:00:00.000Z',
    studioTheme: 'colorful',
    brandColor: '#2563eb',
    stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a, #2563eb)' },
    logoUrl: 'data:image/png;base64,logo',
    logoPlacement: 'bottom-right',
    logoPosition: { x: 0.37, y: 0.18 },
    logoSize: 'large',
    logoOpacity: 0.45,
    cameraShape: 'rounded',
    nameTagStyle: 'block',
    ...overrides,
  };
}

class FakeDb {
  rows = new Map();
  queries = [];
  closed = false;

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalizedSql = sql.trim().replace(/\s+/g, ' ').toUpperCase();

    if (normalizedSql.startsWith('SELECT')) {
      return {
        rows: Array.from(this.rows.values())
          .filter((row) => row.room_id === params[0])
          .sort((a, b) => Date.parse(b.brand_kit.createdAt) - Date.parse(a.brand_kit.createdAt))
          .slice(0, params[1])
          .map((row) => ({ brand_kit: row.brand_kit })),
      };
    }

    if (normalizedSql.startsWith('INSERT')) {
      const [roomId, brandKitId, brandKitJson, createdAt, updatedAt] = params;
      this.rows.set(`${roomId}:${brandKitId}`, {
        room_id: roomId,
        brand_kit_id: brandKitId,
        brand_kit: JSON.parse(brandKitJson),
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }

    if (normalizedSql.startsWith('DELETE')) {
      this.rows.delete(`${params[0]}:${params[1]}`);
    }

    return { rows: [] };
  }

  async end() {
    this.closed = true;
  }
}

describe('brand kit catalog configuration', () => {
  it('uses configured PostgreSQL URLs and can be disabled explicitly', () => {
    assert.equal(getPostgresBrandKitCatalogConfig({}), null);
    assert.equal(
      getPostgresBrandKitCatalogConfig({
        DATABASE_URL: 'postgres://example',
        BRAND_KIT_CATALOG_PERSISTENCE_DISABLED: 'true',
      }),
      null
    );
    assert.deepEqual(
      getPostgresBrandKitCatalogConfig({
        POSTGRES_URL: 'postgres://example',
        PGSSLMODE: 'require',
      }),
      {
        connectionString: 'postgres://example',
        ssl: { rejectUnauthorized: false },
      }
    );
  });
});

describe('brand kit catalog normalization', () => {
  it('normalizes bounded brand metadata for cross-device dashboards', () => {
    const now = new Date('2026-07-02T11:00:00.000Z');
    const normalized = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry({
      id: ' kit\x00-1 ',
      logoOpacity: 2,
      logoPosition: { x: 2, y: -1 },
    }), now);

    assert.equal(normalized.id, 'kit-1');
    assert.equal(normalized.roomId, ROOM_ID);
    assert.equal(normalized.updatedAt, now.toISOString());
    assert.equal(normalized.studioTheme, 'colorful');
    assert.equal(normalized.brandColor, '#2563eb');
    assert.equal(normalized.logoUrl, 'data:image/png;base64,logo');
    assert.deepEqual(normalized.logoPosition, { x: 1, y: 0 });
    assert.equal(normalized.logoOpacity, 1);
    assert.equal(normalized.cameraShape, 'rounded');
    assert.equal(normalized.nameTagStyle, 'block');
  });

  it('drops transient or unsafe asset URLs', () => {
    const normalized = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry({
      logoUrl: 'javascript:alert(1)',
      stageBackground: { type: 'image', value: 'blob:https://example.test/background' },
    }));

    assert.equal(normalized.logoUrl, null);
    assert.deepEqual(normalized.stageBackground, { type: 'none', value: '' });
  });

  it('rejects entries without stable identity and timestamps', () => {
    assert.throws(
      () => normalizeBrandKitCatalogEntry(ROOM_ID, { id: 'kit-without-created-at' }),
      BrandKitCatalogError
    );
  });
});

describe('InMemoryBrandKitCatalogStore', () => {
  it('upserts, lists newest first, and deletes room brand kits', async () => {
    const store = new InMemoryBrandKitCatalogStore();
    const first = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry({ id: 'kit-1' }));
    const second = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry({
      id: 'kit-2',
      createdAt: '2026-07-02T11:00:00.000Z',
    }));

    await store.upsertBrandKit(first);
    await store.upsertBrandKit(second);

    const listed = await store.listRoomBrandKits(ROOM_ID);
    assert.deepEqual(listed.map((entry) => entry.id), ['kit-2', 'kit-1']);

    await store.deleteBrandKit(ROOM_ID, 'kit-2');
    assert.deepEqual((await store.listRoomBrandKits(ROOM_ID)).map((entry) => entry.id), ['kit-1']);
  });
});

describe('PostgresBrandKitCatalogStore', () => {
  it('creates schema, upserts normalized entries, lists rows, and deletes entries', async () => {
    const fakeDb = new FakeDb();
    const store = new PostgresBrandKitCatalogStore(fakeDb);
    const entry = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry());

    await store.init();
    await store.upsertBrandKit(entry);

    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_brand_kit_catalog')));
    assert.ok(fakeDb.queries.some((query) => query.sql.includes('ON CONFLICT (room_id, brand_kit_id) DO UPDATE')));

    const listed = await store.listRoomBrandKits(ROOM_ID);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, entry.id);
    assert.equal(listed[0].logoUrl, 'data:image/png;base64,logo');

    await store.deleteBrandKit(ROOM_ID, entry.id);
    assert.deepEqual(await store.listRoomBrandKits(ROOM_ID), []);

    await store.close();
    assert.equal(fakeDb.closed, true);
  });
});

describe('brand kit catalog response', () => {
  it('sorts catalog rows newest first', () => {
    const older = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry({
      id: 'older',
      createdAt: '2026-07-02T09:00:00.000Z',
    }));
    const newer = normalizeBrandKitCatalogEntry(ROOM_ID, brandKitEntry({
      id: 'newer',
      createdAt: '2026-07-02T12:00:00.000Z',
    }));

    const response = buildBrandKitCatalogListResponse(ROOM_ID, [older, newer]);
    assert.deepEqual(response.brandKits.map((entry) => entry.id), ['newer', 'older']);
  });
});
