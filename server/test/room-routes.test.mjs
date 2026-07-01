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
  });
});
