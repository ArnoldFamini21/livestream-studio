import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { roomRouter } from '../dist/routes/rooms.js';
import { authorizeStudioCreator, isStudioCreationGated } from '../dist/services/studioAccess.js';
import { authorizeAiRequest, getAiAccessPolicy } from '../dist/services/aiAccess.js';
import { buildStunOnlyIceConfigWithStatus } from '../dist/services/ice-config.js';
import { createRoom, getRooms, isRoomMemberCredential, setupSignalingServer } from '../dist/services/signaling.js';
import { normalizeRoomSessionSnapshot } from '../dist/services/roomPersistence.js';

const SECRET = 'owner-create-secret-0123456789';

function request(headers = {}) {
  return { headers, ip: '203.0.113.9', socket: {} };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => { server.off('error', reject); resolve(); });
  });
}

function waitForMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`Timed out waiting for ${type}`)); }, 1500);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

describe('owner-only studio creation', () => {
  it('stays open when neither STUDIO_OWNER_EMAILS nor STUDIO_CREATE_SECRET is set', async () => {
    assert.equal(isStudioCreationGated({}), false);
    assert.deepEqual(await authorizeStudioCreator(request(), { env: {} }), { ok: true, createdByOwner: false, via: 'open' });
  });

  it('accepts the access key with a timing-safe match and refuses a wrong or missing key', async () => {
    const env = { STUDIO_CREATE_SECRET: SECRET };
    assert.deepEqual(
      await authorizeStudioCreator(request({ 'x-studio-access-key': SECRET }), { env }),
      { ok: true, createdByOwner: true, via: 'access-key' }
    );
    const wrong = await authorizeStudioCreator(request({ 'x-studio-access-key': 'nope' }), { env });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.status, 403);
    assert.equal(wrong.code, 'STUDIO_ACCESS_REQUIRED');
    const missing = await authorizeStudioCreator(request(), { env, resolveAccountUser: async () => null });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 401);
  });

  it('accepts an owner account and refuses other signed-in accounts', async () => {
    const env = { STUDIO_OWNER_EMAILS: 'Owner@Example.com, second@example.com' };
    const owner = await authorizeStudioCreator(request(), { env, resolveAccountUser: async () => ({ id: 'u1', email: 'owner@example.com' }) });
    assert.deepEqual(owner, { ok: true, createdByOwner: true, via: 'account' });
    const stranger = await authorizeStudioCreator(request(), { env, resolveAccountUser: async () => ({ id: 'u2', email: 'x@example.com' }) });
    assert.equal(stranger.ok, false);
    assert.equal(stranger.status, 403);
  });

  it('keeps the owner flag through a room snapshot', () => {
    assert.equal(normalizeRoomSessionSnapshot({ createdByOwner: true }).createdByOwner, true);
    assert.equal(normalizeRoomSessionSnapshot({ createdByOwner: 'yes' }), undefined);
  });
});

describe('room creation routes with the owner gate configured', () => {
  let server;
  let baseUrl;
  const previous = process.env.STUDIO_CREATE_SECRET;

  before(async () => {
    process.env.STUDIO_CREATE_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use('/api/rooms', roomRouter);
    server = http.createServer(app);
    await listen(server);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (previous === undefined) delete process.env.STUDIO_CREATE_SECRET;
    else process.env.STUDIO_CREATE_SECRET = previous;
    await new Promise((resolve) => server.close(resolve));
  });

  for (const path of ['/api/rooms', '/api/rooms/schedule']) {
    it(`${path} needs the access key and marks the studio as the owner's`, async () => {
      const body = JSON.stringify({ name: `Gate ${path} ${Date.now()}`, hostName: 'Arnold' });
      const refused = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(refused.status, 401);
      assert.equal((await refused.json()).code, 'STUDIO_ACCESS_REQUIRED');

      const created = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Access-Key': SECRET },
        body,
      });
      assert.equal(created.status, 201);
      const room = await created.json();
      assert.equal(getRooms().get(room.id)?.createdByOwner, true);
    });
  }
});

