import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  buildPersistentRoomSnapshot,
  getPostgresRoomSnapshotConfig,
  normalizeRoomSnapshot,
  PostgresRoomSnapshotStore,
} from '../dist/services/roomPersistence.js';
import {
  configureRoomSnapshotStore,
  createRoom,
  getRoomRegistrantList,
  getRooms,
  recoverHostAccess,
  registerRoomGuest,
  restoreRoomSnapshots,
} from '../dist/services/signaling.js';

const HOST_TOKEN = 'host-token-0123456789abcdef';

function baseRoom(overrides = {}) {
  return {
    id: `room-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Persistent Room',
    hostId: 'connected-host',
    coHostIds: ['connected-cohost'],
    createdAt: new Date().toISOString(),
    status: 'waiting',
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
    registration: {
      enabled: true,
      fields: ['name', 'email'],
    },
    ...overrides,
  };
}

function baseSnapshot(overrides = {}) {
  const room = baseRoom(overrides.room);
  return {
    room,
    hostToken: HOST_TOKEN,
    creatorIp: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    hasBeenJoined: false,
    registrants: [],
    ...overrides,
    room: {
      ...room,
      ...(overrides.room || {}),
    },
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
          .filter((row) => row.room.status !== 'ended')
          .sort((a, b) => Date.parse(a.room.createdAt) - Date.parse(b.room.createdAt))
          .slice(0, 1000),
      };
    }

    if (normalizedSql.startsWith('INSERT')) {
      const [
        roomId,
        roomJson,
        hostToken,
        creatorIp,
        hasBeenJoined,
        registrantsJson,
        studioBrandingJson,
        passwordHash,
        passwordSalt,
      ] = params;

      this.rows.set(roomId, {
        room: JSON.parse(roomJson),
        host_token: hostToken,
        creator_ip: creatorIp,
        has_been_joined: hasBeenJoined,
        registrants: JSON.parse(registrantsJson),
        studio_branding: studioBrandingJson ? JSON.parse(studioBrandingJson) : null,
        password_hash: passwordHash,
        password_salt: passwordSalt,
      });
    }

    if (normalizedSql.startsWith('DELETE')) {
      this.rows.delete(params[0]);
    }

    return { rows: [] };
  }

  async end() {
    this.closed = true;
  }
}

after(() => {
  configureRoomSnapshotStore(null);
});

describe('room persistence configuration', () => {
  it('uses configured PostgreSQL URLs and can be disabled explicitly', () => {
    assert.equal(getPostgresRoomSnapshotConfig({}), null);
    assert.equal(
      getPostgresRoomSnapshotConfig({
        DATABASE_URL: 'postgres://example',
        ROOM_PERSISTENCE_DISABLED: 'true',
      }),
      null
    );
    assert.deepEqual(
      getPostgresRoomSnapshotConfig({
        POSTGRES_URL: 'postgres://example',
        PGSSLMODE: 'require',
      }),
      {
        connectionString: 'postgres://example',
        ssl: { rejectUnauthorized: false },
      }
    );
    assert.deepEqual(
      getPostgresRoomSnapshotConfig({
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

describe('room snapshot normalization', () => {
  it('keeps only restart-safe room state', () => {
    const createdAt = new Date().toISOString();
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const snapshot = buildPersistentRoomSnapshot(baseSnapshot({
      room: {
        createdAt,
        status: 'live',
      },
      hasBeenJoined: true,
      registrants: [
        {
          id: 'first',
          roomId: 'ignored',
          name: 'Jane',
          email: 'JANE@example.com',
          registeredAt: createdAt,
        },
        {
          id: 'second',
          roomId: 'ignored',
          name: 'Jane Updated',
          email: 'jane@example.com',
          registeredAt: scheduledFor,
        },
      ],
      studioBranding: {
        brandColor: '#a78bfa',
        logoUrl: 'https://example.com/logo.png',
        stageBackground: { type: 'none', value: '' },
        waitingRoom: {
          headline: 'Welcome',
          message: 'Please wait',
          backgroundMode: 'studio',
          showLogo: false,
        },
        updatedAt: createdAt,
        updatedBy: 'host',
      },
    }));

    assert.equal(snapshot.room.status, 'waiting');
    assert.equal(snapshot.room.hostId, '');
    assert.deepEqual(snapshot.room.coHostIds, []);
    assert.equal(snapshot.hasBeenJoined, true);
    assert.equal(snapshot.registrants?.length, 1);
    assert.equal(snapshot.registrants?.[0].roomId, snapshot.room.id);
    assert.equal(snapshot.registrants?.[0].email, 'jane@example.com');
    assert.equal(snapshot.registrants?.[0].name, 'Jane Updated');
    assert.equal(snapshot.studioBranding?.waitingRoom.backgroundMode, 'studio');

    const scheduled = buildPersistentRoomSnapshot(baseSnapshot({
      room: {
        status: 'scheduled',
        scheduledFor,
      },
    }));
    assert.equal(scheduled.room.status, 'scheduled');
    assert.equal(scheduled.room.scheduledFor, scheduledFor);
  });

  it('rejects malformed snapshots', () => {
    assert.equal(normalizeRoomSnapshot({ room: { id: 'missing required fields' } }), null);
    assert.equal(normalizeRoomSnapshot(baseSnapshot({ hostToken: 'short' })), null);
  });
});

describe('PostgresRoomSnapshotStore', () => {
  it('creates schema, upserts snapshots, loads normalized rows, and deletes snapshots', async () => {
    const fakeDb = new FakeDb();
    const store = new PostgresRoomSnapshotStore(fakeDb);
    const snapshot = baseSnapshot({
      room: { status: 'recording' },
      registrants: [
        {
          id: 'viewer',
          roomId: 'ignored',
          name: 'Viewer',
          email: 'viewer@example.com',
          registeredAt: new Date().toISOString(),
        },
      ],
      passwordHash: 'hash',
      passwordSalt: 'salt',
    });

    await store.init();
    await store.saveRoomSnapshot(snapshot);
    const loaded = await store.loadRoomSnapshots();

    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_room_snapshots')));
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].room.id, snapshot.room.id);
    assert.equal(loaded[0].room.status, 'waiting');
    assert.equal(loaded[0].registrants?.[0].email, 'viewer@example.com');
    assert.equal(loaded[0].passwordHash, 'hash');

    await store.deleteRoomSnapshot(snapshot.room.id);
    assert.deepEqual(await store.loadRoomSnapshots(), []);
    await store.close();
    assert.equal(fakeDb.closed, true);
  });
});

describe('signaling room snapshot restore', () => {
  it('does not restore ended room snapshots', () => {
    const snapshot = buildPersistentRoomSnapshot(baseSnapshot({
      room: {
        status: 'ended',
      },
    }));

    assert.equal(restoreRoomSnapshots([snapshot]), 0);
    assert.equal(getRooms().has(snapshot.room.id), false);
  });

  it('restores rooms for host recovery and registrant export', () => {
    const createdAt = new Date().toISOString();
    const snapshot = buildPersistentRoomSnapshot(baseSnapshot({
      room: {
        createdAt,
        name: 'Restored Room',
      },
      registrants: [
        {
          id: 'viewer',
          roomId: 'ignored',
          name: 'Viewer',
          email: 'viewer@example.com',
          registeredAt: createdAt,
        },
      ],
    }));

    try {
      assert.equal(restoreRoomSnapshots([snapshot]), 1);

      const roomState = getRooms().get(snapshot.room.id);
      assert.ok(roomState);
      assert.equal(roomState.participants.size, 0);
      assert.equal(roomState.registrants.size, 1);

      const recovery = recoverHostAccess(snapshot.room.id, snapshot.creatorIp);
      assert.equal(recovery.status, 'ok');
      assert.equal(recovery.status === 'ok' ? recovery.hostToken : '', snapshot.hostToken);

      const registrants = getRoomRegistrantList(snapshot.room.id, snapshot.hostToken);
      assert.equal(registrants.registrants.length, 1);
      assert.equal(registrants.registrants[0].email, 'viewer@example.com');
    } finally {
      getRooms().delete(snapshot.room.id);
    }
  });

  it('persists create and registration updates when a snapshot store is configured', () => {
    const saved = [];
    configureRoomSnapshotStore({
      async init() {},
      async loadRoomSnapshots() {
        return [];
      },
      async saveRoomSnapshot(snapshot) {
        saved.push(snapshot);
      },
      async deleteRoomSnapshot() {},
      async close() {},
    });

    const creatorIp = `persist-create-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { room, hostToken } = createRoom('Persist Create Room', 'Arnold', {
      creatorIp,
      registrationEnabled: true,
    });

    try {
      assert.equal(saved.length, 1);
      assert.equal(saved[0].room.id, room.id);
      assert.equal(saved[0].hostToken, hostToken);

      registerRoomGuest(room.id, {
        name: 'Viewer',
        email: 'viewer@example.com',
      });

      assert.equal(saved.length, 2);
      assert.equal(saved[1].registrants.length, 1);
      assert.equal(saved[1].registrants[0].email, 'viewer@example.com');
    } finally {
      configureRoomSnapshotStore(null);
      getRooms().delete(room.id);
    }
  });
});
