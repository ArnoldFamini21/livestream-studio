import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createRoom, getRooms, setupSignalingServer } from '../dist/services/signaling.js';

async function createSignalingHarness() {
  const wss = new WebSocketServer({ port: 0 });
  setupSignalingServer(wss);
  let address = wss.address();
  if (!address) {
    await new Promise((resolve) => wss.once('listening', resolve));
    address = wss.address();
  }
  assert.equal(typeof address, 'object');
  assert.ok(address);
  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

async function connectClient(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function waitForMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 1500);

    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('error', onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

function joinRoom(ws, payload) {
  ws.send(JSON.stringify({ type: 'join-room', payload }));
}

describe('host admission', () => {
  it('keeps a valid host-token login on stage when replacing a stale host session', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Host reclaim test', 'Arnold', {
      creatorIp: `host-reclaim-${Date.now()}`,
    });

    try {
      const firstHost = await connectClient(harness.url);
      const firstJoined = waitForMessage(firstHost, 'room-joined');
      joinRoom(firstHost, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken,
      });
      const first = await firstJoined;
      assert.equal(first.payload.participant.role, 'host');
      assert.equal(first.payload.participant.status, 'on-stage');

      const staleHostRemoved = waitForMessage(firstHost, 'participant-removed');
      const secondHost = await connectClient(harness.url);
      const secondJoined = waitForMessage(secondHost, 'room-joined');
      joinRoom(secondHost, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken,
      });

      const [removed, second] = await Promise.all([staleHostRemoved, secondJoined]);
      assert.match(removed.payload.reason, /replaced/i);
      assert.equal(second.payload.participant.role, 'host');
      assert.equal(second.payload.participant.status, 'on-stage');
      assert.equal(getRooms().get(room.id)?.room.hostId, second.payload.participant.id);
      assert.equal(getRooms().get(room.id)?.participants.size, 1);
    } finally {
      await harness.close();
    }
  });

  it('rejects an invalid host-token claim instead of placing it in the green room', async () => {
    const harness = await createSignalingHarness();
    const { room } = createRoom('Invalid host test', 'Arnold', {
      creatorIp: `invalid-host-${Date.now()}`,
    });

    try {
      const ws = await connectClient(harness.url);
      const errorMessage = waitForMessage(ws, 'error');
      joinRoom(ws, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken: 'not-the-host-token',
      });

      const error = await errorMessage;
      assert.equal(error.payload.code, 'HOST_TOKEN_INVALID');
      assert.equal(getRooms().get(room.id)?.participants.size, 0);
    } finally {
      await harness.close();
    }
  });
});
