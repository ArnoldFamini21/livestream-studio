import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

// A short resume grace keeps these tests fast; production holds a seat for 30 s.
process.env.SIGNALING_RESUME_GRACE_MS = '400';

const {
  MAX_GREEN_ROOM_PARTICIPANTS,
  createRoom,
  findRoomByWatchId,
  getRooms,
  restoreRoomSnapshots,
  setSfuMembershipNotifier,
  setupSignalingServer,
} = await import('../dist/services/signaling.js');
const { normalizeRoomSnapshot } = await import('../dist/services/roomPersistence.js');

const notifications = [];
setSfuMembershipNotifier((notification) => { notifications.push(notification); });

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

async function connect(url, options) {
  const ws = new WebSocket(url, options);
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

async function join(url, payload, options) {
  const ws = await connect(url, options);
  const joined = waitFor(ws, 'room-joined');
  sendMessage(ws, 'join-room', payload);
  return { ws, joined: await joined };
}

function makeRoom(label, options = {}) {
  const created = createRoom(`${label} test`, 'Arnold', { creatorIp: `${label}-${Date.now()}-${Math.random()}`, ...options });
  return { ...created, state: getRooms().get(created.room.id) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('seat resume across dropped connections', () => {
  it('gives the same participant back on a resume token, without telling anyone they left', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('resume');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const guest = await join(harness.url, { roomId: room.id, name: 'Maria', role: 'guest', joinSessionId: 'maria-browser-01' });
      const guestId = guest.joined.payload.participant.id;
      const resumeToken = guest.joined.payload.resumeToken;
      assert.equal(typeof resumeToken, 'string');

      const noLeave = expectNone(host.ws, 'participant-left', () => true, 250);
      guest.ws.terminate();
      await sleep(50);
      const back = await join(harness.url, { roomId: room.id, name: 'Maria', role: 'guest', joinSessionId: 'maria-browser-01', resumeToken });
      await noLeave;
      assert.equal(back.joined.payload.participant.id, guestId);
      assert.equal(back.joined.payload.participant.status, 'on-stage');
      assert.equal(back.joined.payload.resumed, true);
      assert.notEqual(back.joined.payload.resumeToken, resumeToken, 'the token rotates on every resume');
      assert.equal(state.participants.size, 2);

      // The old token is spent; it no longer resumes anything.
      const stale = await join(harness.url, { roomId: room.id, name: 'Maria', role: 'guest', resumeToken });
      assert.notEqual(stale.joined.payload.participant.id, guestId);
    } finally {
      await harness.close();
    }
  });

  it('frees the seat when the grace window passes, and at once on a deliberate leave', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('grace');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const dropped = await join(harness.url, { roomId: room.id, name: 'Dropped', role: 'guest' });
      const left = waitFor(host.ws, 'participant-left', (m) => m.payload.participantId === dropped.joined.payload.participant.id, 2000);
      const startedAt = Date.now();
      dropped.ws.terminate();
      await left;
      assert.ok(Date.now() - startedAt >= 300, 'the seat was held for the grace window first');

      const leaving = await join(harness.url, { roomId: room.id, name: 'Leaving', role: 'guest' });
      const leftNow = waitFor(host.ws, 'participant-left', (m) => m.payload.participantId === leaving.joined.payload.participant.id, 250);
      leaving.ws.close(1000, 'Left the studio');
      await leftNow;
    } finally {
      await harness.close();
    }
  });

  it('lets the host take back their own held seat with the host token, keeping the participant id', async () => {
    const harness = await createHarness();
    const { room, hostToken } = makeRoom('host-resume');
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const hostId = host.joined.payload.participant.id;
      host.ws.terminate();
      await sleep(50);
      const back = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      assert.equal(back.joined.payload.participant.id, hostId);
      assert.equal(back.joined.payload.participant.role, 'host');
    } finally {
      await harness.close();
    }
  });
});

