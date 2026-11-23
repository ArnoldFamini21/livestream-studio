import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { watchRouter } from '../dist/routes/watch.js';
import {
  configureRoomSnapshotStore,
  createRoom,
  getRooms,
  restoreRoomSnapshots,
  setupSignalingServer,
} from '../dist/services/signaling.js';

test('the production rundown is private, revisioned, and restores its next cue', async (t) => {
  const app = express();
  app.use('/watch', watchRouter);
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ server });
  setupSignalingServer(sockets);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const snapshots = new Map();
  configureRoomSnapshotStore({
    init: async () => {},
    loadRoomSnapshots: async () => [],
    saveRoomSnapshot: async snapshot => { snapshots.set(snapshot.room.id, snapshot); },
    deleteRoomSnapshot: async () => {},
    close: async () => {},
  });

  const { room, hostToken } = createRoom('Rundown rehearsal', 'Test Host', { creatorIp: 'rundown-test' });
  const watchId = getRooms().get(room.id).watchId;
  const restoredId = 'restored-rundown';
  t.after(async () => {
    configureRoomSnapshotStore(null);
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    getRooms().delete(room.id);
    getRooms().delete(restoredId);
  });

  async function join(role, proofs = {}, roomId = room.id) {
    const ws = new WebSocket(origin.replace('http:', 'ws:'));
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
    const take = async (type, predicate = () => true) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(message => message.type === type && predicate(message.payload));
        if (index !== -1) return messages.splice(index, 1)[0].payload;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error('No ' + type + ' message');
    };
    send('join-room', { roomId, name: role === 'host' ? 'Host' : 'Crew', role, capabilities: ['production-rundown'], ...proofs });
    return { joined: await take('room-joined'), messages, send, take };
  }

  const host = await join('host', { hostToken });
  assert.equal(host.joined.features.productionRundown, true);
  assert.equal(host.joined.productionRundown.revision, 0);
  const producer = await join('guest', { joinSessionId: 'producer-browser' });
  const guest = await join('guest', { joinSessionId: 'ordinary-guest' });
  assert.equal(guest.joined.productionRundown, undefined);
  assert.equal(producer.joined.productionRundown, undefined);

  const stage = (action, target) => host.send('stage-action', {
    action, targetParticipantId: target.joined.participant.id, performedBy: host.joined.participant.id,
  });
  const secretNotes = 'Private direction for the production team';
  const item = { id: 'opening', title: 'Opening', sceneName: 'Welcome', notes: secretNotes };
  const request = (operator, requestId, baseRevision, command) => {
    operator.send('production-rundown-update', { requestId, baseRevision, ...command });
    return operator.take('production-rundown-state', payload => payload.requestId === requestId);
  };

  guest.send('production-rundown-update', { requestId: 'guest-try', baseRevision: 0, action: 'save-item', item });
  assert.equal((await guest.take('error')).code, 'UNAUTHORIZED');
  stage('promote-co-host', producer);
  await producer.take('participant-updated', person => person.id === producer.joined.participant.id && person.role === 'co-host');
  producer.send('production-rundown-update', { requestId: 'waiting-try', baseRevision: 0, action: 'save-item', item });
  assert.equal((await producer.take('error')).code, 'PARTICIPANT_NOT_ADMITTED');
  stage('move-to-backstage', producer);
  const admitted = await producer.take('room-joined');
  assert.equal(admitted.participant.role, 'co-host');

  const save = await request(producer, 'producer-save', 0, { action: 'save-item', item });
  assert.deepEqual(save.rundown.items, [item]);
  const delivered = await host.take('production-rundown-state', payload => payload.rundown.revision === 1);
  assert.equal(delivered.requestId, undefined);
  assert.equal(delivered.rundown.items[0].notes, secretNotes);
  const conflict = await request(host, 'stale-save', 0, { action: 'save-item', item: { ...item, title: 'Stale replacement' } });
  assert.match(conflict.error, /rundown changed/i);
  assert.equal(conflict.rundown.items[0].title, 'Opening');

  const cue = await request(producer, 'producer-cue', 1, { action: 'cue-item', itemId: item.id });
  assert.equal(cue.rundown.cueItemId, item.id);
  await host.take('production-rundown-state', payload => payload.rundown.cueItemId === item.id);
  assert.equal(getRooms().get(room.id).stageContent, undefined, 'a cue does not apply a scene');
  const unauthorizedTake = await request(producer, 'producer-take', 2, { action: 'take-item', itemId: item.id });
  assert.match(unauthorizedTake.error, /stage owner/);
  assert.equal(unauthorizedTake.rundown.revision, 2);
  const publicWatch = await fetch(origin + '/watch/' + watchId);
  assert.equal(publicWatch.status, 200);
  assert.equal((await publicWatch.text()).includes(secretNotes), false);
  // A fresh admitted guest snapshot also omits the rundown.
  stage('move-to-backstage', guest);
  assert.equal((await guest.take('room-joined')).productionRundown, undefined);
  assert.ok(guest.messages.every(message => !JSON.stringify(message).includes(secretNotes)));

  const saved = snapshots.get(room.id);
  assert.equal(saved.sessionState.productionRundown.cueItemId, item.id);
  assert.equal(restoreRoomSnapshots([{ ...saved, room: { ...saved.room, id: restoredId } }]), 1);
  const restored = await join('host', { hostToken }, restoredId);
  assert.deepEqual(restored.joined.productionRundown, cue.rundown);

  const taken = await request(host, 'host-take', 2, { action: 'take-item', itemId: item.id });
  assert.equal(taken.rundown.cueItemId, null);
  assert.equal(taken.rundown.lastTakenItemId, item.id);
  await producer.take('production-rundown-state', payload => payload.rundown.lastTakenItemId === item.id);

  stage('demote-to-guest', producer);
  await producer.take('participant-updated', person => person.id === producer.joined.participant.id && person.role === 'guest');
  producer.send('production-rundown-update', { requestId: 'former-producer', baseRevision: 3, action: 'cue-item', itemId: item.id });
  assert.equal((await producer.take('error')).code, 'UNAUTHORIZED');
});
