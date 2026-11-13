import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  BRANDING_INLINE_IMAGE_TOO_LARGE_CODE,
  LOGO_IMAGE_MAX_BYTES,
  MAX_INLINE_BRANDING_DATA_URL_LENGTH,
} from '@studio/shared';
import { createRoom, readStageImage, setupSignalingServer, storeStageImage } from '../dist/services/signaling.js';

async function createHarness() {
  const wss = new WebSocketServer({ port: 0 });
  setupSignalingServer(wss);
  let address = wss.address();
  if (!address) {
    await new Promise((resolve) => wss.once('listening', resolve));
    address = wss.address();
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function waitFor(ws, type, predicate = () => true, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

function join(ws, payload) {
  ws.send(JSON.stringify({ type: 'join-room', payload }));
}

const branding = (extra) => ({
  type: 'studio-branding-updated',
  payload: {
    brandColor: '#a78bfa',
    logoUrl: null,
    stageBackground: { type: 'none', value: '' },
    waitingRoom: { headline: 'Lobby', message: 'Soon', backgroundMode: 'studio', showLogo: true },
    ...extra,
  },
});

const png = (bytes) => Buffer.alloc(bytes, 5);

async function setup(name) {
  const harness = await createHarness();
  const { room, hostToken } = createRoom(name, 'Arnold', { creatorIp: `${name}-${Date.now()}` });
  const host = await connect(harness.url);
  const hostJoined = waitFor(host, 'room-joined');
  join(host, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
  const hostSession = await hostJoined;
  // The default studio holds guests in the green room.
  const guest = await connect(harness.url);
  const guestJoined = waitFor(guest, 'room-joined');
  join(guest, { roomId: room.id, name: 'Waiting Guest', role: 'guest' });
  const guestSession = await guestJoined;
  return {
    harness,
    room,
    host,
    guest,
    hostId: hostSession.payload.participant.id,
    uploadToken: hostSession.payload.stageUploadToken,
    guestSession,
  };
}

describe('studio logo sharing', () => {
  it('relays a logo image id and lets everyone, the green room included, read the logo and nothing else', async () => {
    const s = await setup('logo-share');
    try {
      assert.equal(s.guestSession.payload.participant.status, 'green-room');
      assert.equal(s.guestSession.payload.stageReadToken, undefined, 'the green room has no stage read token');
      const readToken = s.guestSession.payload.brandingReadToken;
      assert.equal(typeof readToken, 'string');

      const logo = storeStageImage({ roomId: s.room.id, participantId: s.hostId, token: s.uploadToken, contentType: 'image/png', data: png(300 * 1024), kind: 'logo' });
      assert.equal(logo.ok, true);
      const slide = storeStageImage({ roomId: s.room.id, participantId: s.hostId, token: s.uploadToken, contentType: 'image/png', data: png(2048) });
      assert.equal(slide.ok, true);

      const relayed = waitFor(s.guest, 'studio-branding-updated', (m) => m.payload.logoImageId === logo.imageId);
      s.host.send(JSON.stringify(branding({ logoImageId: logo.imageId })));
      const update = await relayed;
      assert.equal(update.payload.logoUrl, null);
      assert.equal(s.host.readyState, WebSocket.OPEN);

      assert.deepEqual(readStageImage(s.room.id, logo.imageId, readToken).image.data, png(300 * 1024));
      assert.equal(readStageImage(s.room.id, logo.imageId, '').status, 403);
      assert.equal(readStageImage(s.room.id, logo.imageId, 'not-a-real-token').status, 403);
      // The green room never gains slides or other stage pictures through the logo token.
      assert.equal(readStageImage(s.room.id, slide.imageId, readToken).ok, false);
      assert.equal(readStageImage(s.room.id, slide.imageId, readToken).status, 403);

      // Late joiners get the id in room-joined.
      const late = await connect(s.harness.url);
      const lateJoined = waitFor(late, 'room-joined');
      join(late, { roomId: s.room.id, name: 'Late Guest', role: 'guest' });
      assert.equal((await lateJoined).payload.studioBranding.logoImageId, logo.imageId);
    } finally {
      await s.harness.close();
    }
  });

  it('drops a logo id that is not a logo, and refuses logos above the logo cap', async () => {
    const s = await setup('logo-ids');
    try {
      const slide = storeStageImage({ roomId: s.room.id, participantId: s.hostId, token: s.uploadToken, contentType: 'image/png', data: png(2048) });
      const tooBig = storeStageImage({ roomId: s.room.id, participantId: s.hostId, token: s.uploadToken, contentType: 'image/png', data: png(LOGO_IMAGE_MAX_BYTES + 1), kind: 'logo' });
      assert.equal(tooBig.ok, false);
      assert.equal(tooBig.status, 413);

      for (const id of [slide.imageId, 'never-uploaded']) {
        const got = waitFor(s.guest, 'studio-branding-updated', (m) => m.payload.brandColor === '#0f0f0f');
        s.host.send(JSON.stringify(branding({ brandColor: '#0f0f0f', logoImageId: id })));
        const payload = (await got).payload;
        assert.equal(payload.logoImageId, undefined);
        assert.equal(payload.logoUrl, null);
      }
    } finally {
      await s.harness.close();
    }
  });

  it('answers inline picture data above the cap with an error, keeps the socket open and never stores it', async () => {
    const s = await setup('logo-inline');
    try {
      const tiny = `data:image/png;base64,${'A'.repeat(1000)}`;
      const tinyRelayed = waitFor(s.guest, 'studio-branding-updated', (m) => m.payload.logoUrl === tiny);
      s.host.send(JSON.stringify(branding({ logoUrl: tiny })));
      await tinyRelayed;

      const huge = `data:image/png;base64,${'A'.repeat(MAX_INLINE_BRANDING_DATA_URL_LENGTH + 1)}`;
      const error = waitFor(s.host, 'error', (m) => m.payload.code === BRANDING_INLINE_IMAGE_TOO_LARGE_CODE);
      const relayed = waitFor(s.guest, 'studio-branding-updated', (m) => m.payload.brandColor === '#123456');
      s.host.send(JSON.stringify(branding({ brandColor: '#123456', logoUrl: huge })));
      await error;
      const payload = (await relayed).payload;
      assert.ok(!JSON.stringify(payload).includes('AAAAAAAAAA'.repeat(500)), 'no inline data is relayed');
      assert.equal(payload.logoUrl, tiny, 'the logo already shared stays');
      assert.equal(s.host.readyState, WebSocket.OPEN);

      // A background picture inline above the cap gets the same answer.
      const bgError = waitFor(s.host, 'error', (m) => m.payload.code === BRANDING_INLINE_IMAGE_TOO_LARGE_CODE);
      s.host.send(JSON.stringify(branding({ stageBackground: { type: 'image', value: huge } })));
      await bgError;
      assert.equal(s.host.readyState, WebSocket.OPEN);

      // A late joiner never receives inline data above the cap.
      const late = await connect(s.harness.url);
      const lateJoined = waitFor(late, 'room-joined');
      join(late, { roomId: s.room.id, name: 'Late Guest', role: 'guest' });
      const stored = (await lateJoined).payload.studioBranding;
      assert.ok(JSON.stringify(stored).length < MAX_INLINE_BRANDING_DATA_URL_LENGTH + 2000);
      assert.notEqual(stored.stageBackground.value, huge);
    } finally {
      await s.harness.close();
    }
  });
});