describe('host return after a co-host stood in', () => {
  it('hands the host seat back and keeps the co-host in the studio', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('handback');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const coHost = await join(harness.url, { roomId: room.id, name: 'Producer', role: 'guest', joinSessionId: 'producer-browser' });
      const coHostId = coHost.joined.payload.participant.id;
      const promoted = waitFor(coHost.ws, 'participant-updated', (m) => m.payload.id === coHostId && m.payload.role === 'co-host');
      sendMessage(host.ws, 'stage-action', { action: 'promote-co-host', targetParticipantId: coHostId, performedBy: 'x' });
      await promoted;

      const handedOff = waitFor(coHost.ws, 'host-changed', (m) => m.payload.newHostId === coHostId, 2000);
      host.ws.terminate();
      await handedOff;
      assert.equal(state.room.hostId, coHostId);

      const noRemoval = expectNone(coHost.ws, 'participant-removed', () => true, 400);
      const demoted = waitFor(coHost.ws, 'participant-updated', (m) => m.payload.id === coHostId && m.payload.role === 'co-host');
      const hostChanged = waitFor(coHost.ws, 'host-changed', (m) => m.payload.newHostId !== coHostId);
      const back = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      await Promise.all([demoted, hostChanged, noRemoval]);
      assert.equal(state.room.hostId, back.joined.payload.participant.id);
      assert.ok(state.room.coHostIds.includes(coHostId));
      assert.equal(state.participants.get(coHostId).participant.role, 'co-host');
      assert.equal(coHost.ws.readyState, WebSocket.OPEN);
    } finally {
      await harness.close();
    }
  });
});

describe('removal, bans and invite links', () => {
  it('sends a removed guest back through the green room instead of their old seat', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('removed');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const guest = await join(harness.url, { roomId: room.id, name: 'Troll', role: 'guest', joinSessionId: 'troll-browser-01' });
      assert.equal(guest.joined.payload.participant.status, 'on-stage');
      const left = waitFor(host.ws, 'participant-left', () => true, 300);
      sendMessage(host.ws, 'stage-action', { action: 'remove', targetParticipantId: guest.joined.payload.participant.id, performedBy: 'x' });
      await left;
      assert.ok(notifications.some((n) => n.action === 'revoke-recording-upload' && n.participantId === guest.joined.payload.participant.id));

      const again = await join(harness.url, { roomId: room.id, name: 'Troll', role: 'guest', joinSessionId: 'troll-browser-01' });
      assert.equal(again.joined.payload.participant.status, 'green-room');
    } finally {
      await harness.close();
    }
  });

  it('keeps a banned guest out with a fresh browser session from the same network', async () => {
    const harness = await createHarness();
    const { room, hostToken } = makeRoom('ban-ip');
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const headers = { 'x-forwarded-for': '203.0.113.77' };
      const guest = await join(harness.url, { roomId: room.id, name: 'Troll', role: 'guest', joinSessionId: 'troll-browser-02' }, { headers });
      sendMessage(host.ws, 'stage-action', { action: 'ban', targetParticipantId: guest.joined.payload.participant.id, performedBy: 'x' });
      await waitFor(host.ws, 'participant-left');

      const retry = await connect(harness.url, { headers });
      const refused = waitFor(retry, 'error', (m) => m.payload.code === 'PARTICIPANT_BANNED');
      sendMessage(retry, 'join-room', { roomId: room.id, name: 'New Name', role: 'guest', joinSessionId: 'brand-new-browser' });
      await refused;

      const other = await join(harness.url, { roomId: room.id, name: 'Someone else', role: 'guest' }, { headers: { 'x-forwarded-for': '198.51.100.9' } });
      assert.equal(other.joined.payload.participant.status, 'green-room');
    } finally {
      await harness.close();
    }
  });

  it('revokes invite links created by a co-host who is demoted', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('revoke-invites');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const producer = await join(harness.url, { roomId: room.id, name: 'Producer', role: 'guest' });
      const producerId = producer.joined.payload.participant.id;
      sendMessage(host.ws, 'stage-action', { action: 'promote-co-host', targetParticipantId: producerId, performedBy: 'x' });
      await waitFor(producer.ws, 'participant-updated', (m) => m.payload.id === producerId && m.payload.role === 'co-host');
      const issued = waitFor(producer.ws, 'co-host-invite-token-issued');
      sendMessage(producer.ws, 'co-host-invite-token-request', { requestId: 'request-1' });
      const { payload: { token } } = await issued;
      assert.equal(state.coHostInviteTokens.has(token), true);

      sendMessage(host.ws, 'stage-action', { action: 'demote-to-guest', targetParticipantId: producerId, performedBy: 'x' });
      await waitFor(producer.ws, 'participant-updated', (m) => m.payload.id === producerId && m.payload.role === 'guest');
      assert.equal(state.coHostInviteTokens.has(token), false);
    } finally {
      await harness.close();
    }
  });

  it('keeps a co-host who redeemed a single-use link a co-host when they reconnect without it', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('redeemed');
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const issued = waitFor(host.ws, 'co-host-invite-token-issued');
      sendMessage(host.ws, 'co-host-invite-token-request', { requestId: 'request-2' });
      const { payload: { token } } = await issued;

      const coHost = await join(harness.url, { roomId: room.id, name: 'Pastor', role: 'co-host', coHostInviteToken: token, joinSessionId: 'pastor-browser-1' });
      assert.equal(coHost.joined.payload.participant.role, 'co-host');
      assert.equal(coHost.joined.payload.participant.status, 'backstage', 'co-hosts arrive backstage by default');
      assert.equal(typeof coHost.joined.payload.watchId, 'string');
      coHost.ws.close(1000);
      await waitFor(host.ws, 'participant-left');

      // A spent token with the same browser keeps the role...
      const again = await join(harness.url, { roomId: room.id, name: 'Pastor', role: 'co-host', coHostInviteToken: token, joinSessionId: 'pastor-browser-1' });
      assert.equal(again.joined.payload.participant.role, 'co-host');
      again.ws.close(1000);
      await waitFor(host.ws, 'participant-left');

      // ...but another browser cannot reuse it.
      const thief = await connect(harness.url);
      const refused = waitFor(thief, 'error', (m) => m.payload.code === 'CO_HOST_INVITE_INVALID');
      sendMessage(thief, 'join-room', { roomId: room.id, name: 'Thief', role: 'co-host', coHostInviteToken: token, joinSessionId: 'thief-browser-1' });
      await refused;
      assert.equal([...state.participants.values()].some((entry) => entry.participant.name === 'Thief'), false);
    } finally {
      await harness.close();
    }
  });
});

