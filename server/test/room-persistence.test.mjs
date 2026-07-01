import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PostgresRoomSnapshotStore,
  buildPersistentRoomSnapshot,
  getPostgresRoomSnapshotConfig,
  normalizeRoomSnapshot,
} from '../dist/services/roomPersistence.js';
import {
  configureRoomSnapshotStore,
  getRooms,
  recoverHostAccess,
  restoreRoomSnapshots,
} from '../dist/services/signaling.js';

const VALID_HOST_TOKEN = 'PersistedHostToken_1234567890';

function createSnapshot(overrides = {}) {
  return {
    room: {
      id: `room-${Math.random().toString(36).slice(2)}`,
      name: 'Persisted studio',
      hostId: 'stale-host-id',
      coHostIds: ['stale-co-host-id'],
      createdAt: '2026-07-01T10:00:00.000Z',
      status: 'live',
      settings: {
        maxParticipants: 7,
        resolution: '1080p',
        frameRate: 30,
        enableRecording: true,
        enableStreaming: false,
        greenRoomEnabled: true,
        passwordProtected: false,
      },
      hostName: 'Arnold',
    },
    hostToken: VALID_HOST_TOKEN,
    creatorIp: '198.51.100.42',
    hasBeenJoined: false,
    ...overrides,
  };
}

class FakeDb {
  queries = [];
  rows = [];
  closed = false;

  async query(sql, params = []) {
    this.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/SELECT room_id/i.test(sql)) return { rows: this.rows };
    return { rows: [] };
  }

  async end() {
    this.closed = true;
  }
}

describe('room snapshot persistence', () => {
  it('configures PostgreSQL only when a database URL is present and enabled', () => {
    assert.equal(getPostgresRoomSnapshotConfig({}), null);
    assert.equal(getPostgresRoomSnapshotConfig({
      DATABASE_URL: 'postgres://example',
      ROOM_PERSISTENCE_DISABLED: 'true',
    }), null);
    assert.deepEqual(getPostgresRoomSnapshotConfig({
      DATABASE_URL: 'postgres://example',
      PGSSLMODE: 'require',
    }), {
      connectionString: 'postgres://example',
      ssl: { rejectUnauthorized: false },
    });
  });

  it('normalizes persisted room snapshots without restoring stale participants', () => {
    const snapshot = normalizeRoomSnapshot(createSnapshot());

    assert.equal(snapshot?.room.status, 'waiting');
    assert.equal(snapshot?.room.hostId, '');
    assert.deepEqual(snapshot?.room.coHostIds, []);
    assert.equal(snapshot?.hostToken, VALID_HOST_TOKEN);
    assert.equal(snapshot?.creatorIp, '198.51.100.42');
  });

  it('rejects malformed snapshots and builds persistent waiting-room state', () => {
    assert.equal(normalizeRoomSnapshot(createSnapshot({ hostToken: 'short' })), null);

    const snapshot = buildPersistentRoomSnapshot(createSnapshot({
      room: {
        ...createSnapshot().room,
        status: 'recording',
      },
      hasBeenJoined: true,
    }));

    assert.equal(snapshot.room.status, 'waiting');
    assert.equal(snapshot.hasBeenJoined, true);
    assert.equal(snapshot.room.hostId, '');
  });

  it('creates the table, upserts snapshots, loads valid rows, and closes the pool', async () => {
    const db = new FakeDb();
    const store = new PostgresRoomSnapshotStore(db);
    await store.init();
    await store.saveRoomSnapshot(createSnapshot());

    const upsert = db.queries.find((query) => /INSERT INTO studio_room_snapshots/i.test(query.sql));
    assert.ok(upsert);
    assert.equal(upsert.params[2], VALID_HOST_TOKEN);
    assert.equal(JSON.parse(upsert.params[1]).status, 'waiting');

    db.rows = [
      {
        room: createSnapshot().room,
        host_token: VALID_HOST_TOKEN,
        creator_ip: '198.51.100.42',
        has_been_joined: false,
      },
      {
        room: { id: 'bad' },
        host_token: 'short',
        creator_ip: '198.51.100.42',
        has_been_joined: false,
      },
    ];
    const snapshots = await store.loadRoomSnapshots();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].hostToken, VALID_HOST_TOKEN);

    await store.deleteRoomSnapshot('room-to-delete');
    assert.match(db.queries.at(-1).sql, /^DELETE FROM studio_room_snapshots/);

    await store.close();
    assert.equal(db.closed, true);
  });

  it('restores snapshots into signaling and preserves host access recovery', () => {
    configureRoomSnapshotStore(null);
    const snapshot = buildPersistentRoomSnapshot(createSnapshot({
      room: {
        ...createSnapshot().room,
        id: `restore-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        createdAt: new Date().toISOString(),
      },
    }));

    const restored = restoreRoomSnapshots([snapshot]);
    const recovery = recoverHostAccess(snapshot.room.id, snapshot.creatorIp);

    assert.equal(restored, 1);
    assert.equal(recovery.status, 'ok');
    assert.equal(recovery.status === 'ok' ? recovery.hostToken : '', VALID_HOST_TOKEN);

    getRooms().delete(snapshot.room.id);
  });
});
