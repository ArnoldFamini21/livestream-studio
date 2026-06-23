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

function expectNoMessage(ws, type, predicate = () => true, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

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
      reject(new Error(`Unexpected ${type}`));
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

describe('live stream state synchronization', () => {
  it('broadcasts authoritative live state and replays it to late joiners', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Live state sync test', 'Arnold', {
      creatorIp: `live-state-sync-${Date.now()}`,
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
      const hostJoin = await hostJoined;

      const guest = await connectClient(harness.url);
      const guestJoined = waitForMessage(guest, 'room-joined');
      joinRoom(guest, {
        roomId: room.id,
        name: 'Guest',
        role: 'guest',
      });
      await guestJoined;

      const hostLive = waitForMessage(host, 'live-stream-state-changed', (message) => message.payload.live === true);
      const guestLive = waitForMessage(guest, 'live-stream-state-changed', (message) => message.payload.live === true);
      sendSignal(host, {
        type: 'live-stream-state-changed',
        payload: {
          live: true,
          performedBy: 'client-claimed-host',
          startedAt: '2000-01-01T00:00:00.000Z',
        },
      });

      const [hostLiveMessage, guestLiveMessage] = await Promise.all([hostLive, guestLive]);
      assert.equal(hostLiveMessage.payload.performedBy, hostJoin.payload.participant.id);
      assert.equal(guestLiveMessage.payload.performedBy, hostJoin.payload.participant.id);
      assert.notEqual(hostLiveMessage.payload.startedAt, '2000-01-01T00:00:00.000Z');
      assert.equal(roomState.room.status, 'live');

      const lateGuest = await connectClient(harness.url);
      const lateJoined = waitForMessage(lateGuest, 'room-joined');
      joinRoom(lateGuest, {
        roomId: room.id,
        name: 'Late Guest',
        role: 'guest',
      });
      const late = await lateJoined;
      assert.equal(late.payload.room.status, 'live');
      assert.equal(late.payload.liveStreamState.live, true);
      assert.equal(late.payload.liveStreamState.performedBy, hostJoin.payload.participant.id);
      assert.equal(late.payload.liveStreamState.startedAt, hostLiveMessage.payload.startedAt);

      const hostStopped = waitForMessage(host, 'live-stream-state-changed', (message) => message.payload.live === false);
      const guestStopped = waitForMessage(guest, 'live-stream-state-changed', (message) => message.payload.live === false);
      sendSignal(host, {
        type: 'live-stream-state-changed',
        payload: {
          live: false,
          performedBy: 'client-claimed-host',
        },
      });

      const [hostStopMessage, guestStopMessage] = await Promise.all([hostStopped, guestStopped]);
      assert.equal(hostStopMessage.payload.performedBy, hostJoin.payload.participant.id);
      assert.equal(guestStopMessage.payload.performedBy, hostJoin.payload.participant.id);
      assert.equal(typeof hostStopMessage.payload.stoppedAt, 'string');
      assert.equal(roomState.room.status, 'waiting');
    } finally {
      await harness.close();
    }
  });

  it('keeps recording status when a live stream stops during recording', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Live state recording test', 'Arnold', {
      creatorIp: `live-state-recording-${Date.now()}`,
    });
    const roomState = getRooms().get(room.id);
    assert.ok(roomState);

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

      const recordingStarted = waitForMessage(host, 'recording-state-changed', (message) => message.payload.recording === true);
      sendSignal(host, {
        type: 'recording-state-changed',
        payload: {
          recording: true,
          performedBy: 'client-claimed-host',
        },
      });
      await recordingStarted;
      assert.equal(roomState.room.status, 'recording');

      const liveStarted = waitForMessage(host, 'live-stream-state-changed', (message) => message.payload.live === true);
      sendSignal(host, {
        type: 'live-stream-state-changed',
        payload: {
          live: true,
          performedBy: 'client-claimed-host',
        },
      });
      await liveStarted;
      assert.equal(roomState.room.status, 'live');

      const liveStopped = waitForMessage(host, 'live-stream-state-changed', (message) => message.payload.live === false);
      sendSignal(host, {
        type: 'live-stream-state-changed',
        payload: {
          live: false,
          performedBy: 'client-claimed-host',
        },
      });
      await liveStopped;
      assert.equal(roomState.room.status, 'recording');
    } finally {
      await harness.close();
    }
  });

  it('rejects guest live state changes', async () => {
    const harness = await createSignalingHarness();
    const { room } = createRoom('Live state guest test', 'Arnold', {
      creatorIp: `live-state-guest-${Date.now()}`,
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
        type: 'live-stream-state-changed',
        payload: {
          live: true,
          performedBy: 'client-claimed-guest',
        },
      });

      const error = await unauthorized;
      assert.match(error.payload.message, /Only hosts and co-hosts/);
      assert.equal(getRooms().get(room.id)?.room.status, 'waiting');
    } finally {
      await harness.close();
    }
  });

  it('clears live state when the streaming host disconnects during co-host handoff', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Live host disconnect test', 'Arnold', {
      creatorIp: `live-host-disconnect-${Date.now()}`,
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
      const hostJoin = await hostJoined;

      const coHost = await connectClient(harness.url);
      const coHostJoined = waitForMessage(coHost, 'room-joined');
      joinRoom(coHost, {
        roomId: room.id,
        name: 'Producer',
        role: 'guest',
      });
      const coHostJoin = await coHostJoined;

      const promoted = waitForMessage(coHost, 'participant-updated', (message) => (
        message.payload.id === coHostJoin.payload.participant.id &&
        message.payload.role === 'co-host'
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'promote-co-host',
          targetParticipantId: coHostJoin.payload.participant.id,
          performedBy: 'client-claimed-host',
        },
      });
      await promoted;

      const liveStarted = waitForMessage(coHost, 'live-stream-state-changed', (message) => message.payload.live === true);
      sendSignal(host, {
        type: 'live-stream-state-changed',
        payload: {
          live: true,
          performedBy: 'client-claimed-host',
        },
      });
      await liveStarted;
      assert.equal(roomState.liveStreamStartedBy, hostJoin.payload.participant.id);
      assert.equal(roomState.room.status, 'live');

      const liveStopped = waitForMessage(coHost, 'live-stream-state-changed', (message) => message.payload.live === false);
      const hostChanged = waitForMessage(coHost, 'host-changed', (message) => (
        message.payload.newHostId === coHostJoin.payload.participant.id
      ));
      host.close(1000, 'Host tab closed');

      const [stopped] = await Promise.all([liveStopped, hostChanged]);
      assert.equal(stopped.payload.performedBy, hostJoin.payload.participant.id);
      assert.equal(typeof stopped.payload.stoppedAt, 'string');
      assert.equal(roomState.liveStreamStartedAt, undefined);
      assert.equal(roomState.liveStreamStartedBy, undefined);
      assert.equal(roomState.room.status, 'waiting');
      assert.equal(roomState.room.hostId, coHostJoin.payload.participant.id);
    } finally {
      await harness.close();
    }
  });

  it('clears live state when a streaming co-host disconnects', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Live co-host disconnect test', 'Arnold', {
      creatorIp: `live-cohost-disconnect-${Date.now()}`,
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

      const coHost = await connectClient(harness.url);
      const coHostJoined = waitForMessage(coHost, 'room-joined');
      joinRoom(coHost, {
        roomId: room.id,
        name: 'Producer',
        role: 'guest',
      });
      const coHostJoin = await coHostJoined;

      const promoted = waitForMessage(host, 'participant-updated', (message) => (
        message.payload.id === coHostJoin.payload.participant.id &&
        message.payload.role === 'co-host'
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'promote-co-host',
          targetParticipantId: coHostJoin.payload.participant.id,
          performedBy: 'client-claimed-host',
        },
      });
      await promoted;

      const liveStarted = waitForMessage(host, 'live-stream-state-changed', (message) => message.payload.live === true);
      sendSignal(coHost, {
        type: 'live-stream-state-changed',
        payload: {
          live: true,
          performedBy: 'client-claimed-cohost',
        },
      });
      await liveStarted;
      assert.equal(roomState.liveStreamStartedBy, coHostJoin.payload.participant.id);
      assert.equal(roomState.room.status, 'live');

      const liveStopped = waitForMessage(host, 'live-stream-state-changed', (message) => message.payload.live === false);
      coHost.close(1000, 'Co-host tab closed');

      const stopped = await liveStopped;
      assert.equal(stopped.payload.performedBy, coHostJoin.payload.participant.id);
      assert.equal(roomState.liveStreamStartedAt, undefined);
      assert.equal(roomState.liveStreamStartedBy, undefined);
      assert.equal(roomState.room.status, 'waiting');
      assert.equal(roomState.participants.size, 1);
    } finally {
      await harness.close();
    }
  });
});