describe('green room privacy and seats', () => {
  it('shows a waiting guest only the hosts, and the full studio once admitted', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('privacy');
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      assert.equal(host.joined.payload.watchId, state.watchId);
      assert.notEqual(state.watchId, room.id);
      assert.equal(findRoomByWatchId(state.watchId).id, room.id);
      assert.equal(findRoomByWatchId(room.id), undefined, 'the room id is not a watch id');

      state.room.settings.greenRoomEnabled = false;
      const onStage = await join(harness.url, { roomId: room.id, name: 'Stage Guest', role: 'guest' });
      state.room.settings.greenRoomEnabled = true;
      sendMessage(host.ws, 'chat-message', { id: 'c1', senderId: 'x', senderName: 'x', content: 'Hello studio', timestamp: new Date().toISOString(), isBackstage: false });
      await waitFor(onStage.ws, 'chat-message');
      sendMessage(host.ws, 'stage-content-updated', { media: { id: 'deck', type: 'pdf', name: 'Sermon notes' } });
      await waitFor(onStage.ws, 'stage-content-updated');

      const waiting = await join(harness.url, { roomId: room.id, name: 'Waiting', role: 'guest' });
      const payload = waiting.joined.payload;
      assert.equal(payload.participant.status, 'green-room');
      assert.deepEqual(payload.chatMessages, []);
      assert.equal(payload.stageContent, undefined);
      assert.equal(payload.watchId, undefined);
      assert.equal(payload.stageReadToken, undefined);
      assert.deepEqual(payload.participants.map((p) => p.name), ['Arnold'], 'only the hosts are listed');

      const noChat = expectNone(waiting.ws, 'chat-message');
      const noStage = expectNone(waiting.ws, 'stage-content-updated');
      const noGuestDetails = expectNone(waiting.ws, 'media-state-changed', (m) => m.payload.participantId === onStage.joined.payload.participant.id);
      sendMessage(host.ws, 'chat-message', { id: 'c2', senderId: 'x', senderName: 'x', content: 'Second', timestamp: new Date().toISOString(), isBackstage: false });
      sendMessage(host.ws, 'stage-content-updated', { media: null });
      sendMessage(onStage.ws, 'media-state-changed', { participantId: 'x', audioEnabled: false, videoEnabled: true, screenSharing: false });
      await Promise.all([noChat, noStage, noGuestDetails]);

      // Admitting sends a full snapshot; "Admit" goes backstage, not on air.
      const snapshot = waitFor(waiting.ws, 'room-joined');
      sendMessage(host.ws, 'stage-action', { action: 'move-to-backstage', targetParticipantId: payload.participant.id, performedBy: 'x' });
      const admitted = (await snapshot).payload;
      assert.equal(admitted.participant.id, payload.participant.id);
      assert.equal(admitted.participant.status, 'backstage');
      assert.equal(admitted.chatMessages.length, 2);
      assert.equal(typeof admitted.stageReadToken, 'string');
      assert.deepEqual(admitted.participants.map((p) => p.name).sort(), ['Arnold', 'Stage Guest']);
    } finally {
      await harness.close();
    }
  });

  it('caps the green room separately from stage seats, and always seats the host', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('seats');
    state.room.settings.maxParticipants = 2;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      state.room.settings.greenRoomEnabled = false;
      await join(harness.url, { roomId: room.id, name: 'Seat Two', role: 'guest' });
      // The stage is full: a new guest waits instead of being refused.
      const overflow = await join(harness.url, { roomId: room.id, name: 'Overflow', role: 'guest' });
      assert.equal(overflow.joined.payload.participant.status, 'green-room');
      state.room.settings.greenRoomEnabled = true;
      const full = waitFor(host.ws, 'error', (m) => m.payload.code === 'ROOM_FULL');
      sendMessage(host.ws, 'stage-action', { action: 'move-to-stage', targetParticipantId: overflow.joined.payload.participant.id, performedBy: 'x' });
      await full;

      for (let i = 1; i < MAX_GREEN_ROOM_PARTICIPANTS; i++) {
        await join(harness.url, { roomId: room.id, name: `Waiting ${i}`, role: 'guest' });
      }
      const refused = await connect(harness.url);
      const waitingRoomFull = waitFor(refused, 'error', (m) => m.payload.code === 'ROOM_FULL');
      sendMessage(refused, 'join-room', { roomId: room.id, name: 'One too many', role: 'guest' });
      await waitingRoomFull;

      // The host's seat cannot be taken: a second host login still gets in.
      const secondHost = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      assert.equal(secondHost.joined.payload.participant.role, 'host');
    } finally {
      await harness.close();
    }
  });
});

