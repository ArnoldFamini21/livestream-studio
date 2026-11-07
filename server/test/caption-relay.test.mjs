import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import { CAPTION_SEGMENT_RATE_LIMIT_MAX } from '@studio/shared';

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

const caption = (overrides = {}) => ({
  participantId: 'forged',
  speakerName: 'Forged name',
  segmentId: 'cap-1',
  text: 'Hello from Ohio',
  startMs: Date.now() - 1500,
  endMs: Date.now(),
  final: true,
  ...overrides,
});

describe('caption-segment relay', () => {
  it('relays an on-stage guest caption to hosts and co-hosts only, stamped with the sender', async () => {
    const harness = await createHarness();
    try {
      const { room, host, guest, coHost } = await studioWithCoHost(harness, 'caption-relay');
      const other = await join(harness.url, { roomId: room.id, name: 'Lee', role: 'guest', joinSessionId: 'caption-relay-other' });
      const hostGets = waitFor(host.ws, 'caption-segment');
      const coHostGets = waitFor(coHost.ws, 'caption-segment');
      const otherNothing = expectNone(other.ws, 'caption-segment');
      const senderNothing = expectNone(guest.ws, 'caption-segment');
      sendMessage(guest.ws, 'caption-segment', caption());
      const [atHost, atCoHost] = await Promise.all([hostGets, coHostGets, otherNothing, senderNothing]);
      assert.equal(atHost.payload.participantId, guest.id);
      assert.equal(atHost.payload.speakerName, 'Maria');
      assert.equal(atHost.payload.text, 'Hello from Ohio');
      assert.equal(atHost.payload.final, true);
      assert.deepEqual(atCoHost.payload, atHost.payload);
    } finally {
      await harness.close();
    }
  });

  it('refuses captions from off-stage senders and malformed segments, and rate-limits floods', async () => {
    const harness = await createHarness();
    try {
      const { host, guest } = await studioWithCoHost(harness, 'caption-guards');
      const moved = waitFor(guest.ws, 'participant-updated', (m) => m.payload.id === guest.id && m.payload.status === 'backstage');
      sendMessage(host.ws, 'stage-action', { action: 'move-to-backstage', targetParticipantId: guest.id, performedBy: 'x' });
      await moved;
      const refused = waitFor(guest.ws, 'error', (m) => m.payload.code === 'UNAUTHORIZED');
      const hostNothing = expectNone(host.ws, 'caption-segment');
      sendMessage(guest.ws, 'caption-segment', caption());
      await Promise.all([refused, hostNothing]);

      const back = waitFor(guest.ws, 'participant-updated', (m) => m.payload.id === guest.id && m.payload.status === 'on-stage');
      sendMessage(host.ws, 'stage-action', { action: 'move-to-stage', targetParticipantId: guest.id, performedBy: 'x' });
      await back;
      const invalid = waitFor(guest.ws, 'error', (m) => m.payload.code === 'INVALID_PAYLOAD');
      sendMessage(guest.ws, 'caption-segment', caption({ segmentId: 'bad id!' }));
      await invalid;

      let delivered = 0;
      const count = (data) => { if (JSON.parse(data.toString()).type === 'caption-segment') delivered += 1; };
      host.ws.on('message', count);
      const limited = waitFor(guest.ws, 'error', (m) => m.payload.code === 'RATE_LIMITED');
      for (let index = 0; index < CAPTION_SEGMENT_RATE_LIMIT_MAX + 5; index += 1) {
        sendMessage(guest.ws, 'caption-segment', caption({ segmentId: `cap-${index}`, final: false }));
      }
      await limited;
      await new Promise((resolve) => setTimeout(resolve, 150));
      host.ws.off('message', count);
      assert.ok(delivered <= CAPTION_SEGMENT_RATE_LIMIT_MAX, `delivered ${delivered}`);
    } finally {
      await harness.close();
    }
  });
});

describe('captions-state', () => {
  it('lets operators announce captions to admitted participants, not guests', async () => {
    const harness = await createHarness();
    try {
      const { host, guest, coHost } = await studioWithCoHost(harness, 'captions-state');
      const guestSees = waitFor(guest.ws, 'captions-state');
      const coHostSees = waitFor(coHost.ws, 'captions-state');
      sendMessage(host.ws, 'captions-state', { enabled: true, language: 'en-US', from: 'forged' });
      const [message] = await Promise.all([guestSees, coHostSees]);
      assert.deepEqual(message.payload, { enabled: true, language: 'en-US', from: host.id });

      const refused = waitFor(guest.ws, 'error', (m) => m.payload.code === 'UNAUTHORIZED');
      const hostNothing = expectNone(host.ws, 'captions-state');
      sendMessage(guest.ws, 'captions-state', { enabled: false, language: 'en-US' });
      await Promise.all([refused, hostNothing]);
    } finally {
      await harness.close();
    }
  });
});
