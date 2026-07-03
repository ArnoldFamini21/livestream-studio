import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWorkspaceStudioCatalogListResponse,
  getPostgresWorkspaceStudioCatalogConfig,
  InMemoryWorkspaceStudioCatalogStore,
  normalizeWorkspaceStudioCatalogEntry,
  PostgresWorkspaceStudioCatalogStore,
  WorkspaceStudioCatalogError,
} from '../dist/services/workspaceStudioCatalog.js';

const ROOM_ID = 'room-studio-catalog';
const HOST_TOKEN = 'StudioHostToken_1234567890';

function studio(overrides = {}) {
  return {
    id: 'studio-1',
    name: 'Sermon Studio',
    hostName: 'Arnold',
    hostToken: HOST_TOKEN,
    createdAt: '2026-07-02T10:00:00.000Z',
    scheduledFor: '2026-07-05T18:00:00.000Z',
    passwordProtected: true,
    registrationEnabled: true,
    status: 'scheduled',
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
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          .slice(0, params[1])
          .map((row) => ({ studio: row.studio })),
      };
    }

    if (normalizedSql.startsWith('INSERT')) {
      const [roomId, studioId, studioJson, createdAt, updatedAt] = params;
      this.rows.set(`${roomId}:${studioId}`, {
        room_id: roomId,
        studio_id: studioId,
        studio: JSON.parse(studioJson),
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

describe('workspace studio catalog configuration', () => {
  it('uses configured PostgreSQL URLs and can be disabled explicitly', () => {
    assert.equal(getPostgresWorkspaceStudioCatalogConfig({}), null);
    assert.equal(
      getPostgresWorkspaceStudioCatalogConfig({
        DATABASE_URL: 'postgres://example',
        WORKSPACE_STUDIO_CATALOG_PERSISTENCE_DISABLED: '1',
      }),
      null
    );
    assert.deepEqual(
      getPostgresWorkspaceStudioCatalogConfig({
        POSTGRES_PRISMA_URL: 'postgres://example',
        PGSSLMODE: 'verify-full',
      }),
      {
        connectionString: 'postgres://example',
        ssl: { rejectUnauthorized: true },
      }
    );
  });
});

describe('workspace studio catalog normalization', () => {
  it('normalizes bounded saved studios with private host links', () => {
    const now = new Date('2026-07-02T11:00:00.000Z');
    const normalized = normalizeWorkspaceStudioCatalogEntry(studio({
      id: ' studio-1\x00 ',
      name: '  Sermon Studio  ',
      status: 'live',
    }), now);

    assert.equal(normalized.id, 'studio-1');
    assert.equal(normalized.name, 'Sermon Studio');
    assert.equal(normalized.hostName, 'Arnold');
    assert.equal(normalized.hostToken, HOST_TOKEN);
    assert.equal(normalized.createdAt, '2026-07-02T10:00:00.000Z');
    assert.equal(normalized.scheduledFor, '2026-07-05T18:00:00.000Z');
    assert.equal(normalized.passwordProtected, true);
    assert.equal(normalized.registrationEnabled, true);
    assert.equal(normalized.status, 'live');
    assert.equal(normalized.updatedAt, now.toISOString());
  });

  it('rejects entries without a valid private host link', () => {
    assert.throws(
      () => normalizeWorkspaceStudioCatalogEntry(studio({ hostToken: 'short' })),
      WorkspaceStudioCatalogError
    );
  });
});

describe('InMemoryWorkspaceStudioCatalogStore', () => {
  it('upserts, lists newest first, and deletes saved studios', async () => {
    const store = new InMemoryWorkspaceStudioCatalogStore();
    const first = normalizeWorkspaceStudioCatalogEntry(studio({ id: 'studio-1' }));
    const second = normalizeWorkspaceStudioCatalogEntry(studio({
      id: 'studio-2',
      name: 'Workshop',
      createdAt: '2026-07-03T10:00:00.000Z',
      scheduledFor: '2026-07-06T18:00:00.000Z',
    }));

    await store.upsertStudio(ROOM_ID, first);
    await store.upsertStudio(ROOM_ID, second);

    const listed = await store.listRoomStudios(ROOM_ID);
    assert.deepEqual(listed.map((entry) => entry.id), ['studio-2', 'studio-1']);

    await store.deleteStudio(ROOM_ID, 'studio-2');
    assert.deepEqual((await store.listRoomStudios(ROOM_ID)).map((entry) => entry.id), ['studio-1']);
  });
});

describe('PostgresWorkspaceStudioCatalogStore', () => {
  it('creates schema, upserts normalized entries, lists rows, and deletes entries', async () => {
    const fakeDb = new FakeDb();
    const store = new PostgresWorkspaceStudioCatalogStore(fakeDb);
    const entry = normalizeWorkspaceStudioCatalogEntry(studio());

    await store.init();
    await store.upsertStudio(ROOM_ID, entry);

    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_workspace_studio_catalog')));
    assert.ok(fakeDb.queries.some((query) => query.sql.includes('ON CONFLICT (room_id, studio_id) DO UPDATE')));

    const listed = await store.listRoomStudios(ROOM_ID);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, entry.id);
    assert.equal(listed[0].hostToken, HOST_TOKEN);

    await store.deleteStudio(ROOM_ID, entry.id);
    assert.deepEqual(await store.listRoomStudios(ROOM_ID), []);

    await store.close();
    assert.equal(fakeDb.closed, true);
  });
});

describe('workspace studio catalog response', () => {
  it('sorts catalog rows by schedule or creation time, newest first', () => {
    const older = normalizeWorkspaceStudioCatalogEntry(studio({
      id: 'older',
      scheduledFor: '2026-07-02T09:00:00.000Z',
    }));
    const newer = normalizeWorkspaceStudioCatalogEntry(studio({
      id: 'newer',
      scheduledFor: '2026-07-02T12:00:00.000Z',
    }));

    const response = buildWorkspaceStudioCatalogListResponse(ROOM_ID, [older, newer]);
    assert.deepEqual(response.studios.map((entry) => entry.id), ['newer', 'older']);
  });
});