describe('room password brute force', () => {
  it('locks an address out after repeated wrong passwords and closes a socket that keeps guessing', async () => {
    const harness = await createHarness();
    const { room } = makeRoom('password', { password: 'correct horse' });
    const headers = { 'x-forwarded-for': '192.0.2.44' };
    try {
      const sockets = [];
      for (let attempt = 1; attempt <= 5; attempt++) {
        const ws = await connect(harness.url, { headers });
        sockets.push(ws);
        const error = waitFor(ws, 'error', (m) => m.payload.code.startsWith('ROOM_PASSWORD'));
        sendMessage(ws, 'join-room', { roomId: room.id, name: 'Guesser', role: 'guest', roomPassword: `guess-${attempt}` });
        const { payload } = await error;
        assert.equal(payload.code, attempt < 5 ? 'ROOM_PASSWORD_INVALID' : 'ROOM_PASSWORD_LOCKED');
      }
      const locked = await connect(harness.url, { headers });
      const lockedError = waitFor(locked, 'error', (m) => m.payload.code === 'ROOM_PASSWORD_LOCKED');
      sendMessage(locked, 'join-room', { roomId: room.id, name: 'Guesser', role: 'guest', roomPassword: 'correct horse' });
      await lockedError;

      // Someone else, elsewhere, still gets in with the right password.
      const friend = await join(harness.url, { roomId: room.id, name: 'Friend', role: 'guest', roomPassword: 'correct horse' }, { headers: { 'x-forwarded-for': '192.0.2.99' } });
      assert.equal(friend.joined.payload.participant.status, 'green-room');

      const persistent = await connect(harness.url, { headers: { 'x-forwarded-for': '192.0.2.150' } });
      const closed = new Promise((resolve) => persistent.once('close', (code) => resolve(code)));
      for (let attempt = 0; attempt < 3; attempt++) {
        const error = waitFor(persistent, 'error', (m) => m.payload.code === 'ROOM_PASSWORD_INVALID');
        sendMessage(persistent, 'join-room', { roomId: room.id, name: 'Guesser', role: 'guest', roomPassword: `wrong-${attempt}` });
        await error;
      }
      assert.equal(await closed, 1008);
    } finally {
      await harness.close();
    }
  });
});

