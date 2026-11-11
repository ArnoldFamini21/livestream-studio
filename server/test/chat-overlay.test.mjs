import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import { CHAT_OVERLAY_RATE_LIMIT_MAX } from '@studio/shared';

process.env.SIGNALING_RESUME_GRACE_MS = '300';

const {
  createRoom,
  getRooms,
  setupSignalingServer,
} = await import('../dist/services/signaling.js');

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

function waitFor(ws, type, predicate = () => true, timeoutMs = 2000) {
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

function expectNone(ws, type, predicate = () => true, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, timeoutMs);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(new Error(`Unexpected ${type}: ${JSON.stringify(message.payload).slice(0, 200)}`));
    }
    ws.on('message', onMessage);
  });
}

function sendMessage(ws, type, payload) {
  ws.send(JSON.stringify({ type, payload }));
}

async function join(url, payload) {
  const ws = await connect(url);
  const joined = waitFor(ws, 'room-joined');
  sendMessage(ws, 'join-room', payload);
  return { ws, joined: await joined, id: (await joined).payload.participant.id };
}

function makeRoom(label) {
  const created = createRoom(`${label} test`, 'Arnold', { creatorIp: `${label}-${Date.now()}-${Math.random()}` });
  const state = getRooms().get(created.room.id);
  state.room.settings.greenRoomEnabled = false;
  return { ...created, state };
}

async function studioWithCoHost(harness, label) {
  const { room, hostToken, state } = makeRoom(label);
  const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
  const guest = await join(harness.url, { roomId: room.id, name: 'Maria', role: 'guest', joinSessionId: `${label}-guest` });
  const coHost = await join(harness.url, { roomId: room.id, name: 'Producer', role: 'guest', joinSessionId: `${label}-producer` });
  const promoted = waitFor(coHost.ws, 'participant-updated', (m) => m.payload.id === coHost.id && m.payload.role === 'co-host');
  sendMessage(host.ws, 'stage-action', { action: 'promote-co-host', targetParticipantId: coHost.id, performedBy: 'x' });
  await promoted;
  return { room, state, host, guest, coHost };
}


describe('chat-overlay-update', () => {
  it('stores a validated patch and sends the full state to admitted operators only', async () => {
    const harness = await createHarness();
    try {
      const { room, host, guest, coHost } = await studioWithCoHost(harness, 'chat-overlay');
      const hostSees = waitFor(host.ws, 'chat-overlay-updated');
      const coHostSees = waitFor(coHost.ws, 'chat-overlay-updated');
      const guestNothing = expectNone(guest.ws, 'chat-overlay-updated');
      sendMessage(host.ws, 'chat-overlay-update', { patch: { enabled: true, size: 'l', layout: 'wide', hide: ['m1'], evil: 'x', size2: 1 } });
      const [atHost, atCoHost] = await Promise.all([hostSees, coHostSees, guestNothing]);
      assert.equal(atHost.payload.enabled, true);
      assert.equal(atHost.payload.size, 'l');
      assert.equal(atHost.payload.layout, 'wide');
      assert.deepEqual(atHost.payload.hiddenIds, ['m1']);
      assert.equal(atHost.payload.evil, undefined);
      assert.deepEqual(atCoHost.payload, atHost.payload);

      // A second operator's patch merges instead of replacing.
      const merged = waitFor(host.ws, 'chat-overlay-updated', (m) => m.payload.hiddenIds.length === 2);
      sendMessage(coHost.ws, 'chat-overlay-update', { patch: { hide: ['m2'], show: ['m3'] } });
      const state = (await merged).payload;
      assert.deepEqual(state.hiddenIds, ['m1', 'm2']);
      assert.deepEqual(state.shownIds, ['m3']);
      assert.equal(state.size, 'l');
      assert.equal(getRooms().get(room.id).chatOverlay.size, 'l');
    } finally {
      await harness.close();
    }
  });

  it('refuses guests and invalid payloads, and never changes the state for them', async () => {
    const harness = await createHarness();
    try {
      const { room, host, guest } = await studioWithCoHost(harness, 'chat-overlay-guard');
      const refused = waitFor(guest.ws, 'error', (m) => m.payload.code === 'UNAUTHORIZED');
      const hostQuiet = expectNone(host.ws, 'chat-overlay-updated');
      sendMessage(guest.ws, 'chat-overlay-update', { patch: { enabled: true } });
      await Promise.all([refused, hostQuiet]);
      assert.equal(getRooms().get(room.id).chatOverlay, undefined);

      for (const payload of [{}, { patch: 5 }, { patch: [] }, { patch: { size: 'giant' } }]) {
        const invalid = waitFor(host.ws, 'error', (m) => m.payload.code === 'INVALID_PAYLOAD');
        sendMessage(host.ws, 'chat-overlay-update', payload);
        await invalid;
      }
      assert.equal(getRooms().get(room.id).chatOverlay, undefined);
    } finally {
      await harness.close();
    }
  });

  it('is rate-limited per connection', async () => {
    const harness = await createHarness();
    try {
      const { host } = await studioWithCoHost(harness, 'chat-overlay-rate');
      let delivered = 0;
      const count = (data) => { if (JSON.parse(data.toString()).type === 'chat-overlay-updated') delivered += 1; };
      host.ws.on('message', count);
      const limited = waitFor(host.ws, 'error', (m) => m.payload.code === 'RATE_LIMITED');
      for (let index = 0; index < CHAT_OVERLAY_RATE_LIMIT_MAX + 10; index += 1) {
        sendMessage(host.ws, 'chat-overlay-update', { patch: { hide: [`c${index}`] } });
      }
      await limited;
      await new Promise((resolve) => setTimeout(resolve, 150));
      host.ws.off('message', count);
      assert.ok(delivered <= CHAT_OVERLAY_RATE_LIMIT_MAX, `delivered ${delivered}`);
    } finally {
      await harness.close();
    }
  });

  it('advertises the feature and sends the state in room-joined to admitted operators only', async () => {
    const harness = await createHarness();
    try {
      const { room, host, guest } = await studioWithCoHost(harness, 'chat-overlay-join');
      assert.equal(host.joined.payload.features.chatOverlay, true);
      assert.equal(host.joined.payload.chatOverlay, undefined, 'nothing stored yet');
      const updated = waitFor(host.ws, 'chat-overlay-updated');
      sendMessage(host.ws, 'chat-overlay-update', { patch: { enabled: true, side: 'right' } });
      await updated;
      host.ws.terminate();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const resumed = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', resumeToken: host.joined.payload.resumeToken });
      assert.equal(resumed.joined.payload.chatOverlay.enabled, true);
      assert.equal(resumed.joined.payload.chatOverlay.side, 'right');
      const lateGuest = await join(harness.url, { roomId: room.id, name: 'Lee', role: 'guest', joinSessionId: 'chat-overlay-join-lee' });
      assert.equal(lateGuest.joined.payload.chatOverlay, undefined, 'guests never receive it');
      assert.equal(guest.joined.payload.chatOverlay, undefined);
    } finally {
      await harness.close();
    }
  });
});
