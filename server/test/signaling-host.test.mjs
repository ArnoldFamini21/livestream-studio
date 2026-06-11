import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

function waitForMessage(ws, type, predicate = () => true) {
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
      if (!predicate(message)) return;
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

function sendSignal(ws, message) {
  ws.send(JSON.stringify(message));
}

function verifySignedLiveToken(token, secret) {
  const [body, signature] = token.split('.');
  assert.ok(body);
  assert.ok(signature);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  assert.equal(signature, expected);
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
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

describe('live stream token authorization', () => {
  it('issues a signed short-lived live token to the host', async () => {
    const previousSecret = process.env.LIVE_STREAM_TOKEN_SECRET;
    const secret = 'test-live-stream-token-secret-1234567890';
    process.env.LIVE_STREAM_TOKEN_SECRET = secret;
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Live token host test', 'Arnold', {
      creatorIp: `live-token-host-${Date.now()}`,
    });

    try {
      const host = await connectClient(harness.url);
      const hostJoined = waitForMessage(host, 'room-joined');
      joinRoom(host, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken,
      });
      const joined = await hostJoined;

      const issuedToken = waitForMessage(host, 'live-stream-token-issued', (message) => (
        message.payload.requestId === 'live-request-1'
      ));
      sendSignal(host, {
        type: 'live-stream-token-request',
        payload: { requestId: 'live-request-1' },
      });

      const tokenMessage = await issuedToken;
      const claims = verifySignedLiveToken(tokenMessage.payload.token, secret);
      assert.equal(claims.v, 1);
      assert.equal(claims.roomId, room.id);
      assert.equal(claims.participantId, joined.payload.participant.id);
      assert.equal(claims.role, 'host');
      assert.equal(typeof claims.nonce, 'string');
      assert.ok(claims.exp > Date.now());
      assert.ok(Date.parse(tokenMessage.payload.expiresAt) > Date.now());
    } finally {
      if (previousSecret === undefined) {
        delete process.env.LIVE_STREAM_TOKEN_SECRET;
      } else {
        process.env.LIVE_STREAM_TOKEN_SECRET = previousSecret;
      }
      await harness.close();
    }
  });

  it('rejects guest live token requests', async () => {
    const harness = await createSignalingHarness();
    const { room } = createRoom('Live token guest test', 'Arnold', {
      creatorIp: `live-token-guest-${Date.now()}`,
    });

    try {
      const guest = await connectClient(harness.url);
      const guestJoined = waitForMessage(guest, 'room-joined');
      joinRoom(guest, {
        roomId: room.id,
        name: 'Guest',
        role: 'guest',
      });
      await guestJoined;

      const unauthorized = waitForMessage(guest, 'error', (message) => message.payload.code === 'UNAUTHORIZED');
      sendSignal(guest, {
        type: 'live-stream-token-request',
        payload: { requestId: 'guest-live-request' },
      });

      const error = await unauthorized;
      assert.match(error.payload.message, /Only hosts and co-hosts/);
    } finally {
      await harness.close();
    }
  });

  it('rejects malformed live token request ids', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Malformed live token request test', 'Arnold', {
      creatorIp: `live-token-invalid-request-${Date.now()}`,
    });

    try {
      const host = await connectClient(harness.url);
      const hostJoined = waitForMessage(host, 'room-joined');
      joinRoom(host, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken,
      });
      await hostJoined;

      const validationError = waitForMessage(host, 'error', (message) => message.payload.code === 'VALIDATION_ERROR');
      sendSignal(host, {
        type: 'live-stream-token-request',
        payload: { requestId: '' },
      });

      const error = await validationError;
      assert.match(error.payload.message, /Invalid live stream token request/);
    } finally {
      await harness.close();
    }
  });
});

