import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { authRouter, configureAccountAuthStore } from '../dist/routes/auth.js';
import { roomRouter } from '../dist/routes/rooms.js';
import {
  configureWorkspaceStudioCatalogStore,
  workspaceStudioRouter,
} from '../dist/routes/workspaceStudios.js';
import { InMemoryAccountAuthStore } from '../dist/services/accountAuth.js';
import { InMemoryWorkspaceStudioCatalogStore } from '../dist/services/workspaceStudioCatalog.js';

let testRequestCounter = 0;

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

async function createRoom(baseUrl, name = `Workspace studio catalog ${Date.now()}`) {
  testRequestCounter += 1;
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': `203.0.113.${testRequestCounter}`,
    },
    body: JSON.stringify({
      name,
      hostName: 'Arnold',
      registrationEnabled: true,
    }),
  });
  const room = await response.json();
  assert.equal(response.status, 201);
  return room;
}

async function registerAccount(baseUrl) {
  testRequestCounter += 1;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `host-${Date.now()}-${testRequestCounter}@example.com`,
      name: 'Arnold',
      password: 'CorrectPassword123',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  return body.session.token;
}

function studioBody(room, overrides = {}) {
  return {
    id: room.id,
    name: room.name,
    hostName: room.hostName || 'Arnold',
    hostToken: room.hostToken,
    createdAt: room.createdAt,
    scheduledFor: room.scheduledFor,
    passwordProtected: Boolean(room.settings?.passwordProtected),
    registrationEnabled: Boolean(room.registration?.enabled),
    status: room.status,
    ...overrides,
  };
}

describe('workspace studio catalog routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/rooms', roomRouter);
    app.use('/api/workspace-studios', workspaceStudioRouter);
    server = http.createServer(app);
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    configureAccountAuthStore(new InMemoryAccountAuthStore());
    configureWorkspaceStudioCatalogStore(new InMemoryWorkspaceStudioCatalogStore());
  });

  after(async () => {
    configureAccountAuthStore(null);
    configureWorkspaceStudioCatalogStore(null);
    if (server) await close(server);
  });

  it('requires host access for workspace studio catalog reads and writes', async () => {
    const room = await createRoom(baseUrl);

    const rejectedList = await fetch(`${baseUrl}/api/workspace-studios/rooms/${room.id}/catalog`);
    assert.equal(rejectedList.status, 403);

    const rejectedSave = await fetch(`${baseUrl}/api/workspace-studios/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(studioBody(room)),
    });
    assert.equal(rejectedSave.status, 403);
  });

  it('saves, lists, and deletes host workspace studio entries', async () => {
    const catalogRoom = await createRoom(baseUrl, 'Catalog Room');
    const savedRoom = await createRoom(baseUrl, 'Saved Room');

    const saveResponse = await fetch(`${baseUrl}/api/workspace-studios/rooms/${catalogRoom.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': catalogRoom.hostToken,
      },
      body: JSON.stringify(studioBody(savedRoom, { name: 'Client Name Should Be Replaced' })),
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 201);
    assert.equal(saved.id, savedRoom.id);
    assert.equal(saved.name, savedRoom.name);
    assert.equal(saved.hostToken, savedRoom.hostToken);
    assert.equal(saved.registrationEnabled, true);

    const listResponse = await fetch(`${baseUrl}/api/workspace-studios/rooms/${catalogRoom.id}/catalog`, {
      headers: { 'x-host-token': catalogRoom.hostToken },
    });
    const listed = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listed.roomId, catalogRoom.id);
    assert.equal(listed.studios.length, 1);
    assert.equal(listed.studios[0].id, savedRoom.id);

    const deleteResponse = await fetch(`${baseUrl}/api/workspace-studios/rooms/${catalogRoom.id}/catalog/${savedRoom.id}`, {
      method: 'DELETE',
      headers: { 'x-host-token': catalogRoom.hostToken },
    });
    assert.equal(deleteResponse.status, 204);

    const emptyResponse = await fetch(`${baseUrl}/api/workspace-studios/rooms/${catalogRoom.id}/catalog`, {
      headers: { 'x-host-token': catalogRoom.hostToken },
    });
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.studios, []);
  });

  it('rejects a saved studio when that studio host token is not valid', async () => {
    const catalogRoom = await createRoom(baseUrl, 'Catalog Room');
    const savedRoom = await createRoom(baseUrl, 'Saved Room');

    const response = await fetch(`${baseUrl}/api/workspace-studios/rooms/${catalogRoom.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': catalogRoom.hostToken,
      },
      body: JSON.stringify(studioBody(savedRoom, { hostToken: 'WrongHostToken_1234567890' })),
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.code, 'HOST_TOKEN_INVALID');
  });

  it('saves, lists, and deletes signed-in account workspace studio entries', async () => {
    const token = await registerAccount(baseUrl);
    const savedRoom = await createRoom(baseUrl, 'Account Saved Room');

    const rejectedList = await fetch(`${baseUrl}/api/workspace-studios/account/catalog`);
    assert.equal(rejectedList.status, 401);

    const saveResponse = await fetch(`${baseUrl}/api/workspace-studios/account/catalog`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(studioBody(savedRoom, { name: 'Client Name Should Be Replaced' })),
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 201);
    assert.equal(saved.id, savedRoom.id);
    assert.equal(saved.name, savedRoom.name);
    assert.equal(saved.hostToken, savedRoom.hostToken);

    const listResponse = await fetch(`${baseUrl}/api/workspace-studios/account/catalog`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listed = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.match(listed.roomId, /^account:/);
    assert.equal(listed.studios.length, 1);
    assert.equal(listed.studios[0].id, savedRoom.id);

    const deleteResponse = await fetch(`${baseUrl}/api/workspace-studios/account/catalog/${savedRoom.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(deleteResponse.status, 204);

    const emptyResponse = await fetch(`${baseUrl}/api/workspace-studios/account/catalog`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.studios, []);
  });

  it('rejects account catalog saves without valid target studio host access', async () => {
    const token = await registerAccount(baseUrl);
    const savedRoom = await createRoom(baseUrl, 'Account Saved Room');

    const response = await fetch(`${baseUrl}/api/workspace-studios/account/catalog`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(studioBody(savedRoom, { hostToken: 'WrongHostToken_1234567890' })),
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.code, 'HOST_TOKEN_INVALID');
  });
});
