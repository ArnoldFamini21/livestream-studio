import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { buildPersistentRoomSnapshot, PostgresRoomSnapshotStore } from '../dist/services/roomPersistence.js';
import { normalizeRecordingCatalogEntry, PostgresRecordingCatalogStore } from '../dist/services/recordingCatalog.js';
import { normalizeBrandKitCatalogEntry, PostgresBrandKitCatalogStore } from '../dist/services/brandKitCatalog.js';
import {
  normalizeWorkspaceStudioCatalogEntry,
  PostgresWorkspaceStudioCatalogStore,
} from '../dist/services/workspaceStudioCatalog.js';
import {
  normalizeWorkspaceTeamCatalogMember,
  PostgresWorkspaceTeamCatalogStore,
} from '../dist/services/workspaceTeamCatalog.js';

// The other store tests use a fake database that only pattern-matches SQL.
// These run the real statements against PostgreSQL:
// STUDIO_TEST_DATABASE_URL=postgres://studio:studio@127.0.0.1/studio npm run -w server test
const testDatabaseUrl = process.env.STUDIO_TEST_DATABASE_URL;

const TABLES = [
  'studio_room_snapshots',
  'studio_recording_catalog',
  'studio_brand_kit_catalog',
  'studio_workspace_studio_catalog',
  'studio_account_workspace_studio_catalog',
  'studio_workspace_team_catalog',
];

