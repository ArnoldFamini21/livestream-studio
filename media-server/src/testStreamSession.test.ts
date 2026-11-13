import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import WebSocket from 'ws';
import type { LiveStreamTokenClaims, RtmpRelayServerMessage } from '@studio/shared';
import { signLiveStreamToken } from './auth.js';

/**
 * The real media server, started as a process: a test session refuses
 * destinations, publishes under its own private address, removes it at the end
 * and leaves no room for a second session.
 */

const SECRET = 'test-stream-secret-0123456789abcdef0123';
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || '';
const ffmpegAvailable = Boolean(ffmpegPath) && existsSync(ffmpegPath);

const video = { width: 640, height: 360, frameRate: 15, videoBitsPerSecond: 800_000 };
const audio = { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 96_000 };
const destination = { id: 'd1', name: 'YouTube', rtmpUrl: 'rtmp://127.0.0.1:1/live', streamKey: 'secret-key' };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function token(roomId = 'room-1'): string {
  const claims: LiveStreamTokenClaims = {
    v: 1,
    roomId,
    participantId: 'host-1',
    role: 'host',
    watchId: 'public-watch-id',
    exp: Date.now() + 10 * 60_000,
    nonce: 'n1',
  };
  return signLiveStreamToken(claims, SECRET);
}

class Relay {
  readonly messages: RtmpRelayServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.messages.push(JSON.parse(String(data)) as RtmpRelayServerMessage);
    });
  }

  static async open(port: number): Promise<Relay> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rtmp`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Relay(ws);
  }

  start(extra: Record<string, unknown>, roomId = 'room-1') {
    this.ws.send(JSON.stringify({ type: 'start', payload: { token: token(roomId), destinations: [], video, audio, ...extra } }));
  }

  async next<T extends RtmpRelayServerMessage['type']>(type: T, timeoutMs = 15_000): Promise<Extract<RtmpRelayServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((message) => message.type === type);
      if (index >= 0) return this.messages.splice(index, 1)[0] as Extract<RtmpRelayServerMessage, { type: T }>;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No ${type} message within ${timeoutMs} ms; got ${JSON.stringify(this.messages)}`);
  }

  async stop() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop' }));
    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      setTimeout(resolve, 5_000);
    });
  }
}

describe('private test session on the media server', { skip: !ffmpegAvailable }, () => {
  let server: ChildProcessWithoutNullStreams;
  let port = 0;
  let hlsDir = '';
  let output = '';

  before(async () => {
    port = await freePort();
    hlsDir = await mkdtemp(path.join(os.tmpdir(), 'test-stream-hls-'));
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        LIVE_STREAM_TOKEN_SECRET: SECRET,
        HLS_OUTPUT_DIR: hlsDir,
        RTMP_ENCODE_ONCE: 'true',
        NODE_ENV: 'test',
        CLIENT_URLS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
    server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const deadline = Date.now() + 30_000;
    while (!output.includes('Media server running') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(output.includes('Media server running'), output);
  });

  after(async () => {
    server?.kill('SIGTERM');
    await rm(hlsDir, { recursive: true, force: true });
  });

  async function status(id: string): Promise<{ live: boolean }> {
    const response = await fetch(`http://127.0.0.1:${port}/watch/${id}/status`);
    return await response.json() as { live: boolean };
  }

  it('advertises the test in /health', async () => {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { capabilities: { testStream?: { ready: boolean } } };
    assert.equal(health.capabilities.testStream?.ready, true);
  });

  it('refuses a test that carries a destination, at start and on a reconnect start', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const relay = await Relay.open(port);
      relay.start({ test: true, destinations: [destination] });
      const error = await relay.next('error');
      assert.equal(error.payload.code, 'TEST_NOT_ALLOWED');
      assert.doesNotMatch(output, /secret-key/);
      relay.ws.close();
    }
  });

  it('publishes a test under a private address, refuses a second session, and removes the output at the end', async () => {
    const relay = await Relay.open(port);
    relay.start({ test: true });
    const started = await relay.next('session-started');
    assert.deepEqual(started.payload.destinationIds, []);
    const watchId = started.payload.test?.watchId;
    assert.ok(watchId && watchId !== 'public-watch-id');
    assert.equal((await status(watchId)).live, true);
    // The studio's public watch address stays offline while a test runs.
    assert.equal((await status('public-watch-id')).live, false);
    // No backup recording is announced for a test.
    assert.equal(relay.messages.filter((message) => message.type === 'backup-recording-status').length, 0);

    // The same studio reconnecting continues its test at the same private address ...
    const reconnected = await Relay.open(port);
    reconnected.start({ test: true });
    const resumed = await reconnected.next('session-started');
    assert.equal(resumed.payload.test?.watchId, watchId);
    assert.deepEqual(resumed.payload.destinationIds, []);
    // ... and a reconnect that carries a destination is refused.
    const badReconnect = await Relay.open(port);
    badReconnect.start({ test: true, destinations: [destination] });
    assert.equal((await badReconnect.next('error')).payload.code, 'TEST_NOT_ALLOWED');
    badReconnect.ws.close();

    // A second studio finds the media server busy.
    const second = await Relay.open(port);
    second.start({ test: true }, 'room-2');
    const refused = await second.next('error');
    assert.equal(refused.payload.code, 'RELAY_CAPACITY_REACHED');
    assert.match(refused.payload.message, /test stream is already running/);
    second.ws.close();

    await reconnected.stop();
    assert.equal((await status(watchId)).live, false);
    const deadline = Date.now() + 10_000;
    let left: string[] = ['x'];
    while (left.length > 0 && Date.now() < deadline) {
      left = (await readdir(hlsDir)).filter((name) => !name.startsWith('._'));
      if (left.length > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(left, [], 'the private playlist and segments are removed');
  });
});

/** A WebM like the studio's MediaRecorder output: VP8 and Opus, a keyframe every second. */
async function makeWebm(seconds: number): Promise<Buffer> {
  const child = spawn(ffmpegPath, [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', '-b:v', '300k',
    '-c:a', 'libopus', '-b:a', '64k',
    '-f', 'webm', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const parts: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => parts.push(chunk));
  child.stderr.on('data', () => {});
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  return Buffer.concat(parts);
}

/** A destination that accepts connections and says nothing, and counts them. */
function startListener(): Promise<{ port: number; opened: () => number; open: () => number; stop: () => void }> {
  let opened = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    opened += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port,
    opened: () => opened,
    open: () => sockets.size,
    stop: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  })));
}