describe('chat engagement', () => {
  it('broadcasts starred comments and reaction counts through canonical chat messages', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Chat engagement test', 'Arnold', {
      creatorIp: `chat-engagement-${Date.now()}`,
    });
    const roomState = getRooms().get(room.id);
    assert.ok(roomState);
    roomState.room.settings.greenRoomEnabled = false;

    try {
      const host = await connectClient(harness.url);
      const hostJoined = waitForMessage(host, 'room-joined');
      joinRoom(host, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken,
      });
      await hostJoined;

      const guest = await connectClient(harness.url);
      const guestJoined = waitForMessage(guest, 'room-joined');
      joinRoom(guest, {
        roomId: room.id,
        name: 'Guest',
        role: 'guest',
      });
      await guestJoined;

      const hostChat = waitForMessage(host, 'chat-message');
      const guestChat = waitForMessage(guest, 'chat-message');
      sendSignal(guest, {
        type: 'chat-message',
        payload: {
          id: 'guest-message-1',
          senderId: 'client-claimed-id',
          senderName: 'Client claimed name',
          content: 'Question from chat',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });

      const [hostMessage, guestMessage] = await Promise.all([hostChat, guestChat]);
      assert.equal(hostMessage.payload.content, 'Question from chat');
      assert.equal(hostMessage.payload.senderName, 'Guest');
      assert.equal(hostMessage.payload.clientId, 'guest-message-1');
      assert.equal(guestMessage.payload.id, hostMessage.payload.id);

      const starError = waitForMessage(guest, 'error', (message) => message.payload.code === 'UNAUTHORIZED');
      sendSignal(guest, {
        type: 'chat-star-update',
        payload: {
          messageId: hostMessage.payload.id,
          starred: true,
        },
      });
      const unauthorized = await starError;
      assert.match(unauthorized.payload.message, /Only hosts/);

      const hostStarred = waitForMessage(host, 'chat-message-updated', (message) => message.payload.starred === true);
      const guestStarred = waitForMessage(guest, 'chat-message-updated', (message) => message.payload.starred === true);
      sendSignal(host, {
        type: 'chat-star-update',
        payload: {
          messageId: hostMessage.payload.id,
          starred: true,
        },
      });
      const [hostStarredMessage, guestStarredMessage] = await Promise.all([hostStarred, guestStarred]);
      assert.equal(hostStarredMessage.payload.starred, true);
      assert.equal(guestStarredMessage.payload.starred, true);

      const hostReacted = waitForMessage(host, 'chat-message-updated', (message) => message.payload.reactions?.like === 1);
      const guestReacted = waitForMessage(guest, 'chat-message-updated', (message) => message.payload.reactions?.like === 1);
      sendSignal(guest, {
        type: 'chat-reaction',
        payload: {
          messageId: hostMessage.payload.id,
          reaction: 'like',
        },
      });
      const [hostReactedMessage, guestReactedMessage] = await Promise.all([hostReacted, guestReacted]);
      assert.equal(hostReactedMessage.payload.reactions.like, 1);
      assert.equal(guestReactedMessage.payload.reactions.like, 1);

      const lateGuest = await connectClient(harness.url);
      const lateJoined = waitForMessage(lateGuest, 'room-joined');
      joinRoom(lateGuest, {
        roomId: room.id,
        name: 'Late Guest',
        role: 'guest',
      });
      const late = await lateJoined;
      const savedMessage = late.payload.chatMessages.find((message) => message.id === hostMessage.payload.id);
      assert.ok(savedMessage);
      assert.equal(savedMessage.starred, true);
      assert.equal(savedMessage.reactions.like, 1);
    } finally {
      await harness.close();
    }
  });
});

describe('guest moderation bans', () => {
  it('prevents a banned guest session from rejoining the same room', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Guest ban test', 'Arnold', {
      creatorIp: `guest-ban-${Date.now()}`,
    });
    const roomState = getRooms().get(room.id);
    assert.ok(roomState);
    roomState.room.settings.greenRoomEnabled = false;

    try {
      const host = await connectClient(harness.url);
      const hostJoined = waitForMessage(host, 'room-joined');
      joinRoom(host, {
        roomId: room.id,
        name: 'Arnold',
        role: 'host',
        hostToken,
      });
      await hostJoined;

      const guest = await connectClient(harness.url);
      const guestJoined = waitForMessage(guest, 'room-joined');
      joinRoom(guest, {
        roomId: room.id,
        name: 'Guest',
        role: 'guest',
        joinSessionId: 'guest-browser-session-1',
      });
      const guestJoin = await guestJoined;

      const guestRemoved = waitForMessage(guest, 'participant-removed');
      const hostSawLeave = waitForMessage(host, 'participant-left', (message) => (
        message.payload.participantId === guestJoin.payload.participant.id
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'ban',
          targetParticipantId: guestJoin.payload.participant.id,
          performedBy: 'client-claimed-performer',
        },
      });

      const [removed] = await Promise.all([guestRemoved, hostSawLeave]);
      assert.match(removed.payload.reason, /banned/i);
      assert.ok(roomState.bannedJoinSessionIds.has('guest-browser-session-1'));

      const returningGuest = await connectClient(harness.url);
      const bannedError = waitForMessage(returningGuest, 'error');
      joinRoom(returningGuest, {
        roomId: room.id,
        name: 'Guest Again',
        role: 'guest',
        joinSessionId: 'guest-browser-session-1',
      });

      const error = await bannedError;
      assert.equal(error.payload.code, 'PARTICIPANT_BANNED');
      assert.equal(getRooms().get(room.id)?.participants.size, 1);
    } finally {
      await harness.close();
    }
  });
});
