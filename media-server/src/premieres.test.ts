import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ffmpegStatic from 'ffmpeg-static';
import { signLiveStreamToken } from './auth.js';
import { createPremiereHandler, parsePremiereMediaInfo } from './premieres.js';

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

test('an offline premiere commits one durable MP4 and serves protected ranges only during the scheduled window', async (t) => {
  const watchId = 'premiereWatcher1';
  const wrongWatchId = 'premiereWatcher2';
  const origin = 'https://studio.example';
  const secret = 'test-premiere-secret-longer-than-32-characters';
  const ffmpeg = process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg';
  const objects = new Map<string, Buffer>();
  const startsAt = Date.now() + 60_000;
  let now = startsAt - 1_000;
  const bucket = await listen(async (req, res) => {
    const target = new URL(req.url || '/', 'http://test');
    const key = target.pathname;
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      if (key.endsWith('/manifest.json')) {
        assert.equal(req.headers['if-none-match'], '*');
        assert.match(String(req.headers.authorization), /SignedHeaders=host;if-none-match;/);
        if (objects.has(key)) return void res.writeHead(412).end();
      }
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200).end();
      return;
    }
    const body = objects.get(key);
    if (!body) return void res.writeHead(404).end();
    if (req.headers.range === 'bytes=0-15') {
      assert.ok(target.searchParams.has('X-Amz-Signature'));
      res.writeHead(206, { 'Content-Range': `bytes 0-15/${body.length}`, 'Content-Length': 16 }).end(body.subarray(0, 16));
      return;
    }
    res.end(body);
  });
  t.after(bucket.close);
  const settings = {
    PREMIERE_STORAGE_PRIVATE: 'true', RECORDING_STORAGE_ENDPOINT: bucket.base, RECORDING_STORAGE_BUCKET: 'media',
    RECORDING_STORAGE_ACCESS_KEY_ID: 'test', RECORDING_STORAGE_SECRET_ACCESS_KEY: 'local-test', LIVE_STREAM_TOKEN_SECRET: secret,
  };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => Object.entries(prior).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
  const scratch = await mkdtemp(join(tmpdir(), 'studio-premiere-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const mp4 = join(scratch, 'sample.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=160x90:d=3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  const bytes = new Uint8Array(await readFile(mp4));
  const makeHandler = () => {
    const handler = createPremiereHandler({
      applyCors: req => req.headers.origin === origin,
      writeJson: (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)),
      getFfmpegPath: () => ffmpeg, clock: () => now,
    });
    return listen((req, res) => void handler(req, res, new URL(req.url || '/', 'http://test')));
  };
  const media = await makeHandler();
  t.after(media.close);
  const viewer = signLiveStreamToken({ v: 1, purpose: 'watch-playback', watchId, nonce: 'aABCDEFGHIJKLMNOP', exp: startsAt + 30_000 }, secret);
  const upload = signLiveStreamToken({ v: 1, purpose: 'premiere-upload', watchId, startsAt, exp: startsAt + 30_000 }, secret);
  const premiere = `${media.base}/premieres/${watchId}`;
  const uploadVideo = () => fetch(`${premiere}/upload`, {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'video/mp4', Authorization: `Bearer ${upload}`, Origin: origin },
  });
  const unauthorized = await fetch(`${premiere}/status`, { headers: { Origin: origin } });
  assert.equal(unauthorized.status, 401);
  const preflight = await fetch(`${premiere}/status?watchToken=${viewer}`, { headers: { Origin: origin } });
  assert.equal((await preflight.json()).phase, 'missing');
  const saved = await uploadVideo();
  assert.equal(saved.status, 201, await saved.clone().text());
  assert.equal((await saved.json()).phase, 'scheduled');
  assert.equal((await uploadVideo()).status, 409);
  assert.equal(objects.size, 2);
  assert.equal((await fetch(`${premiere}/video?watchToken=${viewer}`)).status, 404);

  const restarted = await makeHandler();
  t.after(restarted.close);
  now = startsAt + 1_000;
  const replay = `${restarted.base}/premieres/${watchId}`;
  assert.equal((await fetch(`${replay}/video`, { headers: { Authorization: `Bearer ${upload}` } })).status, 401);
  assert.equal((await fetch(`${restarted.base}/premieres/${wrongWatchId}/video?watchToken=${viewer}`)).status, 401);
  const video = await fetch(`${replay}/video?watchToken=${viewer}`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('Content-Range'), `bytes 0-15/${bytes.length}`);
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), bytes.subarray(0, 16));
  now = startsAt + 3_000;
  assert.equal((await fetch(`${replay}/video?watchToken=${viewer}`)).status, 404);
  const ended = await fetch(`${replay}/status?watchToken=${viewer}`, { headers: { Origin: origin } });
  assert.equal((await ended.json()).phase, 'ended');
});

test('rejects unsupported or too-long MP4 streams', () => {
  assert.equal(parsePremiereMediaInfo('Duration: 00:00:04.12\nStream #0:0: Video: h264 (Main)\nStream #0:1: Audio: aac'), 4_120);
  assert.throws(() => parsePremiereMediaInfo('Duration: 02:00:00.10\nStream #0:0: Video: h264'), /two hours/);
  assert.throws(() => parsePremiereMediaInfo('Duration: 00:00:04.12\nStream #0:0: Video: hevc'), /H.264/);
});
