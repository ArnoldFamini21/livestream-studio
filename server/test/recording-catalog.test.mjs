import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRecordingCatalogListResponse,
  getPostgresRecordingCatalogConfig,
  InMemoryRecordingCatalogStore,
  normalizeRecordingCatalogEntry,
  PostgresRecordingCatalogStore,
  RecordingCatalogError,
} from '../dist/services/recordingCatalog.js';

const ROOM_ID = 'room-recordings';
const ROOM_NAME = 'Recording Room';

function catalogEntry(overrides = {}) {
  return {
    id: 'session-1',
    roomName: ROOM_NAME,
    createdAt: '2026-07-02T10:00:00.000Z',
    durationSeconds: 1850.4,
    trackCount: 4,
    totalBytes: 12_345_678,
    markerCount: 3,
    cloud: {
      provider: 'google-drive',
      fileCount: 4,
      totalBytes: 13_000_000,
      uploadedAt: '2026-07-02T10:30:00.000Z',
      expiresAt: null,
      permanent: true,
    },
    mediaExport: {
      status: 'ready',
      uploadId: 'upload-1',
      exportId: 'export-1',
      updatedAt: '2026-07-02T10:40:00.000Z',
      readyMp4: true,
      mp4ShareUrl: 'https://cdn.example.com/recordings/session-1.mp4',
      artifactCount: 2,
      readyArtifactCount: 2,
    },
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
          .sort((a, b) => Date.parse(b.recording.createdAt) - Date.parse(a.recording.createdAt))
          .slice(0, params[1])
          .map((row) => ({ recording: row.recording })),
      };
    }

    if (normalizedSql.startsWith('INSERT')) {
      const [roomId, recordingId, roomName, recordingJson, createdAt, updatedAt] = params;
      this.rows.set(`${roomId}:${recordingId}`, {
        room_id: roomId,
        recording_id: recordingId,
        room_name: roomName,
        recording: JSON.parse(recordingJson),
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

describe('recording catalog configuration', () => {
  it('uses configured PostgreSQL URLs and can be disabled explicitly', () => {
    assert.equal(getPostgresRecordingCatalogConfig({}), null);
    assert.equal(
      getPostgresRecordingCatalogConfig({
        DATABASE_URL: 'postgres://example',
        RECORDING_CATALOG_PERSISTENCE_DISABLED: 'yes',
      }),
      null
    );
    assert.deepEqual(
      getPostgresRecordingCatalogConfig({
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

describe('recording catalog normalization', () => {
  it('normalizes bounded recording metadata and never requires raw files', () => {
    const now = new Date('2026-07-02T11:00:00.000Z');
    const normalized = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry({
      id: ' session\x00-1 ',
      trackCount: 9999,
      markerCount: 9999,
    }), now);

    assert.equal(normalized.id, 'session-1');
    assert.equal(normalized.roomId, ROOM_ID);
    assert.equal(normalized.updatedAt, now.toISOString());
    assert.equal(normalized.durationSeconds, 1850);
    assert.equal(normalized.trackCount, 500);
    assert.equal(normalized.markerCount, 5000);
    assert.equal(normalized.cloud?.provider, 'google-drive');
    assert.equal(normalized.mediaExport?.readyMp4, true);
    assert.equal(normalized.mediaExport?.mp4ShareUrl, 'https://cdn.example.com/recordings/session-1.mp4');
  });

  it('drops unsafe MP4 share URLs from catalog metadata', () => {
    const normalized = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry({
      mediaExport: {
        ...catalogEntry().mediaExport,
        mp4ShareUrl: 'javascript:alert(1)',
      },
    }));

    assert.equal(normalized.mediaExport?.readyMp4, true);
    assert.equal(normalized.mediaExport?.mp4ShareUrl, undefined);
  });

  it('rejects entries without stable identity and timestamps', () => {
    assert.throws(
      () => normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, { id: 'session-1' }),
      RecordingCatalogError
    );
  });
});

describe('InMemoryRecordingCatalogStore', () => {
  it('upserts, lists newest first, and deletes room recordings', async () => {
    const store = new InMemoryRecordingCatalogStore();
    const first = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry({ id: 'session-1' }));
    const second = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry({
      id: 'session-2',
      createdAt: '2026-07-02T11:00:00.000Z',
    }));

    await store.upsertRecording(first);
    await store.upsertRecording(second);

    const listed = await store.listRoomRecordings(ROOM_ID);
    assert.deepEqual(listed.map((entry) => entry.id), ['session-2', 'session-1']);

    await store.deleteRecording(ROOM_ID, 'session-2');
    assert.deepEqual((await store.listRoomRecordings(ROOM_ID)).map((entry) => entry.id), ['session-1']);
  });
});

describe('PostgresRecordingCatalogStore', () => {
  it('creates schema, upserts normalized entries, lists rows, and deletes entries', async () => {
    const fakeDb = new FakeDb();
    const store = new PostgresRecordingCatalogStore(fakeDb);
    const entry = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry());

    await store.init();
    await store.upsertRecording(entry);

    assert.ok(fakeDb.queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS studio_recording_catalog')));
    assert.ok(fakeDb.queries.some((query) => query.sql.includes('ON CONFLICT (room_id, recording_id) DO UPDATE')));

    const listed = await store.listRoomRecordings(ROOM_ID);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, entry.id);
    assert.equal(listed[0].mediaExport?.uploadId, 'upload-1');
    assert.equal(listed[0].mediaExport?.mp4ShareUrl, 'https://cdn.example.com/recordings/session-1.mp4');

    await store.deleteRecording(ROOM_ID, entry.id);
    assert.deepEqual(await store.listRoomRecordings(ROOM_ID), []);

    await store.close();
    assert.equal(fakeDb.closed, true);
  });
});

describe('recording catalog response', () => {
  it('sorts catalog rows newest first', () => {
    const older = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry({
      id: 'older',
      createdAt: '2026-07-02T09:00:00.000Z',
    }));
    const newer = normalizeRecordingCatalogEntry(ROOM_ID, ROOM_NAME, catalogEntry({
      id: 'newer',
      createdAt: '2026-07-02T12:00:00.000Z',
    }));

    const response = buildRecordingCatalogListResponse(ROOM_ID, [older, newer]);
    assert.deepEqual(response.recordings.map((entry) => entry.id), ['newer', 'older']);
  });
});
