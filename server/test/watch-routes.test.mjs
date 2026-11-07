import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { roomRouter } from '../dist/routes/rooms.js';
import { watchRouter } from '../dist/routes/watch.js';
import { createRoom, getRooms } from '../dist/services/signaling.js';

describe('public watch page routes', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json({ limit: '16kb' }));
    app.use('/api/rooms', roomRouter);
    app.use('/api/watch', watchRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('finds a studio by its private watch id, never by the room id, and lists no participants', async () => {
    const { room } = createRoom('Sunday service', 'Arnold', { creatorIp: `watch-${Date.now()}`, registrationEnabled: true });
    const { watchId } = getRooms().get(room.id);

    const byWatchId = await fetch(`${baseUrl}/api/watch/${watchId}`);
    assert.equal(byWatchId.status, 200);
    const info = await byWatchId.json();
    assert.equal(info.name, 'Sunday service');
    assert.equal(info.id, watchId);
    assert.equal(info.participants, undefined);
    assert.equal(JSON.stringify(info).includes(room.id), false, 'the watch page never learns the room id');

    assert.equal((await fetch(`${baseUrl}/api/watch/${room.id}`)).status, 404);

    const registered = await fetch(`${baseUrl}/api/watch/${watchId}/registrants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Viewer', email: 'viewer@example.com' }),
    });
    assert.equal(registered.status, 201);
    const registration = await registered.json();
    assert.equal(registration.total, 1);
    assert.equal(JSON.stringify(registration).includes(room.id), false);

    const roomInfo = await (await fetch(`${baseUrl}/api/rooms/${room.id}`)).json();
    assert.equal(roomInfo.participants, undefined, 'who is in the studio is not public');
    assert.equal(typeof roomInfo.participantCount, 'number');
  });
});
