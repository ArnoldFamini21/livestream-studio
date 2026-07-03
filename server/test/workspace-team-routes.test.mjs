import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { roomRouter } from '../dist/routes/rooms.js';
import {
  configureWorkspaceTeamCatalogStore,
  workspaceTeamRouter,
} from '../dist/routes/workspaceTeam.js';
import { InMemoryWorkspaceTeamCatalogStore } from '../dist/services/workspaceTeamCatalog.js';

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
      name: `Workspace team catalog ${Date.now()}`,
      hostName: 'Arnold',
    }),
  });
  const room = await response.json();
  assert.equal(response.status, 201);
  return room;
}

function memberBody(overrides = {}) {
  return {
    id: 'member-1',
    name: 'Producer',
    email: 'producer@example.com',
    role: 'producer',
    createdAt: '2026-07-02T10:00:00.000Z',
    ...overrides,
  };
}

describe('workspace team catalog routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/rooms', roomRouter);
    app.use('/api/workspace-team', workspaceTeamRouter);
    server = http.createServer(app);
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    configureWorkspaceTeamCatalogStore(new InMemoryWorkspaceTeamCatalogStore());
  });

  after(async () => {
    configureWorkspaceTeamCatalogStore(null);
    if (server) await close(server);
  });

  it('requires host access for workspace team catalog reads and writes', async () => {
    const room = await createRoom(baseUrl);

    const rejectedList = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog`);
    assert.equal(rejectedList.status, 403);

    const rejectedSave = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memberBody()),
    });
    assert.equal(rejectedSave.status, 403);
  });

  it('saves, lists, and deletes host workspace team members', async () => {
    const room = await createRoom(baseUrl);

    const saveResponse = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': room.hostToken,
      },
      body: JSON.stringify(memberBody({ name: 'Cloud Producer' })),
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 201);
    assert.equal(saved.id, 'member-1');
    assert.equal(saved.roomId, room.id);
    assert.equal(saved.name, 'Cloud Producer');
    assert.equal(saved.email, 'producer@example.com');

    const listResponse = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const listed = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listed.roomId, room.id);
    assert.equal(listed.members.length, 1);
    assert.equal(listed.members[0].id, 'member-1');
    assert.equal(listed.members[0].name, 'Cloud Producer');

    const deleteResponse = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog/member-1`, {
      method: 'DELETE',
      headers: { 'x-host-token': room.hostToken },
    });
    assert.equal(deleteResponse.status, 204);

    const emptyResponse = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.members, []);
  });

  it('rejects invalid team catalog members before they are persisted', async () => {
    const room = await createRoom(baseUrl);

    const response = await fetch(`${baseUrl}/api/workspace-team/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': room.hostToken,
      },
      body: JSON.stringify({ id: 'member-without-created-at' }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'WORKSPACE_TEAM_CATALOG_INVALID');
  });
});