describe('external chat keys and the owner gate', () => {
  const previous = process.env.STUDIO_CREATE_SECRET;
  afterEach(() => {
    if (previous === undefined) delete process.env.STUDIO_CREATE_SECRET;
    else process.env.STUDIO_CREATE_SECRET = previous;
  });

  it('refuses server chat keys for a studio the owner did not create once the gate is configured', async () => {
    process.env.STUDIO_CREATE_SECRET = SECRET;
    const wss = new WebSocketServer({ port: 0 });
    setupSignalingServer(wss);
    if (!wss.address()) await new Promise((resolve) => wss.once('listening', resolve));
    const { room, hostToken } = createRoom('Not the owner', 'Stranger', { creatorIp: `chat-gate-${Date.now()}` });
    const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
    try {
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const joined = waitForMessage(ws, 'room-joined');
      ws.send(JSON.stringify({ type: 'join-room', payload: { roomId: room.id, name: 'Stranger', role: 'host', hostToken } }));
      const joinedMessage = await joined;
      // The per-seat credential proves membership for TURN; a made-up one does not.
      assert.equal(isRoomMemberCredential(room.id, joinedMessage.payload.resumeToken), true);
      assert.equal(isRoomMemberCredential(room.id, 'x'.repeat(32)), false);
      assert.equal(isRoomMemberCredential('missing-room', joinedMessage.payload.resumeToken), false);
      // A seat still waiting in the green room gets no relays until admitted.
      const seat = getRooms().get(room.id).participants.get(joinedMessage.payload.participant.id);
      const admittedStatus = seat.participant.status;
      seat.participant.status = 'green-room';
      assert.equal(isRoomMemberCredential(room.id, joinedMessage.payload.resumeToken), false);
      seat.participant.status = admittedStatus;
      assert.equal(isRoomMemberCredential(room.id, joinedMessage.payload.resumeToken), true);

      const status = waitForMessage(ws, 'external-chat-status');
      ws.send(JSON.stringify({ type: 'external-chat-connect', payload: { platform: 'youtube', liveChatId: 'Cg0KC2FiY2RlZmdoaWpr' } }));
      const message = await status;
      assert.equal(message.payload.status, 'error');
      assert.match(message.payload.message, /owner/i);
    } finally {
      ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});

describe('AI routes default closed', () => {
  it('locks AI when an OpenAI key is set without an access policy', async () => {
    const result = await authorizeAiRequest(request(), { env: { OPENAI_API_KEY: 'sk-test' }, resolveAccountUser: async () => null });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, 'AI_NOT_ENTITLED');
  });

  it('lets studio owners use AI when no AI-specific allowlist is set', async () => {
    const env = { OPENAI_API_KEY: 'sk-test', STUDIO_OWNER_EMAILS: 'owner@example.com' };
    assert.equal(getAiAccessPolicy(env).mode, 'allowlist');
    assert.deepEqual(
      await authorizeAiRequest(request(), { env, resolveAccountUser: async () => ({ id: 'u1', email: 'owner@example.com' }) }),
      { ok: true, actorKey: 'account:u1' }
    );
    const other = await authorizeAiRequest(request(), { env, resolveAccountUser: async () => ({ id: 'u2', email: 'guest@example.com' }) });
    assert.equal(other.ok, false);
    assert.equal(other.status, 403);
  });

  it('allows anonymous use only when explicitly opted in', async () => {
    const env = { OPENAI_API_KEY: 'sk-test', OPENAI_ALLOW_ANONYMOUS: 'true' };
    assert.deepEqual(await authorizeAiRequest(request(), { env, resolveAccountUser: async () => null }), { ok: true, actorKey: 'ip:203.0.113.9' });
  });
});

describe('ICE configuration without studio membership', () => {
  it('hands out STUN servers only, never TURN credentials', () => {
    const config = buildStunOnlyIceConfigWithStatus({
      TURN_URLS: 'turn:turn.example.test:3478',
      TURN_USERNAME: 'user',
      TURN_CREDENTIAL: 'secret',
      ICE_TRANSPORT_POLICY: 'relay',
    });
    assert.ok(config.iceServers.length > 0);
    for (const server of config.iceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      assert.ok(urls.every((url) => url.startsWith('stun')), `unexpected ${urls}`);
      assert.equal(server.credential, undefined);
    }
    assert.equal(config.iceTransportPolicy, 'all');
    assert.equal(config.status.hasTurn, false);
    assert.equal(config.membershipRequiredForTurn, true);
    // The pre-join connection check can say a relay will be there, without seeing it.
    assert.equal(config.relayConfigured, true);
    assert.equal(JSON.stringify(config).includes('secret'), false);
    const stunOnly = buildStunOnlyIceConfigWithStatus({ ICE_SERVERS_JSON: JSON.stringify({ iceServers: [{ urls: 'stun:stun.example.test:3478' }] }) });
    assert.equal(stunOnly.relayConfigured, false);
  });
});
