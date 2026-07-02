import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { roomRouter } from '../dist/routes/rooms.js';
import {
  brandKitRouter,
  configureBrandKitCatalogStore,
} from '../dist/routes/brandKits.js';
import { InMemoryBrandKitCatalogStore } from '../dist/services/brandKitCatalog.js';

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
      name: `Brand kit catalog ${Date.now()}`,
      hostName: 'Arnold',
    }),
  });
  const room = await response.json();
  assert.equal(response.status, 201);
  return room;
}

function catalogBody(overrides = {}) {
  return {
    id: 'kit-1',
    name: 'Launch Brand',
    createdAt: '2026-07-02T10:00:00.000Z',
    studioTheme: 'dark',
    brandColor: '#a78bfa',
    stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #111827, #7c3aed)' },
    logoUrl: 'https://cdn.example.com/logo.png',
    logoPlacement: 'top-right',
    logoPosition: null,
    logoSize: 'medium',
    logoOpacity: 0.8,
    cameraShape: 'rounded',
    nameTagStyle: 'block',
    ...overrides,
  };
}

describe('brand kit catalog routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/rooms', roomRouter);
    app.use('/api/brand-kits', brandKitRouter);
    server = http.createServer(app);
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    configureBrandKitCatalogStore(new InMemoryBrandKitCatalogStore());
  });

  after(async () => {
    configureBrandKitCatalogStore(null);
    if (server) await close(server);
  });

  it('requires host access for brand kit catalog reads and writes', async () => {
    const room = await createRoom(baseUrl);

    const rejectedList = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog`);
    assert.equal(rejectedList.status, 403);

    const rejectedSave = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(catalogBody()),
    });
    assert.equal(rejectedSave.status, 403);
  });

  it('saves, lists, and deletes host brand kit catalog entries', async () => {
    const room = await createRoom(baseUrl);

    const saveResponse = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': room.hostToken,
      },
      body: JSON.stringify(catalogBody({ name: 'Cloud Brand' })),
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 201);
    assert.equal(saved.id, 'kit-1');
    assert.equal(saved.roomId, room.id);
    assert.equal(saved.name, 'Cloud Brand');
    assert.equal(saved.logoUrl, 'https://cdn.example.com/logo.png');

    const listResponse = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const listed = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.equal(listed.roomId, room.id);
    assert.equal(listed.brandKits.length, 1);
    assert.equal(listed.brandKits[0].id, 'kit-1');
    assert.equal(listed.brandKits[0].name, 'Cloud Brand');

    const deleteResponse = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog/kit-1`, {
      method: 'DELETE',
      headers: { 'x-host-token': room.hostToken },
    });
    assert.equal(deleteResponse.status, 204);

    const emptyResponse = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const empty = await emptyResponse.json();
    assert.deepEqual(empty.brandKits, []);
  });

  it('rejects invalid catalog entries before they are persisted', async () => {
    const room = await createRoom(baseUrl);

    const response = await fetch(`${baseUrl}/api/brand-kits/rooms/${room.id}/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-token': room.hostToken,
      },
      body: JSON.stringify({ id: 'kit-without-created-at' }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'BRAND_KIT_CATALOG_INVALID');
  });
});
