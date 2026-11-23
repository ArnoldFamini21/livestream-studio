import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configureRoomSnapshotStore, createRoom, findWatchLinkRoom, issuePremiereSetup,
} from '../dist/services/signaling.js';
import { normalizeRoomSnapshot } from '../dist/services/roomPersistence.js';

test('only a private scheduled studio with durable state can issue premiere setup grants', async (t) => {
  const now = Date.now();
  const scheduledFor = new Date(now + 60_000).toISOString();
  const roomOptions = { creatorIp: '127.0.0.88', status: 'scheduled', scheduledFor };
  const { room, hostToken } = createRoom('Private premiere', 'Host', { ...roomOptions, privateWatch: true });
  const publicShow = createRoom('Scheduled live show', 'Host', { ...roomOptions, registrationEnabled: true });
  assert.equal((await issuePremiereSetup(room.id, 'unrelated-token', now)).status, 'forbidden');
  assert.equal((await issuePremiereSetup(publicShow.room.id, publicShow.hostToken, now)).status, 'ineligible');
  assert.equal((await issuePremiereSetup(room.id, hostToken, now)).status, 'unavailable');

  const snapshots = [];
  configureRoomSnapshotStore({ saveRoomSnapshot: async snapshot => snapshots.push(normalizeRoomSnapshot(snapshot)) });
  t.after(() => configureRoomSnapshotStore(null));
  const ready = await issuePremiereSetup(room.id, hostToken, now);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.startsAt, Date.parse(scheduledFor));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].room.premiere, true);
  assert.equal(findWatchLinkRoom(ready.watchId).room.premiere, true);
  assert.notEqual(ready.watchId, room.id);
  assert.equal((await issuePremiereSetup(room.id, hostToken, Date.parse(scheduledFor))).status, 'ineligible');
});
