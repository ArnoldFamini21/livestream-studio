import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWorkspaceTeamCatalogListResponse,
  getPostgresWorkspaceTeamCatalogConfig,
  InMemoryWorkspaceTeamCatalogStore,
  normalizeWorkspaceTeamCatalogMember,
  PostgresWorkspaceTeamCatalogStore,
  WorkspaceTeamCatalogError,
} from '../dist/services/workspaceTeamCatalog.js';

const ROOM_ID = 'room-team';

function teamMember(overrides = {}) {
  return {
    id: 'member-1',
    name: 'Producer',
    email: 'Producer@Example.COM',
    role: 'producer',
    createdAt: '2026-07-02T10:00:00.000Z',
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
          .sort((a, b) => Date.parse(b.member.createdAt) - Date.parse(a.member.createdAt))
          .slice(0, params[1])
          .map((row) => ({ member: row.member })),
      };
    }

    if (normalizedSql.startsWith('INSERT')) {
      const [roomId, memberId, memberJson, createdAt, updatedAt] = params;
      this.rows.set(`${roomId}:${memberId}`, {
        room_id: roomId,
        member_id: memberId,
        member: JSON.parse(memberJson),
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

describe('workspace team catalog configuration', () => {
  it('uses configured PostgreSQL URLs and can be disabled explicitly', () => {
    assert.equal(getPostgresWorkspaceTeamCatalogConfig({}), null);
    assert.equal(
      getPostgresWorkspaceTeamCatalogConfig({
        DATABASE_URL: 'postgres://example',
        WORKSPACE_TEAM_CATALOG_PERSISTENCE_DISABLED: 'true',
      }),
      null
    );
    assert.deepEqual(
      getPostgresWorkspaceTeamCatalogConfig({
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

describe('workspace team catalog normalization', () => {
  it('normalizes bounded team roster members for cross-device dashboards', () => {
    const now = new Date('2026-07-02T11:00:00.000Z');
    const normalized = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember({
      id: ' member\x00-1 ',
      role: 'owner',
    }), now);

    assert.equal(normalized.id, 'member-1');
    assert.equal(normalized.roomId, ROOM_ID);
    assert.equal(normalized.name, 'Producer');
    assert.equal(normalized.email, 'producer@example.com');
    assert.equal(normalized.role, 'owner');
    assert.equal(normalized.createdAt, '2026-07-02T10:00:00.000Z');
    assert.equal(normalized.updatedAt, now.toISOString());
  });

  it('drops invalid emails and falls back to producer role', () => {
    const normalized = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember({
      email: 'not an email',
      role: 'admin',
    }));

    assert.equal(normalized.email, '');
    assert.equal(normalized.role, 'producer');
  });

  it('rejects entries without stable identity and timestamps', () => {
    assert.throws(
      () => normalizeWorkspaceTeamCatalogMember(ROOM_ID, { id: 'member-without-created-at' }),
      WorkspaceTeamCatalogError
    );
  });
});

describe('InMemoryWorkspaceTeamCatalogStore', () => {
  it('upserts, lists newest first, and deletes room team members', async () => {
    const store = new InMemoryWorkspaceTeamCatalogStore();
    const first = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember({ id: 'member-1' }));
    const second = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember({
      id: 'member-2',
      name: 'Guest Manager',
      role: 'guest-manager',
      createdAt: '2026-07-02T11:00:00.000Z',
    }));

    await store.upsertMember(first);
    await store.upsertMember(second);

    const listed = await store.listRoomMembers(ROOM_ID);
    assert.deepEqual(listed.map((entry) => entry.id), ['member-2', 'member-1']);

    await store.deleteMember(ROOM_ID, 'member-2');
    assert.deepEqual((await store.listRoomMembers(ROOM_ID)).map((entry) => entry.id), ['member-1']);
  });
});

describe('PostgresWorkspaceTeamCatalogStore', () => {
  it('creates schema, upserts normalized entries, lists rows, and deletes entries', async () => {
    const fakeDb = new FakeDb();
    const store = new PostgresWorkspaceTeamCatalogStore(fakeDb);
    const entry = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember());

    await store.init();
    await store.upsertMember(entry);

    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_workspace_team_catalog')));
    assert.ok(fakeDb.queries.some((query) => query.sql.includes('ON CONFLICT (room_id, member_id) DO UPDATE')));

    const listed = await store.listRoomMembers(ROOM_ID);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, entry.id);
    assert.equal(listed[0].email, 'producer@example.com');

    await store.deleteMember(ROOM_ID, entry.id);
    assert.deepEqual(await store.listRoomMembers(ROOM_ID), []);

    await store.close();
    assert.equal(fakeDb.closed, true);
  });
});

describe('workspace team catalog response', () => {
  it('sorts catalog rows newest first', () => {
    const older = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember({
      id: 'older',
      createdAt: '2026-07-02T09:00:00.000Z',
    }));
    const newer = normalizeWorkspaceTeamCatalogMember(ROOM_ID, teamMember({
      id: 'newer',
      createdAt: '2026-07-02T12:00:00.000Z',
    }));

    const response = buildWorkspaceTeamCatalogListResponse(ROOM_ID, [older, newer]);
    assert.deepEqual(response.members.map((entry) => entry.id), ['newer', 'older']);
  });
});
