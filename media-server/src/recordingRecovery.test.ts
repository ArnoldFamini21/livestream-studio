import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { test } from 'node:test';
import { RECORDING_RECOVERY_TTL_MS, recordingRecoveryHostScope, type RecordingRecoveryTrack } from '@studio/shared';
import { getLiveStreamTokenSecret, signLiveStreamToken } from './auth.js';
import { createRecordingRecoveryHandler } from './recordingRecovery.js';

const origin = 'https://studio.example';
const secret = getLiveStreamTokenSecret()!;
const roomId = 'private-studio';
const takeId = 'recording-monday';
const hostToken = 'recording-host-private-token-test';
const storageId = createHmac('sha256', secret).update(recordingRecoveryHostScope(roomId, takeId, hostToken)).digest('hex');
const participants = [{ participantId: 'guest-one', participantName: 'Alex' }, { participantId: 'guest-two', participantName: 'Sam' }];
const delta = RECORDING_RECOVERY_TTL_MS;
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closing;
    },
  };
}

async function startObjectStore(missingReadStatus = 404) {
  const files = new Map<string, { bytes: Buffer; version: string; offset?: string; checksum?: string }>();
  let publicRead = false;
  let enforceConditions = true;
  let interruptNextIndex = false;
  const server = await listen(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://storage').pathname;
    const previous = files.get(path);
    if (!req.headers.authorization && !publicRead) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'PUT') {
      if (!previous) {
        res.writeHead(missingReadStatus).end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': previous.bytes.length,
        ETag: previous.version,
        ...(previous.offset && previous.checksum ? {
          'x-amz-meta-recording-offset': previous.offset,
          'x-amz-meta-recording-sha256': previous.checksum,
        } : {}),
      }).end(req.method === 'GET' ? previous.bytes : undefined);
      return;
    }
    const buffers: Buffer[] = [];
    for await (const bytes of req) buffers.push(Buffer.from(bytes));
    const data = Buffer.concat(buffers);
    // Conditions are checked after the body arrives, in the same logical write.
    const existing = files.get(path);
    if (enforceConditions && (
      (req.headers['if-none-match'] === '*' && existing) ||
      (req.headers['if-match'] && req.headers['if-match'] !== existing?.version)
    )) {
      res.writeHead(412).end();
      return;
    }
    if (interruptNextIndex && path.endsWith('/tracks.json') && existing) {
      interruptNextIndex = false;
      res.writeHead(500).end();
      return;
    }
    const offset = req.headers['x-amz-meta-recording-offset'];
    const checksum = req.headers['x-amz-meta-recording-sha256'];
    assert.equal(req.headers['x-amz-content-sha256'], sha256(data));
    if (checksum) {
      assert.equal(checksum, sha256(data));
      assert.match(String(req.headers.authorization), /x-amz-meta-recording-offset;x-amz-meta-recording-sha256,/);
    }
    const version = `"${sha256(data)}"`;
    files.set(path, { bytes: data, version,
      ...(typeof offset === 'string' && typeof checksum === 'string' ? { offset, checksum } : {}),
    });
    res.writeHead(200, { ETag: version }).end();
  });
  return {
    server, files,
    setPublic: () => { publicRead = true; },
    ignoreConditions: () => { enforceConditions = false; },
    interruptNextIndex: () => { interruptNextIndex = true; },
    env: {
      NODE_ENV: 'test', RECORDING_RECOVERY_ENABLED: 'true', RECORDING_STORAGE_ENDPOINT: server.url,
      RECORDING_STORAGE_BUCKET: 'media', RECORDING_STORAGE_ACCESS_KEY_ID: 'test-key',
      RECORDING_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
    },
  };
}

async function startMedia(env: NodeJS.ProcessEnv, clock = Date.now) {
  const handler = createRecordingRecoveryHandler({
    env, clock,
    applyCors: req => req.headers.origin === origin,
    writeJson: (res, status, payload) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)),
  });
  return listen((req, res) => { void handler(req, res, new URL(req.url || '/', 'http://media')); });
}