describe('participant media moderation', () => {
  it('force-mutes guests but treats unmute as a guest-controlled request', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Media moderation test', 'Arnold', {
      creatorIp: `media-moderation-${Date.now()}`,
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
      const guestJoin = await guestJoined;
      const guestId = guestJoin.payload.participant.id;
      assert.equal(roomState.participants.get(guestId)?.participant.audioEnabled, true);

      const muteUpdate = waitForMessage(host, 'participant-updated', (message) => (
        message.payload.id === guestId &&
        message.payload.audioEnabled === false
      ));
      const muteNotice = waitForMessage(guest, 'participant-notification', (message) => (
        message.payload.targetParticipantId === guestId &&
        /muted/i.test(message.payload.title)
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'mute',
          targetParticipantId: guestId,
          performedBy: 'client-claimed-host',
        },
      });

      const [muted, mutedNotice] = await Promise.all([muteUpdate, muteNotice]);
      assert.equal(muted.payload.audioEnabled, false);
      assert.equal(mutedNotice.payload.tone, 'warning');
      assert.equal(roomState.participants.get(guestId)?.participant.audioEnabled, false);

      const unmuteNotice = waitForMessage(guest, 'participant-notification', (message) => (
        message.payload.targetParticipantId === guestId &&
        /unmute requested/i.test(message.payload.title)
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'unmute',
          targetParticipantId: guestId,
          performedBy: 'client-claimed-host',
        },
      });

      const requested = await unmuteNotice;
      assert.equal(requested.payload.tone, 'info');
      assert.match(requested.payload.message, /turn your microphone on/i);
      assert.equal(roomState.participants.get(guestId)?.participant.audioEnabled, false);
    } finally {
      await harness.close();
    }
  });

  it('keeps backstage participants out of media relay and clears screen sharing', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Backstage media privacy test', 'Arnold', {
      creatorIp: `backstage-media-${Date.now()}`,
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

      const stageGuest = await connectClient(harness.url);
      const stageGuestJoined = waitForMessage(stageGuest, 'room-joined');
      joinRoom(stageGuest, {
        roomId: room.id,
        name: 'Stage Guest',
        role: 'guest',
      });
      const stageGuestState = await stageGuestJoined;

      const backstageGuest = await connectClient(harness.url);
      const backstageGuestJoined = waitForMessage(backstageGuest, 'room-joined');
      joinRoom(backstageGuest, {
        roomId: room.id,
        name: 'Backstage Guest',
        role: 'guest',
      });
      const backstageGuestState = await backstageGuestJoined;

      const onStageOffer = waitForMessage(backstageGuest, 'offer', (message) => (
        message.payload.from === stageGuestState.payload.participant.id
      ));
      sendSignal(stageGuest, {
        type: 'offer',
        payload: {
          to: backstageGuestState.payload.participant.id,
          sdp: { type: 'offer', sdp: 'v=0\r\n' },
        },
      });
      const relayedOffer = await onStageOffer;
      assert.equal(relayedOffer.payload.from, stageGuestState.payload.participant.id);

      const screenStarted = waitForMessage(host, 'media-state-changed', (message) => (
        message.payload.participantId === backstageGuestState.payload.participant.id &&
        message.payload.screenSharing === true
      ));
      sendSignal(backstageGuest, {
        type: 'media-state-changed',
        payload: {
          participantId: backstageGuestState.payload.participant.id,
          audioEnabled: true,
          videoEnabled: true,
          screenSharing: true,
        },
      });
      await screenStarted;
      assert.equal(roomState.participants.get(backstageGuestState.payload.participant.id)?.participant.screenSharing, true);

      const backstageUpdated = waitForMessage(backstageGuest, 'participant-updated', (message) => (
        message.payload.id === backstageGuestState.payload.participant.id &&
        message.payload.status === 'backstage'
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'move-to-backstage',
          targetParticipantId: backstageGuestState.payload.participant.id,
          performedBy: 'client-claimed-host',
        },
      });
      const updated = await backstageUpdated;
      assert.equal(updated.payload.screenSharing, false);
      assert.equal(roomState.participants.get(backstageGuestState.payload.participant.id)?.participant.screenSharing, false);

      const stageToBackstageBlocked = expectNoMessage(backstageGuest, 'offer', (message) => (
        message.payload.from === stageGuestState.payload.participant.id
      ));
      sendSignal(stageGuest, {
        type: 'offer',
        payload: {
          to: backstageGuestState.payload.participant.id,
          sdp: { type: 'offer', sdp: 'v=0\r\n' },
        },
      });
      await stageToBackstageBlocked;

      const backstageToStageBlocked = expectNoMessage(stageGuest, 'offer', (message) => (
        message.payload.from === backstageGuestState.payload.participant.id
      ));
      sendSignal(backstageGuest, {
        type: 'offer',
        payload: {
          to: stageGuestState.payload.participant.id,
          sdp: { type: 'offer', sdp: 'v=0\r\n' },
        },
      });
      await backstageToStageBlocked;

      const offStageScreenClaim = waitForMessage(host, 'media-state-changed', (message) => (
        message.payload.participantId === backstageGuestState.payload.participant.id &&
        message.payload.screenSharing === false
      ));
      sendSignal(backstageGuest, {
        type: 'media-state-changed',
        payload: {
          participantId: backstageGuestState.payload.participant.id,
          audioEnabled: true,
          videoEnabled: true,
          screenSharing: true,
        },
      });
      const normalizedClaim = await offStageScreenClaim;
      assert.equal(normalizedClaim.payload.screenSharing, false);
      assert.equal(roomState.participants.get(backstageGuestState.payload.participant.id)?.participant.screenSharing, false);
    } finally {
      await harness.close();
    }
  });
});

