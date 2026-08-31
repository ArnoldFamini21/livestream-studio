import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  configureRoomSnapshotStore,
  createRoom,
  getRooms,
  restoreRoomSnapshots,
  setupSignalingServer,
} from '../dist/services/signaling.js';
import { normalizeRoomSnapshot } from '../dist/services/roomPersistence.js';

async function createSignalingHarness() {
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

async function connectClient(url, options = undefined) {
  const ws = new WebSocket(url, options);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function waitForMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5000);
    const onMessage = (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (parsed.type !== type) return;
      cleanup();
      resolve(parsed);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
  });
}

/** Captures whatever the signaling server persists, like the PostgreSQL store would. */
function createCapturingStore() {
  const snapshots = new Map();
  return {
    snapshots,
    latest(roomId) {
      return snapshots.get(roomId) ?? null;
    },
    async init() {},
    async loadRoomSnapshots() {
      return Array.from(snapshots.values());
    },
    async saveRoomSnapshot(snapshot) {
      snapshots.set(snapshot.room.id, snapshot);
    },
    async deleteRoomSnapshot(roomId) {
      snapshots.delete(roomId);
    },
    async close() {},
  };
}

async function issueGuestInvite(harnessUrl, room, creatorIp) {
  const host = await connectClient(harnessUrl, { headers: { 'x-forwarded-for': creatorIp } });
  const joined = waitForMessage(host, 'room-joined');
  host.send(JSON.stringify({
    type: 'join-room',
    payload: { roomId: room.id, name: 'Arnold', role: 'host', hostToken: room.hostToken },
  }));
  await joined;

  const issued = waitForMessage(host, 'guest-invite-token-issued');
  host.send(JSON.stringify({
    type: 'guest-invite-token-request',
    payload: { requestId: 'req-1' },
  }));
  const message = await issued;
  host.terminate();
  return message.payload.token;
}

/** Drops the live room the way a process restart would, keeping only what was persisted. */
function simulateRestart(roomId, snapshot) {
  getRooms().delete(roomId);
  assert.equal(getRooms().has(roomId), false);
  const restored = restoreRoomSnapshots([snapshot]);
  assert.equal(restored, 1);
}

async function joinAsGuest(harnessUrl, roomId, token) {
  const guest = await connectClient(harnessUrl);
  const joined = waitForMessage(guest, 'room-joined');
  const failed = waitForMessage(guest, 'error');
  guest.send(JSON.stringify({
    type: 'join-room',
    payload: { roomId, name: 'Priya', role: 'guest', guestInviteToken: token },
  }));
  const outcome = await Promise.race([
    joined.then(() => ({ ok: true })),
    failed.then((message) => ({ ok: false, code: message.payload?.code })),
  ]);
  guest.terminate();
  return outcome;
}

describe('guest invite link persistence', () => {
  it('keeps an emailed invite working across a restart, but only once', async () => {
    const store = createCapturingStore();
    configureRoomSnapshotStore(store);
    const harness = await createSignalingHarness();
    const creatorIp = '198.51.100.40';

    try {
      const { room } = createRoom('Invite persistence test', 'Arnold', {
        creatorIp,
        settings: { passwordProtected: true },
        password: 'correct horse battery',
      });

      const token = await issueGuestInvite(harness.url, room, creatorIp);
      assert.ok(token.length >= 20);

      // The invite must reach the store, since that is all a restart has left.
      const snapshot = store.latest(room.id);
      assert.ok(snapshot, 'the invite was never persisted');
      const invites = snapshot.invites || [];
      assert.equal(invites.length, 1);
      assert.equal(invites[0].kind, 'guest');

      // What is stored is a digest, so a leaked snapshot is not a working link.
      assert.notEqual(invites[0].tokenHash, token);
      assert.equal(invites[0].tokenHash, createHash('sha256').update(token).digest('base64url'));

      simulateRestart(room.id, snapshot);

      // The link still opens the password-protected room after the restart.
      const first = await joinAsGuest(harness.url, room.id, token);
      assert.equal(first.ok, true, `expected the restored invite to work, got ${first.code}`);

      // And it is spent: single use survives the restart rather than resetting.
      const second = await joinAsGuest(harness.url, room.id, token);
      assert.equal(second.ok, false);
      assert.equal(second.code, 'GUEST_INVITE_INVALID');

      // The consumption was persisted too, so a second restart cannot revive it.
      const afterUse = store.latest(room.id);
      assert.deepEqual(afterUse.invites || [], []);
    } finally {
      await harness.close();
      configureRoomSnapshotStore(null);
    }
  });

  it('drops invites that expired while the server was down', async () => {
    const store = createCapturingStore();
    configureRoomSnapshotStore(store);
    const harness = await createSignalingHarness();
    const creatorIp = '198.51.100.41';

    try {
      const { room } = createRoom('Invite expiry test', 'Arnold', { creatorIp });
      const token = await issueGuestInvite(harness.url, room, creatorIp);
      const snapshot = store.latest(room.id);
      assert.equal((snapshot.invites || []).length, 1);

      const expired = {
        ...snapshot,
        invites: [{ ...snapshot.invites[0], expiresAt: new Date(Date.now() - 60_000).toISOString() }],
      };
      simulateRestart(room.id, expired);

      const outcome = await joinAsGuest(harness.url, room.id, token);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, 'GUEST_INVITE_INVALID');
    } finally {
      await harness.close();
      configureRoomSnapshotStore(null);
    }
  });
});

describe('persisted invite validation', () => {
  const base = {
    room: {
      id: 'room-invite-1',
      name: 'Invite room',
      createdAt: '2026-07-03T10:00:00.000Z',
      status: 'waiting',
      settings: {},
      registration: {},
    },
    hostToken: 'host-token-abcdefghijklmnop',
    creatorIp: '198.51.100.42',
    hasBeenJoined: false,
  };
  const digest = createHash('sha256').update('a-real-invite-token-value').digest('base64url');

  it('keeps well-formed invite digests', () => {
    const normalized = normalizeRoomSnapshot({
      ...base,
      invites: [{
        kind: 'co-host',
        tokenHash: digest,
        issuedBy: 'participant-1',
        createdAt: '2026-07-03T10:00:00.000Z',
        expiresAt: '2026-07-04T10:00:00.000Z',
      }],
    });
    assert.equal(normalized.invites.length, 1);
    assert.equal(normalized.invites[0].kind, 'co-host');
    assert.equal(normalized.invites[0].tokenHash, digest);
  });

  it('refuses anything that is not a digest, so a raw token cannot be stored', () => {
    const normalized = normalizeRoomSnapshot({
      ...base,
      invites: [
        // A raw nanoid(32) token is 32 chars, not a 43-char digest.
        { kind: 'guest', tokenHash: 'V1StGXR8Z5jdHi6BmyT0aBcDeFgHiJkL', issuedBy: 'p', createdAt: base.room.createdAt, expiresAt: '2026-07-04T10:00:00.000Z' },
        { kind: 'guest', tokenHash: digest, issuedBy: 'p', createdAt: base.room.createdAt, expiresAt: 'not-a-date' },
        { kind: 'nonsense', tokenHash: digest, issuedBy: 'p', createdAt: base.room.createdAt, expiresAt: '2026-07-04T10:00:00.000Z' },
        'not-an-object',
      ],
    });
    assert.equal(normalized.invites, undefined);
  });
});