describe('signaling rate limits', () => {
  it('relays a burst of ICE candidates far beyond the chat budget, and says when it drops messages', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('rate');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const guest = await join(harness.url, { roomId: room.id, name: 'Guest', role: 'guest' });
      const guestId = guest.joined.payload.participant.id;
      let received = 0;
      guest.ws.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'ice-candidate') received++;
      });
      const total = 240;
      for (let i = 0; i < total; i++) {
        sendMessage(host.ws, 'ice-candidate', {
          from: 'x',
          to: guestId,
          pcId: 'pc-host-1',
          toPcId: 'pc-guest-1',
          candidate: { candidate: `candidate:${i} 1 udp 2122260223 192.0.2.1 ${50000 + i} typ host`, sdpMid: '0', sdpMLineIndex: 0 },
        });
      }
      const deadline = Date.now() + 2000;
      while (received < total && Date.now() < deadline) await sleep(20);
      assert.equal(received, total);

      const limited = waitFor(host.ws, 'error', (m) => m.payload.code === 'RATE_LIMITED');
      for (let i = 0; i < 110; i++) sendMessage(host.ws, 'media-state-changed', { participantId: 'x', audioEnabled: true, videoEnabled: true, screenSharing: false });
      await limited;
    } finally {
      await harness.close();
    }
  });

  it('keeps peer-connection ids on relayed signals and refuses oversized candidates', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('pcid');
    state.room.settings.greenRoomEnabled = false;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const guest = await join(harness.url, { roomId: room.id, name: 'Guest', role: 'guest' });
      const offer = waitFor(guest.ws, 'offer');
      sendMessage(host.ws, 'offer', { from: 'x', to: guest.joined.payload.participant.id, pcId: 'pc-host-abc', sdp: { type: 'offer', sdp: 'v=0' } });
      const relayed = (await offer).payload;
      assert.equal(relayed.pcId, 'pc-host-abc');
      assert.equal(relayed.from, host.joined.payload.participant.id);

      const invalid = waitFor(host.ws, 'error', (m) => m.payload.code === 'VALIDATION_ERROR');
      sendMessage(host.ws, 'ice-candidate', { from: 'x', to: guest.joined.payload.participant.id, candidate: { candidate: 'x'.repeat(5000) } });
      await invalid;
    } finally {
      await harness.close();
    }
  });
});