describe('chat engagement', () => {
  it('broadcasts starred, pinned, and reacted comments through canonical chat messages', async () => {
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

      const pinError = waitForMessage(guest, 'error', (message) => message.payload.code === 'UNAUTHORIZED');
      sendSignal(guest, {
        type: 'chat-pin-update',
        payload: {
          messageId: hostMessage.payload.id,
          pinned: true,
        },
      });
      const unauthorizedPin = await pinError;
      assert.match(unauthorizedPin.payload.message, /Only hosts/);

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

      const hostPinned = waitForMessage(host, 'chat-message-updated', (message) => message.payload.pinned === true);
      const guestPinned = waitForMessage(guest, 'chat-message-updated', (message) => message.payload.pinned === true);
      sendSignal(host, {
        type: 'chat-pin-update',
        payload: {
          messageId: hostMessage.payload.id,
          pinned: true,
        },
      });
      const [hostPinnedMessage, guestPinnedMessage] = await Promise.all([hostPinned, guestPinned]);
      assert.equal(hostPinnedMessage.payload.pinned, true);
      assert.equal(guestPinnedMessage.payload.pinned, true);

      const hostReacted = waitForMessage(host, 'chat-message-updated', (message) => message.payload.reactions?.like === 1);
      const guestReacted = waitForMessage(guest, 'chat-message-updated', (message) => message.payload.reactions?.like === 1);
      const hostReactionOverlay = waitForMessage(host, 'chat-reaction', (message) => (
        message.payload.messageId === hostMessage.payload.id && message.payload.reaction === 'like'
      ));
      const guestReactionOverlay = waitForMessage(guest, 'chat-reaction', (message) => (
        message.payload.messageId === hostMessage.payload.id && message.payload.reaction === 'like'
      ));
      sendSignal(guest, {
        type: 'chat-reaction',
        payload: {
          messageId: hostMessage.payload.id,
          reaction: 'like',
        },
      });
      const [hostReactedMessage, guestReactedMessage, hostOverlay, guestOverlay] = await Promise.all([
        hostReacted,
        guestReacted,
        hostReactionOverlay,
        guestReactionOverlay,
      ]);
      assert.equal(hostReactedMessage.payload.reactions.like, 1);
      assert.equal(guestReactedMessage.payload.reactions.like, 1);
      assert.equal(hostOverlay.payload.reaction, 'like');
      assert.equal(guestOverlay.payload.messageId, hostMessage.payload.id);

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
      assert.equal(savedMessage.pinned, true);
      assert.equal(savedMessage.reactions.like, 1);

      const hostUnpinned = waitForMessage(host, 'chat-message-updated', (message) => (
        message.payload.id === hostMessage.payload.id && message.payload.pinned !== true
      ));
      const guestUnpinned = waitForMessage(guest, 'chat-message-updated', (message) => (
        message.payload.id === hostMessage.payload.id && message.payload.pinned !== true
      ));
      const lateUnpinned = waitForMessage(lateGuest, 'chat-message-updated', (message) => (
        message.payload.id === hostMessage.payload.id && message.payload.pinned !== true
      ));
      sendSignal(host, {
        type: 'chat-pin-update',
        payload: {
          messageId: hostMessage.payload.id,
          pinned: false,
        },
      });
      const [hostUnpinnedMessage, guestUnpinnedMessage, lateUnpinnedMessage] = await Promise.all([hostUnpinned, guestUnpinned, lateUnpinned]);
      assert.equal(hostUnpinnedMessage.payload.pinned, undefined);
      assert.equal(guestUnpinnedMessage.payload.pinned, undefined);
      assert.equal(lateUnpinnedMessage.payload.pinned, undefined);
    } finally {
      await harness.close();
    }
  });

  it('scopes direct private chat to the sender and recipient', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Direct chat privacy test', 'Arnold', {
      creatorIp: `direct-chat-${Date.now()}`,
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
      const hostState = await hostJoined;

      const guest = await connectClient(harness.url);
      const guestJoined = waitForMessage(guest, 'room-joined');
      joinRoom(guest, {
        roomId: room.id,
        name: 'Guest',
        role: 'guest',
      });
      const guestState = await guestJoined;

      const observer = await connectClient(harness.url);
      const observerJoined = waitForMessage(observer, 'room-joined');
      joinRoom(observer, {
        roomId: room.id,
        name: 'Observer',
        role: 'guest',
      });
      const observerState = await observerJoined;

      const hostDirectMessage = waitForMessage(host, 'chat-message', (message) => message.payload.content === 'Private cue');
      const guestDirectMessage = waitForMessage(guest, 'chat-message', (message) => message.payload.content === 'Private cue');
      const observerNoDirectMessage = expectNoMessage(observer, 'chat-message', (message) => message.payload.content === 'Private cue');
      sendSignal(host, {
        type: 'chat-message',
        payload: {
          id: 'host-direct-message',
          senderId: 'client-claimed-host',
          senderName: 'Client claimed host',
          recipientId: guestState.payload.participant.id,
          recipientName: 'Client claimed guest',
          content: 'Private cue',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });

      const [hostDirect, guestDirect] = await Promise.all([hostDirectMessage, guestDirectMessage, observerNoDirectMessage]);
      assert.equal(hostDirect.payload.senderName, 'Arnold');
      assert.equal(hostDirect.payload.recipientId, guestState.payload.participant.id);
      assert.equal(hostDirect.payload.recipientName, 'Guest');
      assert.equal(hostDirect.payload.clientId, 'host-direct-message');
      assert.equal(hostDirect.payload.isBackstage, false);
      assert.equal(guestDirect.payload.id, hostDirect.payload.id);

      const starPrivateError = waitForMessage(host, 'error', (message) => message.payload.code === 'VALIDATION_ERROR');
      sendSignal(host, {
        type: 'chat-star-update',
        payload: {
          messageId: hostDirect.payload.id,
          starred: true,
        },
      });
      const privateStarError = await starPrivateError;
      assert.match(privateStarError.payload.message, /Private messages cannot be starred/i);

      const pinPrivateError = waitForMessage(host, 'error', (message) => message.payload.code === 'VALIDATION_ERROR');
      sendSignal(host, {
        type: 'chat-pin-update',
        payload: {
          messageId: hostDirect.payload.id,
          pinned: true,
        },
      });
      const privatePinError = await pinPrivateError;
      assert.match(privatePinError.payload.message, /Private messages cannot be pinned/i);

      const hostReplyMessage = waitForMessage(host, 'chat-message', (message) => message.payload.content === 'Private reply');
      const guestReplyMessage = waitForMessage(guest, 'chat-message', (message) => message.payload.content === 'Private reply');
      const observerNoReplyMessage = expectNoMessage(observer, 'chat-message', (message) => message.payload.content === 'Private reply');
      sendSignal(guest, {
        type: 'chat-message',
        payload: {
          id: 'guest-direct-reply',
          senderId: 'client-claimed-guest',
          senderName: 'Client claimed guest',
          recipientId: hostState.payload.participant.id,
          content: 'Private reply',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });
      const [hostReply, guestReply] = await Promise.all([hostReplyMessage, guestReplyMessage, observerNoReplyMessage]);
      assert.equal(hostReply.payload.senderName, 'Guest');
      assert.equal(hostReply.payload.recipientId, hostState.payload.participant.id);
      assert.equal(hostReply.payload.recipientName, 'Arnold');
      assert.equal(guestReply.payload.id, hostReply.payload.id);

      const guestToGuestDenied = waitForMessage(guest, 'error', (message) => message.payload.code === 'UNAUTHORIZED');
      sendSignal(guest, {
        type: 'chat-message',
        payload: {
          id: 'guest-to-guest-direct',
          senderId: guestState.payload.participant.id,
          senderName: 'Guest',
          recipientId: observerState.payload.participant.id,
          content: 'Guest to guest whisper',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });
      const denied = await guestToGuestDenied;
      assert.match(denied.payload.message, /host or co-host/i);

      const lateObserver = await connectClient(harness.url);
      const lateObserverJoined = waitForMessage(lateObserver, 'room-joined');
      joinRoom(lateObserver, {
        roomId: room.id,
        name: 'Late Observer',
        role: 'guest',
      });
      const late = await lateObserverJoined;
      assert.equal(
        late.payload.chatMessages.some((message) => (
          message.id === hostDirect.payload.id || message.id === hostReply.payload.id
        )),
        false
      );
    } finally {
      await harness.close();
    }
  });

  it('keeps backstage chat scoped to producers and backstage participants', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Backstage chat privacy test', 'Arnold', {
      creatorIp: `backstage-chat-${Date.now()}`,
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

      const stageGuest = await connectClient(harness.url);
      const stageGuestJoined = waitForMessage(stageGuest, 'room-joined');
      joinRoom(stageGuest, {
        roomId: room.id,
        name: 'On Stage Guest',
        role: 'guest',
      });
      const stageGuestState = await stageGuestJoined;

      const backstageGuest = await connectClient(harness.url);
      const backstageGuestJoined = waitForMessage(backstageGuest, 'room-joined');
      joinRoom(backstageGuest, {
        roomId: room.id,
        name: 'Backstage Guest',
        role: 'guest',
      });
      const backstageGuestState = await backstageGuestJoined;

      const publicGuest = await connectClient(harness.url);
      const publicGuestJoined = waitForMessage(publicGuest, 'room-joined');
      joinRoom(publicGuest, {
        roomId: room.id,
        name: 'Public Guest',
        role: 'guest',
      });
      await publicGuestJoined;

      const backstageUpdated = waitForMessage(backstageGuest, 'participant-updated', (message) => (
        message.payload.id === backstageGuestState.payload.participant.id &&
        message.payload.status === 'backstage'
      ));
      sendSignal(host, {
        type: 'stage-action',
        payload: {
          action: 'move-to-backstage',
          targetParticipantId: backstageGuestState.payload.participant.id,
          performedBy: 'client-claimed-host',
        },
      });
      await backstageUpdated;

      const unauthorizedBackstage = waitForMessage(stageGuest, 'error', (message) => message.payload.code === 'UNAUTHORIZED');
      sendSignal(stageGuest, {
        type: 'chat-message',
        payload: {
          id: 'stage-guest-backstage-message',
          senderId: stageGuestState.payload.participant.id,
          senderName: 'On Stage Guest',
          content: 'Can I whisper backstage?',
          timestamp: new Date().toISOString(),
          isBackstage: true,
        },
      });
      const unauthorized = await unauthorizedBackstage;
      assert.match(unauthorized.payload.message, /backstage chat/i);

      const hostBackstageMessage = waitForMessage(host, 'chat-message', (message) => message.payload.content === 'Backstage only');
      const backstageGuestMessage = waitForMessage(backstageGuest, 'chat-message', (message) => message.payload.content === 'Backstage only');
      const publicGuestNoBackstageMessage = expectNoMessage(publicGuest, 'chat-message', (message) => message.payload.content === 'Backstage only');
      sendSignal(host, {
        type: 'chat-message',
        payload: {
          id: 'host-backstage-message',
          senderId: 'client-claimed-host',
          senderName: 'Client claimed host',
          content: 'Backstage only',
          timestamp: new Date().toISOString(),
          isBackstage: true,
        },
      });

      const [hostPrivate, backstagePrivate] = await Promise.all([hostBackstageMessage, backstageGuestMessage]);
      assert.equal(hostPrivate.payload.isBackstage, true);
      assert.equal(hostPrivate.payload.senderName, 'Arnold');
      assert.equal(backstagePrivate.payload.id, hostPrivate.payload.id);
      await publicGuestNoBackstageMessage;

      const hostReaction = waitForMessage(host, 'chat-message-updated', (message) => (
        message.payload.id === hostPrivate.payload.id &&
        message.payload.reactions?.love === 1
      ));
      const backstageReaction = waitForMessage(backstageGuest, 'chat-message-updated', (message) => (
        message.payload.id === hostPrivate.payload.id &&
        message.payload.reactions?.love === 1
      ));
      sendSignal(backstageGuest, {
        type: 'chat-reaction',
        payload: {
          messageId: hostPrivate.payload.id,
          reaction: 'love',
        },
      });
      const [hostReacted, backstageReacted] = await Promise.all([hostReaction, backstageReaction]);
      assert.equal(hostReacted.payload.reactions.love, 1);
      assert.equal(backstageReacted.payload.reactions.love, 1);

      const starBackstageError = waitForMessage(host, 'error', (message) => message.payload.code === 'VALIDATION_ERROR');
      sendSignal(host, {
        type: 'chat-star-update',
        payload: {
          messageId: hostPrivate.payload.id,
          starred: true,
        },
      });
      const starError = await starBackstageError;
      assert.match(starError.payload.message, /Backstage messages cannot be starred/i);

      const pinBackstageError = waitForMessage(host, 'error', (message) => message.payload.code === 'VALIDATION_ERROR');
      sendSignal(host, {
        type: 'chat-pin-update',
        payload: {
          messageId: hostPrivate.payload.id,
          pinned: true,
        },
      });
      const pinError = await pinBackstageError;
      assert.match(pinError.payload.message, /Backstage messages cannot be pinned/i);

      const latePublicGuest = await connectClient(harness.url);
      const latePublicGuestJoined = waitForMessage(latePublicGuest, 'room-joined');
      joinRoom(latePublicGuest, {
        roomId: room.id,
        name: 'Late Public Guest',
        role: 'guest',
      });
      const latePublic = await latePublicGuestJoined;
      assert.equal(
        latePublic.payload.chatMessages.some((message) => message.id === hostPrivate.payload.id),
        false
      );
    } finally {
      await harness.close();
    }
  });
});