describe('a test start while the same room has a held broadcast', { skip: !ffmpegAvailable, timeout: 180_000 }, () => {
  let server: ChildProcessWithoutNullStreams;
  let port = 0;
  let hlsDir = '';
  let output = '';
  let webm: Buffer = Buffer.alloc(0);
  let listener: Awaited<ReturnType<typeof startListener>>;
  let real: Record<string, unknown>;

  before(async () => {
    webm = await makeWebm(8);
    assert.ok(webm.length > 10_000);
    listener = await startListener();
    real = { destinations: [{ ...destination, rtmpUrl: `rtmp://127.0.0.1:${listener.port}/live` }] };
    port = await freePort();
    hlsDir = await mkdtemp(path.join(os.tmpdir(), 'held-guard-hls-'));
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        LIVE_STREAM_TOKEN_SECRET: SECRET,
        HLS_OUTPUT_DIR: hlsDir,
        RTMP_ENCODE_ONCE: 'true',
        RTMP_ALLOW_PRIVATE_HOSTS: 'true',
        NODE_ENV: 'test',
        CLIENT_URLS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
    server.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    server.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const deadline = Date.now() + 30_000;
    while (!output.includes('Media server running') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(output.includes('Media server running'), output);
  });

  after(async () => {
    server?.kill('SIGTERM');
    listener?.stop();
    await rm(hlsDir, { recursive: true, force: true });
  });

  /** Streams the sample to a real broadcast until its destination is confirmed live. */
  async function goLiveAndWaitForDestination(extra: Record<string, unknown>): Promise<Relay> {
    const relay = await Relay.open(port);
    relay.start(extra);
    await relay.next('session-started');
    let sent = 0;
    const feeder = setInterval(() => {
      if (relay.ws.readyState !== WebSocket.OPEN || sent >= webm.length) return;
      relay.ws.send(webm.subarray(sent, sent + 12_000));
      sent += 12_000;
    }, 40);
    try {
      for (const deadline = Date.now() + 40_000; Date.now() < deadline;) {
        const status = relay.messages.find((message) => message.type === 'destination-status' && message.payload.status === 'live');
        if (status) return relay;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`The destination never went live: ${JSON.stringify(relay.messages)}\n${output.slice(-1500)}`);
    } finally {
      clearInterval(feeder);
    }
  }

  async function closeAndWaitForHold(relay: Relay) {
    const before = output.length;
    relay.ws.close();
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      if (output.slice(before).includes('holding for')) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The broadcast was not held: ${output.slice(before)}`);
  }

  it('refuses the test, keeps the broadcast on its slate, and a following Go Live resumes it on the same connection', async () => {
    const studio = await goLiveAndWaitForDestination(real);
    assert.equal(listener.opened(), 1);
    await closeAndWaitForHold(studio);
    assert.equal(listener.open(), 1, 'the destination connection stays open during the hold');

    const entriesBefore = (await readdir(hlsDir)).filter((name) => !name.startsWith('._')).sort();
    const test = await Relay.open(port);
    test.start({ test: true });
    const refusal = await test.next('error');
    assert.equal(refusal.payload.code, 'TEST_BLOCKED_BY_HELD_BROADCAST');
    assert.match(refusal.payload.message, /still on the air, waiting for you/);
    assert.equal(test.messages.filter((message) => message.type === 'session-started').length, 0);
    test.ws.close();

    // Nothing of the refused test exists, and the broadcast was not stopped.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual((await readdir(hlsDir)).filter((name) => !name.startsWith('._')).sort(), entriesBefore, 'no private output folder');
    assert.doesNotMatch(output, /Live encoder starting for 0 destination/);
    assert.equal(listener.open(), 1, 'the destination connection is still open');
    assert.equal(listener.opened(), 1);

    // Go Live with the same setup continues the same broadcast: no second connection.
    const returned = await Relay.open(port);
    returned.start(real);
    const resumed = await returned.next('session-started');
    assert.deepEqual(resumed.payload.destinationIds, ['d1']);
    assert.match(output, /Studio reconnected to its live broadcast in room room-1/);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(listener.opened(), 1, 'the destination keeps its one connection');
    assert.equal(listener.open(), 1);
    await returned.stop();
  });

  it('still lets a normal Go Live with new settings replace its own held broadcast', async () => {
    const studio = await goLiveAndWaitForDestination(real);
    await closeAndWaitForHold(studio);
    const other = await Relay.open(port);
    other.start({ ...real, video: { ...video, width: 1280, height: 720, videoBitsPerSecond: 2_000_000 } });
    const started = await other.next('session-started');
    assert.deepEqual(started.payload.destinationIds, ['d1']);
    // The new start was not refused for capacity, so the held broadcast ended; it was not resumed.
    assert.doesNotMatch(output.slice(output.lastIndexOf('holding for')), /reconnected to its live broadcast/);
    assert.match(output.slice(output.lastIndexOf('holding for')), /Live encoder starting for 1 destination\(s\): .* to 1280x720/);
    await other.stop();
  });
});
