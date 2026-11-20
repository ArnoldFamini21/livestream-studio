import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { watchRouter } from '../dist/routes/watch.js';
import { createRoom, getRooms, setupSignalingServer } from '../dist/services/signaling.js';
import { getWatchAccessSecret, issueWatchGrant } from '../dist/services/watchAccess.js';

test('protected events require a private link and approve call-ins into the green room only', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/watch', watchRouter);
  const server = http.createServer(app);
  const sockets = new WebSocketServer({ server });
  setupSignalingServer(sockets);
  await new Promise((resolve) => server.listen(0, resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  const { room, hostToken } = createRoom('Private rehearsal', 'Host', {
    creatorIp: 'private-watch-events-test', privateWatch: true, password: 'rehearsal-pass',
  });
  const watchId = getRooms().get(room.id).watchId;
  const watch = origin + '/watch/' + watchId;
  const join = async (role, proofs) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:'));
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
    const take = async (type, match = () => true) => {
      for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
        const index = messages.findIndex((message) => message.type === type && match(message.payload));
        if (index >= 0) return messages.splice(index, 1)[0].payload;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('No ' + type + ' message');
    };
    send('join-room', { roomId: room.id, name: role === 'host' ? 'Host' : 'Guest', role, capabilities: ['watch-events'], ...proofs });
    return { joined: await take('room-joined'), send, take };
  };

  const host = await join('host', { hostToken });
  const guest = await join('guest', { roomPassword: 'rehearsal-pass' });
  const post = (path, body, headers = {}) => fetch(watch + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const register = (invite) => post('/registrants', { name: 'Viewer', email: 'viewer@example.com', invite });
  assert.equal((await (await fetch(watch)).json()).registration.inviteOnly, true);
  assert.equal((await register()).status, 403);
  const secret = getWatchAccessSecret();
  assert.ok(secret);
  assert.equal((await register(issueWatchGrant('watch-invite', 'other-watch-id', secret).token)).status, 403);
  assert.equal((await register(issueWatchGrant('watch-invite', watchId, secret, Date.now() - 1).token)).status, 403);
  assert.equal((await fetch(watch + '/live')).status, 401);
  assert.equal((await fetch(watch + '/poll')).status, 401);
  assert.equal((await fetch(watch + '/captions')).status, 401);
  host.send('watch-invite-request', { requestId: 'check-watch-link' });
  const invite = await host.take('watch-invite-issued');
  assert.equal(invite.requestId, 'check-watch-link');
  assert.ok(invite.token);
  assert.equal((await fetch(watch + '/live', { headers: { Authorization: 'Bearer ' + invite.token } })).status, 401);
  const registration = await register(invite.token);
  assert.equal(registration.status, 201);
  const { access } = await registration.json();
  const headers = { Authorization: 'Bearer ' + access.token };
  assert.doesNotMatch(Buffer.from(access.token.split('.')[0], 'base64url').toString(), /viewer@example.com/);
  assert.ok(Date.parse(access.expiresAt) <= Date.parse(invite.expiresAt));
  for (const route of ['/live', '/poll', '/captions']) assert.equal((await fetch(watch + route, { headers })).status, 200);
  host.send('live-stream-token-request', { requestId: 'watch-relay' });
  const credential = await host.take('live-stream-token-issued');
  const claims = JSON.parse(Buffer.from(credential.token.split('.')[0], 'base64url').toString());
  assert.equal(claims.protectedWatchId, watchId);
  assert.equal(claims.watchId, undefined);

  const ask = (accessHeaders = headers) => post('/call-ins', {
    viewerId: 'viewer-session-valid-one', name: 'Sarah', note: 'Question about the reading',
  }, accessHeaders);
  assert.equal((await ask()).status, 403, 'call-ins are opt-in');
  guest.send('watch-event-settings', { callInsEnabled: true });
  assert.equal((await guest.take('error')).code, 'UNAUTHORIZED');
  host.send('watch-event-settings', { callInsEnabled: true });
  await host.take('watch-event-state', (value) => value.callInsEnabled);
  assert.equal((await ask({})).status, 401);
  const requested = await ask();
  assert.equal(requested.status, 201);
  const { id, key } = await requested.json();
  const queue = await host.take('watch-event-state', (value) => value.callIns.length === 1);
  assert.deepEqual(queue.callIns, [{ id, name: 'Sarah', note: 'Question about the reading' }]);
  const path = '/call-ins/' + id;
  assert.equal((await fetch(watch + path, { headers })).status, 404, 'another viewer cannot read the request');
  const read = () => fetch(watch + path, { headers: { ...headers, 'X-Watch-Call-Key': key } }).then((response) => response.json());
  assert.deepEqual(await read(), { state: 'waiting' });
  assert.equal((await ask()).status, 429);
  guest.send('watch-call-in-decide', { id, decision: 'approve' });
  assert.equal((await guest.take('error')).code, 'UNAUTHORIZED');
  assert.deepEqual(await read(), { state: 'waiting' });
  host.send('watch-call-in-decide', { id, decision: 'approve' });
  await host.take('watch-event-state', (value) => value.callIns.length === 0);
  const approved = await read();
  assert.equal(approved.state, 'approved');
  assert.equal(approved.roomId, room.id);
  const caller = await join('guest', { guestInviteToken: approved.guestInvite, joinSessionId: 'audience-seat-check' });
  assert.equal(caller.joined.participant.status, 'green-room');
  assert.equal(caller.joined.stageReadToken, undefined);
});
