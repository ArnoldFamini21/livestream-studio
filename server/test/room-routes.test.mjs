import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { roomRouter } from '../dist/routes/rooms.js';

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

describe('room routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '16kb' }));
    app.use('/api/rooms', roomRouter);
    server = http.createServer(app);
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await close(server);
  });

  it('returns private host access when a studio is created', async () => {
    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Contract room ${Date.now()}`,
        hostName: 'Arnold',
      }),
    });

    const room = await response.json();

    assert.equal(response.status, 201);
    assert.equal(typeof room.id, 'string');
    assert.equal(room.name.startsWith('Contract room'), true);
    assert.equal(room.hostName, 'Arnold');
    assert.match(room.hostToken, /^[A-Za-z0-9_-]{16,256}$/);
    assert.equal(room.hostId, undefined);
    assert.equal(room.coHostIds, undefined);
    assert.equal(room.settings.passwordProtected, false);
    assert.equal(room.registration.enabled, false);
  });

  it('captures and exports webinar-style room registrants for hosts', async () => {
    const createResponse = await fetch(`${baseUrl}/api/rooms/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Registration room ${Date.now()}`,
        hostName: 'Arnold',
        scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
        registrationEnabled: true,
      }),
    });
    const room = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(room.registration.enabled, true);
    assert.deepEqual(room.registration.fields, ['name', 'email']);

    const registerResponse = await fetch(`${baseUrl}/api/rooms/${room.id}/registrants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '  Jane Viewer  ',
        email: ' Jane@example.COM ',
      }),
    });
    const registration = await registerResponse.json();

    assert.equal(registerResponse.status, 201);
    assert.equal(registration.total, 1);
    assert.equal(registration.registrant.name, 'Jane Viewer');
    assert.equal(registration.registrant.email, 'jane@example.com');

    const duplicateResponse = await fetch(`${baseUrl}/api/rooms/${room.id}/registrants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jane Updated',
        email: 'jane@example.com',
      }),
    });
    const duplicate = await duplicateResponse.json();

    assert.equal(duplicateResponse.status, 201);
    assert.equal(duplicate.total, 1);
    assert.equal(duplicate.registrant.id, registration.registrant.id);
    assert.equal(duplicate.registrant.name, 'Jane Updated');

    const rejectedExport = await fetch(`${baseUrl}/api/rooms/${room.id}/registrants`);
    assert.equal(rejectedExport.status, 403);

    const exportResponse = await fetch(`${baseUrl}/api/rooms/${room.id}/registrants`, {
      headers: { 'x-host-token': room.hostToken },
    });
    const exported = await exportResponse.json();

    assert.equal(exportResponse.status, 200);
    assert.equal(exported.roomId, room.id);
    assert.equal(exported.registrants.length, 1);
    assert.equal(exported.registrants[0].email, 'jane@example.com');
  });

  it('rejects guest registration when registration is off or invalid', async () => {
    const createResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Closed registration ${Date.now()}`,
        hostName: 'Arnold',
      }),
    });
    const room = await createResponse.json();

    const disabledResponse = await fetch(`${baseUrl}/api/rooms/${room.id}/registrants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Guest', email: 'guest@example.com' }),
    });
    assert.equal(disabledResponse.status, 409);

    const registrationRoomResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Invalid registration ${Date.now()}`,
        hostName: 'Arnold',
        registrationEnabled: true,
      }),
    });
    const registrationRoom = await registrationRoomResponse.json();
    const invalidResponse = await fetch(`${baseUrl}/api/rooms/${registrationRoom.id}/registrants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Guest', email: 'not an email' }),
    });
    const invalid = await invalidResponse.json();

    assert.equal(invalidResponse.status, 400);
    assert.equal(invalid.code, 'REGISTRANT_EMAIL_INVALID');
  });
});