test('offline guest upload adopts only verified contiguous bytes across retries and media restarts', async (t) => {
  const store = await startObjectStore();
  t.after(store.server.close);
  let now = Date.now();
  const createdAtMs = now;
  const expiresAtMs = now + delta;
  let media = await startMedia(store.env, () => now);
  t.after(() => media.close());
  const claims = { v: 1 as const, roomId, takeId, storageId };
  const setup = signLiveStreamToken({ ...claims, purpose: 'recording-recovery-create', exp: now + 30_000 }, secret);
  const token = (participantId: string) => signLiveStreamToken({
    ...claims, purpose: 'recording-recovery-upload', participantId, exp: expiresAtMs,
  }, secret);
  const url = () => `${media.url}/recording-recovery/rooms/${roomId}/takes/${takeId}`;
  const upload = { Origin: origin, Authorization: `Bearer ${token(participants[0].participantId)}` };
  const host = { Origin: origin, 'x-host-token': hostToken };
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const start = () => post(`${media.url}/recording-recovery/takes`, { createdAtMs, expiresAtMs, participants }, { Authorization: `Bearer ${setup}` });
  const chunk = (data: string, sequence: number, offset: number, checksum = sha256(data)) => fetch(
    `${url()}/upload/tracks/alex-camera/chunks?sequence=${sequence}&offset=${offset}&sha256=${checksum}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...upload }, body: data },
  );

  const ready = await fetch(`${media.url}/recording-recovery/capability`, { headers: { Origin: origin } });
  assert.deepEqual(await ready.json(), { ready: true });
  assert.equal((await start()).status, 201);
  const first = await start();
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { expiresAt: new Date(expiresAtMs).toISOString(), participants });
  const registration = await post(`${url()}/upload/tracks`, {
    trackId: 'alex-camera', label: 'Alex camera', mimeType: 'video/webm;codecs=vp9,opus', kind: 'iso',
  }, upload);
  assert.equal(registration.status, 200);
  assert.equal((await registration.json() as RecordingRecoveryTrack).nextSequence, 0);
  assert.equal((await chunk('first', 0, 0, sha256('bad'))).status, 422);
  assert.equal((await chunk('late', 1, 5)).status, 409);
  const before = await fetch(`${url()}/participants/guest-one/tracks/alex-camera`, { headers: host });
  assert.equal(before.status, 409);
  assert.equal((await fetch(`${url()}/upload`, { headers: { ...upload, Authorization: `Bearer ${token('wrong-guest')}` } })).status, 403);
  assert.equal((await fetch(`${url().replace(takeId, 'another-take')}/upload`, { headers: upload })).status, 401);
  assert.equal((await fetch(`${url()}/upload`, { headers: { ...upload, Authorization: `Bearer ${setup}` } })).status, 401);
  assert.equal((await fetch(url(), { headers: upload })).status, 401);
  assert.equal((await fetch(url(), { headers: { ...host, 'x-host-token': 'some-different-private-token' } })).status, 404);
  assert.equal((await fetch(url(), { headers: { ...host, Origin: 'https://that-is-not-studio.example' } })).status, 403);

  // Store the bytes, then fail the offset index update to simulate a crash
  // between receipt creation and the upload acknowledgement.
  store.interruptNextIndex();
  const interrupted = await chunk('first', 0, 0);
  assert.equal(interrupted.status, 502);
  assert.equal([...store.files.keys()].filter(key => key.endsWith('/alex-camera/0')).length, 1);
  await media.close();
  media = await startMedia(store.env, () => now);
  const status = await fetch(`${url()}/upload`, { headers: upload });
  assert.equal((await status.json() as { tracks: RecordingRecoveryTrack[] }).tracks[0].receivedBytes, 0);
  const adopted = await chunk('first', 0, 0);
  assert.equal(adopted.status, 200);
  assert.equal((await adopted.json() as RecordingRecoveryTrack).receivedBytes, 5);
  assert.equal((await chunk('first', 0, 0)).status, 200);
  assert.equal((await chunk('other', 0, 0)).status, 409);

  const writers = await Promise.all([chunk('second', 1, 5), chunk('second', 1, 5)]);
  assert.deepEqual(writers.map(response => response.status), [200, 200]);
  assert.equal((await post(`${url()}/upload/tracks/alex-camera/complete`, { totalBytes: 5, chunkCount: 1 }, upload)).status, 409);
  const completed = await post(`${url()}/upload/tracks/alex-camera/complete`, {
    totalBytes: 11, chunkCount: 2, capture: { sourceId: 'alex-camera', timeline: { startMs: createdAtMs } },
  }, upload);
  assert.equal(completed.status, 200);
  assert.equal((await completed.json() as RecordingRecoveryTrack).status, 'verified');
  assert.equal((await post(`${url()}/upload/tracks/alex-camera/complete`, { totalBytes: 11, chunkCount: 2 }, upload)).status, 200);
  assert.equal((await chunk('new', 2, 11)).status, 409);

  const otherGuest = await fetch(`${url()}/upload`, { headers: {
    Origin: origin, Authorization: `Bearer ${token(participants[1].participantId)}`,
  } });
  assert.deepEqual((await otherGuest.json() as { tracks: unknown[] }).tracks, []);
  const manifest = await fetch(url(), { headers: host });
  const view = await manifest.json() as { participants: unknown[]; tracks: RecordingRecoveryTrack[] };
  assert.deepEqual(view.participants, participants);
  assert.equal(view.tracks.length, 1);
  assert.equal(view.tracks[0].status, 'verified');
  assert.equal(view.tracks[0].nextSequence, 2);
  const download = await fetch(`${url()}/participants/guest-one/tracks/alex-camera`, { headers: host });
  assert.equal(await download.text(), 'firstsecond');
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="Alex camera.webm"');
  const object = [...store.files].find(([key]) => key.endsWith('/alex-camera/1'))?.[1];
  assert.ok(object);
  object.bytes = Buffer.from('tamper');
  const tampered = await fetch(`${url()}/participants/guest-one/tracks/alex-camera`, { headers: host });
  await assert.rejects(tampered.arrayBuffer());
  now = expiresAtMs;
  assert.equal((await fetch(`${url()}/upload`, { headers: upload })).status, 401);
  assert.equal((await fetch(url(), { headers: host })).status, 410);
});

test('recovery fails closed when storage is public, unconfigured or lacks required object semantics', async (t) => {
  const storage = await startObjectStore();
  t.after(storage.server.close);
  const ready = async (env: NodeJS.ProcessEnv) => {
    const media = await startMedia(env);
    try {
      const response = await fetch(`${media.url}/recording-recovery/capability`, { headers: { Origin: origin } });
      return await response.json();
    } finally { await media.close(); }
  };
  assert.deepEqual(await ready({ ...storage.env, RECORDING_RECOVERY_ENABLED: 'false' }), { ready: false });
  assert.deepEqual(await ready({ ...storage.env, RECORDING_STORAGE_PUBLIC_BASE_URL: storage.server.url }), { ready: false });
  const storageWithoutMissingReads = await startObjectStore(403);
  t.after(storageWithoutMissingReads.server.close);
  assert.deepEqual(await ready(storageWithoutMissingReads.env), { ready: false });
  storage.setPublic();
  assert.deepEqual(await ready(storage.env), { ready: false });
  storage.ignoreConditions();
  assert.deepEqual(await ready(storage.env), { ready: false });
});
