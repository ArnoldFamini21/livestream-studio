import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { roomRouter } from '../dist/routes/rooms.js';
import {
  configureRecordingCatalogStore,
  recordingRouter,
} from '../dist/routes/recordings.js';
import { InMemoryRecordingCatalogStore } from '../dist/services/recordingCatalog.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function createRoom(baseUrl) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Recording catalog ${Date.now()}`,
      hostName: 'Arnold',
    }),
  });
  const room = await response.json();
  assert.equal(response.status, 201);
  return room;
}

function catalogBody(overrides = {}) {
  return {
    id: 'session-1',
    roomName: 'Browser Room',
    createdAt: '2026-07-02T10:00:00.000Z',
    durationSeconds: 300,
    trackCount: 2,
    totalBytes: 2_000_000,
    markerCount: 1,
    mediaExport: {
      status: 'ready',
      uploadId: 'upload-1',
      exportId: 'export-1',
      updatedAt: '2026-07-02T10:05:00.000Z',
      readyMp4: true,
      artifactCount: 1,
      readyArtifactCount: 1,
    },
    ...overrides,
  };
}

describe('recording catalog routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '16kb' }));
    app.use('/api/rooms', roomRouter);
    app.use('/api/recordings', recordingRouter);
    server = http.createServer(app);
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    configureRecordingCatalogStore(new InMemoryRecordingCatalogStore());
  });

  after(async () => {
    configureRecordingCatalogStore(null);
    if (server) await close(server);
  });

  it('requires host access for recording catalog reads and writes', async () => {
    const room = await createRoom(baseUrl);

    const rejectedList = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog`);
    assert.equal(rejectedList.status, 403);

    const rejectedSave = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catalogBody()),
    });
    assert.equal(rejectedSave.status, 403);
  });

  it('saves, lists, and deletes host recording catalog entries', async () => {
    const room = await createRoom(baseUrl);

    const saveResponse = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': room.hostToken,
      },
      body: JSON.stringify(catalogBody({ roomName: 'Client override' })),
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 201);
    assert.equal(saved.id, 'session-1');
    assert.equal(saved.roomId, room.id);
    assert.equal(saved.roomName, 'Client override');
    assert.equal(saved.mediaExport.readyMp4, true);

    const listResponse = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const listed = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listed.roomId, room.id);
    assert.equal(listed.recordings.length, 1);
    assert.equal(listed.recordings[0].id, 'session-1');

    const deleteResponse = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog/session-1`, {
      method: 'DELETE',
      headers: { 'x-host-token': room.hostToken },
    });
    assert.equal(deleteResponse.status, 204);

    const emptyResponse = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.recordings, []);
  });

  it('rejects invalid catalog entries before they are persisted', async () => {
    const room = await createRoom(baseUrl);

    const response = await fetch(`${baseUrl}/api/recordings/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': room.hostToken,
      },
      body: JSON.stringify({ id: 'session-without-created-at' }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'RECORDING_CATALOG_INVALID');
  });
});