describe('live poll engagement', () => {
  it('counts public chat vote commands against the highlighted open poll', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Poll chat commands test', 'Arnold', {
      creatorIp: `poll-chat-${Date.now()}`,
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

      const firstPollCreated = waitForMessage(host, 'poll-updated', (message) => message.payload.id === 'poll-a');
      sendSignal(host, {
        type: 'poll-create',
        payload: {
          id: 'poll-a',
          question: 'Which topic should go first?',
          options: ['Launch checklist', 'Audience questions'],
        },
      });
      await firstPollCreated;

      const secondPollCreated = waitForMessage(host, 'poll-updated', (message) => message.payload.id === 'poll-b');
      sendSignal(host, {
        type: 'poll-create',
        payload: {
          id: 'poll-b',
          question: 'Which camera angle next?',
          options: ['Wide', 'Close'],
        },
      });
      await secondPollCreated;

      const firstPollHighlighted = waitForMessage(host, 'poll-updated', (message) => (
        message.payload.id === 'poll-a' && message.payload.highlighted === true
      ));
      sendSignal(host, {
        type: 'poll-update',
        payload: {
          pollId: 'poll-a',
          updates: { highlighted: true },
        },
      });
      await firstPollHighlighted;

      const hostVoted = waitForMessage(host, 'poll-updated', (message) => (
        message.payload.id === 'poll-a' &&
        message.payload.totalVotes === 1 &&
        message.payload.options[1].votes === 1
      ));
      const guestVoted = waitForMessage(guest, 'poll-updated', (message) => (
        message.payload.id === 'poll-a' &&
        message.payload.totalVotes === 1 &&
        message.payload.options[1].votes === 1
      ));
      sendSignal(guest, {
        type: 'chat-message',
        payload: {
          id: 'guest-poll-vote',
          senderId: 'client-claimed-guest',
          senderName: 'Client claimed guest',
          content: '!vote 2',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });
      const [hostPoll, guestPoll] = await Promise.all([hostVoted, guestVoted]);
      assert.equal(hostPoll.payload.options[1].text, 'Audience questions');
      assert.equal(guestPoll.payload.options[1].votes, 1);
      assert.equal(roomState.polls.get('poll-b')?.totalVotes, 0);

      const revoted = waitForMessage(host, 'poll-updated', (message) => (
        message.payload.id === 'poll-a' &&
        message.payload.totalVotes === 1 &&
        message.payload.options[0].votes === 1 &&
        message.payload.options[1].votes === 0
      ));
      sendSignal(guest, {
        type: 'chat-message',
        payload: {
          id: 'guest-poll-revote',
          senderId: 'client-claimed-guest',
          senderName: 'Client claimed guest',
          content: '/vote a',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });
      const updatedPoll = await revoted;
      assert.equal(updatedPoll.payload.options[0].text, 'Launch checklist');
      assert.equal(updatedPoll.payload.totalVotes, 1);
    } finally {
      await harness.close();
    }
  });
});