describe('restarts', () => {
  it('persists recording, bans, admitted guests and the watch id, and restores them', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('persist');
    let saved;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      state.room.settings.greenRoomEnabled = false;
      await join(harness.url, { roomId: room.id, name: 'Guest', role: 'guest', joinSessionId: 'persist-guest-01' });
      const started = waitFor(host.ws, 'recording-state-changed', (m) => m.payload.recording === true);
      sendMessage(host.ws, 'recording-state-changed', { recording: true, sessionId: 'recording-take-1', performedBy: 'x' });
      await started;
      state.bannedJoinSessionIds.add('banned-browser-1');

      const { configureRoomSnapshotStore } = await import('../dist/services/signaling.js');
      configureRoomSnapshotStore({
        init: async () => {},
        loadRoomSnapshots: async () => [],
        saveRoomSnapshot: async (snapshot) => { saved = snapshot; },
        deleteRoomSnapshot: async () => {},
        close: async () => {},
      });
      const guestEntry = [...state.participants.values()].find((entry) => entry.participant.name === 'Guest');
      sendMessage(host.ws, 'stage-action', { action: 'move-to-backstage', targetParticipantId: guestEntry.participant.id, performedBy: 'x' });
      await waitFor(host.ws, 'participant-updated', (m) => m.payload.status === 'backstage');
      configureRoomSnapshotStore(null);
    } finally {
      await harness.close();
    }

    assert.ok(saved, 'a snapshot was saved');
    const normalized = normalizeRoomSnapshot(JSON.parse(JSON.stringify(saved)));
    assert.equal(normalized.sessionState.watchId, state.watchId);
    assert.equal(normalized.sessionState.recording.sessionId, 'recording-take-1');
    assert.deepEqual(normalized.sessionState.bannedJoinSessionIds, ['banned-browser-1']);
    assert.deepEqual(normalized.sessionState.returningGuests.map((g) => [g.joinSessionId, g.status, g.present]), [['persist-guest-01', 'backstage', true]]);

    // Simulate the restart: the room is gone, then restored from the snapshot.
    getRooms().delete(room.id);
    assert.equal(restoreRoomSnapshots([normalized]), 1);
    const restored = getRooms().get(room.id);
    assert.equal(restored.watchId, state.watchId);
    assert.equal(restored.recordingSessionId, 'recording-take-1');
    assert.ok(restored.recordingStartedAt);
    assert.equal(restored.bannedJoinSessionIds.has('banned-browser-1'), true);
    assert.equal(restored.recentGuestSessions.get('persist-guest-01').status, 'backstage');

    const harness2 = await createHarness();
    try {
      const host = await join(harness2.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      assert.equal(host.joined.payload.recordingState.sessionId, 'recording-take-1');
      const guest = await join(harness2.url, { roomId: room.id, name: 'Guest', role: 'guest', joinSessionId: 'persist-guest-01' });
      assert.equal(guest.joined.payload.participant.status, 'backstage', 'the admitted guest returns to their place');
      const stopped = waitFor(guest.ws, 'recording-state-changed', (m) => m.payload.recording === false);
      sendMessage(host.ws, 'recording-state-changed', { recording: false, sessionId: 'recording-take-1', performedBy: 'x' });
      assert.equal((await stopped).payload.sessionId, 'recording-take-1', 'guests learn which take to finalize');
    } finally {
      await harness2.close();
    }
  });

  it('rebuilds a forgotten studio from the host restore ticket so guests find it again', async () => {
    const harness = await createHarness();
    const { room, hostToken, state } = makeRoom('restore-ticket', { password: 'letmein' });
    const watchId = state.watchId;
    try {
      const host = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken });
      const ticket = host.joined.payload.restoreTicket;
      assert.equal(typeof ticket, 'string');
      host.ws.close(1000);
      await sleep(50);

      // The server restarted without a database: the studio is gone.
      getRooms().delete(room.id);
      const guestBefore = await connect(harness.url);
      const notFound = waitFor(guestBefore, 'error', (m) => m.payload.code === 'ROOM_NOT_FOUND');
      sendMessage(guestBefore, 'join-room', { roomId: room.id, name: 'Guest', role: 'guest', roomPassword: 'letmein' });
      await notFound;

      // A ticket with the wrong host token does nothing.
      const impostor = await connect(harness.url);
      const impostorRefused = waitFor(impostor, 'error', (m) => m.payload.code === 'ROOM_NOT_FOUND');
      sendMessage(impostor, 'join-room', { roomId: room.id, name: 'Impostor', role: 'host', hostToken: 'x'.repeat(32), restoreTicket: ticket });
      await impostorRefused;
      assert.equal(getRooms().has(room.id), false);

      const back = await join(harness.url, { roomId: room.id, name: 'Arnold', role: 'host', hostToken, restoreTicket: ticket });
      assert.equal(back.joined.payload.participant.role, 'host');
      assert.equal(back.joined.payload.watchId, watchId, 'the watch link keeps working');
      const rebuilt = getRooms().get(room.id);
      assert.equal(rebuilt.room.settings.passwordProtected, true);

      sendMessage(guestBefore, 'join-room', { roomId: room.id, name: 'Guest', role: 'guest', roomPassword: 'letmein' });
      const guestJoined = await waitFor(guestBefore, 'room-joined');
      assert.equal(guestJoined.payload.participant.status, 'green-room');
    } finally {
      await harness.close();
    }
  });
});