if (!testDatabaseUrl) {
  describe('postgres stores', () => {
    it('runs when STUDIO_TEST_DATABASE_URL is set', { skip: 'STUDIO_TEST_DATABASE_URL is not set' }, () => {});
  });
} else {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  const db = { query: (sql, params) => pool.query(sql, params) };
  after(async () => { await pool.end(); });

  async function freshStore(Store) {
    await pool.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
    const store = new Store(db);
    await store.init();
    // A second init against existing tables must not fail (every server start runs it).
    await store.init();
    return store;
  }

  describe('postgres stores', () => {
    it('room snapshots: save, update, load, skip ended rooms, delete', async () => {
      const store = await freshStore(PostgresRoomSnapshotStore);
      const snapshot = (id, status, createdAt) => buildPersistentRoomSnapshot({
        room: {
          id,
          name: `Room ${id}`,
          hostId: 'host',
          coHostIds: [],
          createdAt,
          status,
          settings: {
            maxParticipants: 7, resolution: '1080p', frameRate: 30, enableRecording: true,
            enableStreaming: false, greenRoomEnabled: true, passwordProtected: true,
          },
          hostName: 'Arnold',
          registration: { enabled: true, fields: ['name', 'email'] },
        },
        hostToken: 'host-token-0123456789abcdef',
        creatorIp: '203.0.113.7',
        hasBeenJoined: true,
        registrants: [{ id: 'r1', roomId: id, name: 'Nica', email: 'nica@example.com', registeredAt: createdAt }],
        passwordHash: 'hash',
        passwordSalt: 'salt',
      });

      await store.saveRoomSnapshot(snapshot('older', 'waiting', '2026-09-01T10:00:00.000Z'));
      await store.saveRoomSnapshot(snapshot('newer', 'live', '2026-09-02T10:00:00.000Z'));
      await store.saveRoomSnapshot(snapshot('ended', 'ended', '2026-09-03T10:00:00.000Z'));
      // Upsert: the same room saved again replaces the row.
      const renamed = snapshot('older', 'waiting', '2026-09-01T10:00:00.000Z');
      renamed.room.name = 'Renamed';
      await store.saveRoomSnapshot(renamed);

      const loaded = await store.loadRoomSnapshots();
      assert.deepEqual(loaded.map((entry) => entry.room.id), ['older', 'newer']);
      assert.equal(loaded[0].room.name, 'Renamed');
      assert.equal(loaded[0].registrants?.[0].email, 'nica@example.com');
      assert.equal(loaded[0].passwordHash, 'hash');
      assert.equal(loaded[0].hasBeenJoined, true);

      await store.deleteRoomSnapshot('older');
      assert.deepEqual((await store.loadRoomSnapshots()).map((entry) => entry.room.id), ['newer']);
    });

    it('recording catalog: upsert, newest first, per room, delete', async () => {
      const store = await freshStore(PostgresRecordingCatalogStore);
      const entry = (roomId, id, createdAt, extra = {}) => normalizeRecordingCatalogEntry(roomId, 'Vespers', {
        id, roomName: 'Vespers', createdAt, durationSeconds: 60, trackCount: 2, totalBytes: 1000, markerCount: 0, ...extra,
      });
      await store.upsertRecording(entry('room-a', 'rec-1', '2026-09-01T10:00:00.000Z'));
      await store.upsertRecording(entry('room-a', 'rec-2', '2026-09-02T10:00:00.000Z'));
      await store.upsertRecording(entry('room-b', 'rec-3', '2026-09-03T10:00:00.000Z'));
      await store.upsertRecording(entry('room-a', 'rec-1', '2026-09-01T10:00:00.000Z', { durationSeconds: 90 }));

      const listed = await store.listRoomRecordings('room-a');
      assert.deepEqual(listed.map((item) => item.id), ['rec-2', 'rec-1']);
      assert.equal(listed[1].durationSeconds, 90);

      await store.deleteRecording('room-a', 'rec-1');
      assert.deepEqual((await store.listRoomRecordings('room-a')).map((item) => item.id), ['rec-2']);
      assert.deepEqual((await store.listRoomRecordings('room-b')).map((item) => item.id), ['rec-3']);
    });

    it('brand kit catalog: upsert, newest first, per room, delete', async () => {
      const store = await freshStore(PostgresBrandKitCatalogStore);
      const kit = (roomId, id, createdAt, name = 'Church brand') => normalizeBrandKitCatalogEntry(roomId, {
        id, name, createdAt, studioTheme: 'colorful', brandColor: '#2563eb',
        stageBackground: { type: 'color', value: '#0f172a' }, logoPlacement: 'bottom-right',
      });
      await store.upsertBrandKit(kit('room-a', 'kit-1', '2026-09-01T10:00:00.000Z'));
      await store.upsertBrandKit(kit('room-a', 'kit-2', '2026-09-02T10:00:00.000Z'));
      await store.upsertBrandKit(kit('room-a', 'kit-1', '2026-09-01T10:00:00.000Z', 'Renamed'));

      const listed = await store.listRoomBrandKits('room-a');
      assert.deepEqual(listed.map((item) => item.id), ['kit-2', 'kit-1']);
      assert.equal(listed[1].name, 'Renamed');
      assert.equal(listed[0].brandColor, '#2563eb');

      await store.deleteBrandKit('room-a', 'kit-2');
      assert.deepEqual((await store.listRoomBrandKits('room-a')).map((item) => item.id), ['kit-1']);
    });

    it('workspace studios: room and account catalogs sorted by schedule, reschedule, delete', async () => {
      const store = await freshStore(PostgresWorkspaceStudioCatalogStore);
      const studio = (id, scheduledFor, name = 'Sabbath Service') => normalizeWorkspaceStudioCatalogEntry({
        id, name, hostName: 'Arnold', hostToken: 'StudioHostToken_1234567890', createdAt: '2026-09-01T10:00:00.000Z',
        scheduledFor, passwordProtected: false, registrationEnabled: true, status: 'scheduled',
      });
      await store.upsertStudio('room-a', studio('studio-1', '2026-09-27T01:00:00.000Z'));
      await store.upsertStudio('room-a', studio('studio-2', '2026-10-04T01:00:00.000Z'));
      assert.deepEqual((await store.listRoomStudios('room-a')).map((item) => item.id), ['studio-2', 'studio-1']);
      // Rescheduling studio-1 past studio-2 moves it to the top.
      await store.upsertStudio('room-a', studio('studio-1', '2026-10-11T01:00:00.000Z', 'Renamed'));
      const roomList = await store.listRoomStudios('room-a');
      assert.deepEqual(roomList.map((item) => item.id), ['studio-1', 'studio-2']);
      assert.equal(roomList[0].name, 'Renamed');
      assert.equal(roomList[0].scheduledFor, '2026-10-11T01:00:00.000Z');

      await store.upsertAccountStudio('account-1', studio('studio-1', '2026-09-27T01:00:00.000Z'));
      await store.upsertAccountStudio('account-1', studio('studio-3', '2026-10-04T01:00:00.000Z'));
      await store.upsertAccountStudio('account-2', studio('studio-4', '2026-10-04T01:00:00.000Z'));
      assert.deepEqual((await store.listAccountStudios('account-1')).map((item) => item.id), ['studio-3', 'studio-1']);
      await store.upsertAccountStudio('account-1', studio('studio-1', '2026-10-11T01:00:00.000Z'));
      assert.deepEqual((await store.listAccountStudios('account-1')).map((item) => item.id), ['studio-1', 'studio-3']);

      await store.deleteStudio('room-a', 'studio-2');
      await store.deleteAccountStudio('account-1', 'studio-3');
      assert.deepEqual((await store.listRoomStudios('room-a')).map((item) => item.id), ['studio-1']);
      assert.deepEqual((await store.listAccountStudios('account-1')).map((item) => item.id), ['studio-1']);
      assert.deepEqual((await store.listAccountStudios('account-2')).map((item) => item.id), ['studio-4']);
    });

    it('workspace team: upsert, newest first, per room, delete', async () => {
      const store = await freshStore(PostgresWorkspaceTeamCatalogStore);
      const member = (roomId, id, createdAt, role = 'producer') => normalizeWorkspaceTeamCatalogMember(roomId, {
        id, name: `Member ${id}`, email: `${id}@Example.COM`, role, createdAt,
      });
      await store.upsertMember(member('room-a', 'm1', '2026-09-01T10:00:00.000Z'));
      await store.upsertMember(member('room-a', 'm2', '2026-09-02T10:00:00.000Z'));
      await store.upsertMember(member('room-a', 'm1', '2026-09-01T10:00:00.000Z', 'editor'));

      const listed = await store.listRoomMembers('room-a');
      assert.deepEqual(listed.map((item) => item.id), ['m2', 'm1']);
      assert.equal(listed[1].role, 'editor');
      assert.equal(listed[1].email, 'm1@example.com');

      await store.deleteMember('room-a', 'm2');
      assert.deepEqual((await store.listRoomMembers('room-a')).map((item) => item.id), ['m1']);
    });
  });
}
