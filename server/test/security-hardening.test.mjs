import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createRoom, setupSignalingServer, storeStageImage } from '../dist/services/signaling.js';
import { PRESENTATION_RENDER_TOKEN_TTL_MS } from '../dist/services/presentationRenderToken.js';

let wss;
let port;

before(async () => {
  wss = new WebSocketServer({ port: 0 });
  setupSignalingServer(wss);
  if (!wss.address()) await new Promise((resolve) => wss.once('listening', resolve));
  port = wss.address().port;
});

after(async () => {
  await new Promise((resolve) => wss.close(resolve));
});

function waitForMessage(ws, type, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
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

async function joinAsHost(name) {
  const { room, hostToken } = createRoom(name, 'Arnold', { creatorIp: `security-${name}-${Date.now()}` });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const joined = waitForMessage(ws, 'room-joined');
  ws.send(JSON.stringify({ type: 'join-room', payload: { roomId: room.id, name: 'Arnold', role: 'host', hostToken } }));
  const message = await joined;
  return { ws, room, participantId: message.payload.participant.id, stageUploadToken: message.payload.stageUploadToken };
}

function decodeClaims(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

describe('presentation render tokens', () => {
  it('issues a short-lived presentation-render token to an admitted host', async () => {
    const { ws, room, participantId } = await joinAsHost('Deck room');
    try {
      const issued = waitForMessage(ws, 'live-stream-token-issued');
      ws.send(JSON.stringify({ type: 'live-stream-token-request', payload: { requestId: 'deck-1', purpose: 'presentation-render' } }));
      const message = await issued;
      assert.equal(message.payload.requestId, 'deck-1');
      const claims = decodeClaims(message.payload.token);
      assert.equal(claims.purpose, 'presentation-render');
      assert.equal(claims.roomId, room.id);
      assert.equal(claims.participantId, participantId);
      assert.equal(claims.role, 'host');
      assert.ok(claims.exp - claims.iat <= PRESENTATION_RENDER_TOKEN_TTL_MS);

      // Without a purpose the same request still issues a relay token.
      const live = waitForMessage(ws, 'live-stream-token-issued');
      ws.send(JSON.stringify({ type: 'live-stream-token-request', payload: { requestId: 'live-1' } }));
      assert.equal(decodeClaims((await live).payload.token).purpose, undefined);
    } finally {
      ws.terminate();
    }
  });
});

describe('stage image memory budget', () => {
  const previous = process.env.STAGE_IMAGE_GLOBAL_MAX_MB;
  after(() => {
    if (previous === undefined) delete process.env.STAGE_IMAGE_GLOBAL_MAX_MB;
    else process.env.STAGE_IMAGE_GLOBAL_MAX_MB = previous;
  });

  it('shares one byte budget across studios and evicts a studio’s own old pictures first', async () => {
    process.env.STAGE_IMAGE_GLOBAL_MAX_MB = '1';
    const first = await joinAsHost('Budget A');
    const second = await joinAsHost('Budget B');
    try {
      const picture = (size) => Buffer.alloc(size, 0xff);
      const store = (studio, size) => storeStageImage({
        roomId: studio.room.id,
        participantId: studio.participantId,
        token: studio.stageUploadToken,
        contentType: 'image/jpeg',
        data: picture(size),
      });
      assert.equal(store(first, 900 * 1024).ok, true);
      const refused = store(second, 200 * 1024);
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 507);
      // Studio A replacing its own picture stays within the budget.
      assert.equal(store(first, 900 * 1024).ok, true);
      assert.equal(store(second, 100 * 1024).ok, true);
    } finally {
      first.ws.terminate();
      second.ws.terminate();
    }
  });
});