describe('Q&A engagement', () => {
  it('queues public chat ask commands for host review and on-screen selection', async () => {
    const harness = await createSignalingHarness();
    const { room, hostToken } = createRoom('Q&A chat commands test', 'Arnold', {
      creatorIp: `qa-chat-${Date.now()}`,
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

      const observer = await connectClient(harness.url);
      const observerJoined = waitForMessage(observer, 'room-joined');
      joinRoom(observer, {
        roomId: room.id,
        name: 'Observer',
        role: 'guest',
      });
      await observerJoined;

      const hostQuestion = waitForMessage(host, 'qa-question-updated', (message) => (
        message.payload.content === 'Can you show the replay link later?' &&
        message.payload.status === 'pending'
      ));
      const guestQuestion = waitForMessage(guest, 'qa-question-updated', (message) => (
        message.payload.content === 'Can you show the replay link later?' &&
        message.payload.status === 'pending'
      ));
      const observerNoPendingQuestion = expectNoMessage(observer, 'qa-question-updated', (message) => (
        message.payload.content === 'Can you show the replay link later?' &&
        message.payload.status === 'pending'
      ));

      sendSignal(guest, {
        type: 'chat-message',
        payload: {
          id: 'guest-ask-command',
          senderId: 'client-claimed-guest',
          senderName: 'Client claimed guest',
          content: '!ask Can you show the replay link later?',
          timestamp: new Date().toISOString(),
          isBackstage: false,
        },
      });

      const [hostPending, guestPending] = await Promise.all([
        hostQuestion,
        guestQuestion,
        observerNoPendingQuestion,
      ]);
      assert.equal(hostPending.payload.authorName, 'Guest');
      assert.equal(guestPending.payload.id, hostPending.payload.id);
      assert.equal(roomState.qaQuestions.get(hostPending.payload.id)?.status, 'pending');

      const observerApproved = waitForMessage(observer, 'qa-question-updated', (message) => (
        message.payload.id === hostPending.payload.id &&
        message.payload.status === 'approved'
      ));
      sendSignal(host, {
        type: 'qa-question-update',
        payload: {
          questionId: hostPending.payload.id,
          updates: { status: 'approved' },
        },
      });
      const approved = await observerApproved;
      assert.equal(approved.payload.status, 'approved');

      const guestHighlighted = waitForMessage(guest, 'qa-question-updated', (message) => (
        message.payload.id === hostPending.payload.id &&
        message.payload.highlighted === true
      ));
      sendSignal(host, {
        type: 'qa-question-update',
        payload: {
          questionId: hostPending.payload.id,
          updates: { highlighted: true },
        },
      });
      const highlighted = await guestHighlighted;
      assert.equal(highlighted.payload.highlighted, true);
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
