import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import { RECORDING_RECOVERY_TTL_MS, recordingRecoveryHostScope } from '@studio/shared';
import WebSocket, { WebSocketServer } from 'ws';
import { createRoom, getRooms, setupSignalingServer } from '../dist/services/signaling.js';

test('authorized opt-in grants recovery only to guest seats captured in the persisted take', async (t) => {
  const secret = 'test-recording-recovery-long-secret';
  const previous = { LIVE_STREAM_TOKEN_SECRET: process.env.LIVE_STREAM_TOKEN_SECRET, MEDIA_SERVER_URL: process.env.MEDIA_SERVER_URL };
  const requests = [];
  const media = http.createServer(async (req, res) => {
    if (req.url !== '/recording-recovery/takes') { res.writeHead(204).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ token: req.headers.authorization.replace(/^Bearer /, ''), body });
    res.writeHead(201, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ expiresAt: new Date(body.expiresAtMs).toISOString(), participants: body.participants }));
  });
  await new Promise(resolve => media.listen(0, '127.0.0.1', resolve));
  process.env.LIVE_STREAM_TOKEN_SECRET = secret;
  process.env.MEDIA_SERVER_URL = 'http://127.0.0.1:' + media.address().port;
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  setupSignalingServer(sockets);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { room, hostToken } = createRoom('Private recording recovery', 'Producer', {
    creatorIp: 'recovery-rehearsal', createdByOwner: true,
  });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => { media.close(resolve); media.closeAllConnections(); });
    getRooms().delete(room.id);
  });

  async function join(role, name, proof) {
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
    const inbox = [];
    ws.on('message', data => inbox.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
    async function receive(type, accepts = () => true) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const index = inbox.findIndex(message => message.type === type && accepts(message.payload));
        if (index !== -1) return inbox.splice(index, 1)[0].payload;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Missing signal ' + type);
    }
    send('join-room', { roomId: room.id, role, name, ...proof });
    const { participant: { id } } = await receive('room-joined');
    return { id, send, receive, inbox };
  }
  const host = await join('host', 'Producer', { hostToken });
  const guest = await join('guest', 'Guest Camera', { joinSessionId: 'recovery-camera', cameraOnly: true });
  const observer = await join('guest', 'Waiting', { joinSessionId: 'waiting-guest' });
  const crew = await join('guest', 'Crew', { joinSessionId: 'recovery-crew' });
  const stage = async (seat, action, accepts) => {
    host.send('stage-action', { action, targetParticipantId: seat.id, performedBy: host.id });
    await host.receive('participant-updated', payload => payload.id === seat.id && accepts(payload));
  };
  await stage(guest, 'move-to-stage', participant => participant.status === 'on-stage');
  await stage(crew, 'move-to-stage', participant => participant.status === 'on-stage');
  await stage(crew, 'promote-co-host', participant => participant.role === 'co-host');
  const takeId = 'recording-guest-private-take';

  host.send('recording-state-changed', { recording: true, sessionId: 'recording-local-only-take', performedBy: host.id });
  await host.receive('recording-state-changed', state => state.recording);
  host.send('recording-state-changed', { recording: false, sessionId: 'recording-local-only-take', performedBy: host.id });
  await host.receive('recording-state-changed', state => !state.recording);
  assert.equal(requests.length, 0);

  host.send('recording-state-changed', { recording: true, sessionId: takeId, performedBy: host.id, privateRecovery: true });
  const state = await host.receive('recording-recovery-state');
  const grant = await guest.receive('recording-recovery-grant');
  assert.equal(state.status, 'ready');
  assert.equal(state.takeId, takeId);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.participants, [{ participantId: guest.id, participantName: 'Guest Camera' }]);
  assert.equal(requests[0].body.expiresAtMs - requests[0].body.createdAtMs, RECORDING_RECOVERY_TTL_MS);
  const parts = grant.token.split('.');
  const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  assert.equal(parts[1], createHmac('sha256', secret).update(parts[0]).digest('base64url'));
  assert.equal(claims.purpose, 'recording-recovery-upload');
  assert.equal(claims.storageId, createHmac('sha256', secret).update(recordingRecoveryHostScope(room.id, takeId, hostToken)).digest('hex'));
  assert.equal(claims.participantId, guest.id);
  assert.equal(claims.exp, requests[0].body.expiresAtMs);

  observer.send('recording-recovery-grant-request', { takeId });
  crew.send('recording-recovery-grant-request', { takeId });
  guest.send('recording-recovery-grant-request', { takeId });
  assert.deepEqual(await guest.receive('recording-recovery-grant'), grant);
  for (const seat of [observer, crew, host]) {
    assert.equal(seat.inbox.some(message => message.type === 'recording-recovery-grant'), false);
  }
});
