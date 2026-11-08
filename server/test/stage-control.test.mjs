import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

// A short resume grace so a dropped host hands over quickly in these tests.
process.env.SIGNALING_RESUME_GRACE_MS = '300';

const {
  STAGE_CONTROL_RATE_LIMIT_MAX,
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

const deck = { media: { id: 'deck-1', type: 'presentation', name: 'Sermon deck', slideIndex: 2, slideCount: 12 } };

describe('co-host stage mirroring', () => {
  it('keeps the host slides on guest screens when a co-host mirrors an empty stage', async () => {
    const harness = await createHarness();
    try {
      const { state, host, guest, coHost } = await studioWithCoHost(harness, 'cohost-clear');
      const guestSees = waitFor(guest.ws, 'stage-content-updated', (m) => m.payload.media?.id === 'deck-1');
      sendMessage(host.ws, 'stage-content-updated', deck);
      await guestSees;

      const refused = waitFor(coHost.ws, 'error', (m) => m.payload.code === 'STAGE_OWNED_BY_HOST');
      const guestUnchanged = expectNone(guest.ws, 'stage-content-updated');
      sendMessage(coHost.ws, 'stage-content-updated', { media: null });
      await Promise.all([refused, guestUnchanged]);
      assert.equal(state.stageContent.media.id, 'deck-1');

      // The host itself can still take the slides down.
      const cleared = waitFor(guest.ws, 'stage-content-updated', (m) => m.payload.media === null);
      sendMessage(host.ws, 'stage-content-updated', { media: null });
      await cleared;
      assert.equal(state.stageContent.media, null);
    } finally {
      await harness.close();
    }
  });

  it('lets the co-host clear once the host has handed the studio over', async () => {
    const harness = await createHarness();
    try {
      const { state, host, guest, coHost } = await studioWithCoHost(harness, 'cohost-handoff');
      const guestSees = waitFor(guest.ws, 'stage-content-updated', (m) => m.payload.media?.id === 'deck-1');
      sendMessage(host.ws, 'stage-content-updated', deck);
      await guestSees;
      const handedOff = waitFor(coHost.ws, 'host-changed', (m) => m.payload.newHostId === coHost.id);
      host.ws.terminate();
      await handedOff;
      const cleared = waitFor(guest.ws, 'stage-content-updated', (m) => m.payload.media === null);
      sendMessage(coHost.ws, 'stage-content-updated', { media: null });
      await cleared;
      assert.equal(state.stageContent.media, null);
    } finally {
      await harness.close();
    }
  });
});

describe('stage-control', () => {
  it('relays a co-host slide command to the host only', async () => {
    const harness = await createHarness();
    try {
      const { host, guest, coHost } = await studioWithCoHost(harness, 'stage-control-relay');
      const received = waitFor(host.ws, 'stage-control');
      const guestNothing = expectNone(guest.ws, 'stage-control');
      sendMessage(coHost.ws, 'stage-control', { action: 'goto', slideIndex: 4, mediaId: 'deck-1', from: 'forged' });
      const message = await received;
      await guestNothing;
      assert.deepEqual(message.payload, { action: 'goto', slideIndex: 4, mediaId: 'deck-1', from: coHost.id });

      const next = waitFor(host.ws, 'stage-control', (m) => m.payload.action === 'next');
      sendMessage(coHost.ws, 'stage-control', { action: 'next', slideIndex: 99 });
      assert.deepEqual((await next).payload, { action: 'next', from: coHost.id }, 'slideIndex only travels with goto');
    } finally {
      await harness.close();
    }
  });

  it('refuses guests, bad payloads, the owner itself, and floods', async () => {
    const harness = await createHarness();
    try {
      const { host, guest, coHost } = await studioWithCoHost(harness, 'stage-control-guards');
      const guestRefused = waitFor(guest.ws, 'error', (m) => m.payload.code === 'STAGE_CONTROL_FORBIDDEN');
      const hostNothing = expectNone(host.ws, 'stage-control');
      sendMessage(guest.ws, 'stage-control', { action: 'next' });
      await Promise.all([guestRefused, hostNothing]);

      const badGoto = waitFor(coHost.ws, 'error', (m) => m.payload.code === 'INVALID_PAYLOAD');
      sendMessage(coHost.ws, 'stage-control', { action: 'goto', slideIndex: -1 });
      await badGoto;
      const badAction = waitFor(coHost.ws, 'error', (m) => m.payload.code === 'INVALID_PAYLOAD');
      sendMessage(coHost.ws, 'stage-control', { action: 'delete-everything' });
      await badAction;

      const ownerItself = waitFor(host.ws, 'error', (m) => m.payload.code === 'NO_STAGE_OWNER');
      sendMessage(host.ws, 'stage-control', { action: 'next' });
      await ownerItself;

      let delivered = 0;
      const count = (data) => { if (JSON.parse(data.toString()).type === 'stage-control') delivered += 1; };
      host.ws.on('message', count);
      const limited = waitFor(coHost.ws, 'error', (m) => m.payload.code === 'RATE_LIMITED');
      for (let index = 0; index < STAGE_CONTROL_RATE_LIMIT_MAX + 5; index += 1) {
        sendMessage(coHost.ws, 'stage-control', { action: 'next' });
      }
      await limited;
      await new Promise((resolve) => setTimeout(resolve, 150));
      host.ws.off('message', count);
      // Earlier invalid commands counted against the same window.
      assert.ok(delivered <= STAGE_CONTROL_RATE_LIMIT_MAX, `delivered ${delivered}`);
      assert.ok(delivered >= STAGE_CONTROL_RATE_LIMIT_MAX - 3, `delivered ${delivered}`);
    } finally {
      await harness.close();
    }
  });
});

describe('program-return-announce', () => {
  it('reaches admitted peers of the host, never the green room or non-operators', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('program-return');
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const backstage = await join(harness.url, { roomId: room.id, name: 'Nica', role: 'guest', joinSessionId: 'pr-backstage' });
      const movedBack = waitFor(backstage.ws, 'participant-updated', (m) => m.payload.id === backstage.id && m.payload.status === 'backstage');
      sendMessage(host.ws, 'stage-action', { action: 'move-to-backstage', targetParticipantId: backstage.id, performedBy: 'x' });
      await movedBack;

      const streamId = '{3f1c2a7e-8b1d-4d7a-9a51-0f6c3e2b1d4a}';
      const announced = waitFor(backstage.ws, 'program-return-announce');
      sendMessage(host.ws, 'program-return-announce', { to: backstage.id, streamId });
      assert.deepEqual((await announced).payload, { to: backstage.id, streamId, from: host.id });

      state.room.settings.greenRoomEnabled = true;
      const waiting = await join(harness.url, { roomId: room.id, name: 'Waiting', role: 'guest', joinSessionId: 'pr-waiting' });
      assert.equal(waiting.joined.payload.participant.status, 'green-room');
      const waitingNothing = expectNone(waiting.ws, 'program-return-announce');
      sendMessage(host.ws, 'program-return-announce', { to: waiting.id, streamId });
      await waitingNothing;

      const notOperator = waitFor(backstage.ws, 'error', (m) => m.payload.code === 'PROGRAM_RETURN_FORBIDDEN');
      sendMessage(backstage.ws, 'program-return-announce', { to: host.id, streamId });
      await notOperator;

      const invalid = waitFor(host.ws, 'error', (m) => m.payload.code === 'PROGRAM_RETURN_INVALID');
      sendMessage(host.ws, 'program-return-announce', { to: backstage.id, streamId: 'not a stream id' });
      await invalid;
    } finally {
      await harness.close();
    }
  });
});
