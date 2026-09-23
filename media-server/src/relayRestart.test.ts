import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import ffmpegStaticPath from 'ffmpeg-static';
import type { RtmpRelayDestination } from '@studio/shared';
import { createFfmpegArgs } from './rtmp.js';
import {
  WEBM_CLUSTER_ID,
  WEBM_SEGMENT_ID,
  WebmSinkFeed,
  WebmStreamTracker,
  readEbmlElementHeader,
} from './webmStream.js';

const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || '';
const ffmpegAvailable = Boolean(ffmpegPath) && existsSync(ffmpegPath);

const destination: RtmpRelayDestination = {
  id: 'dest-1',
  name: 'Local file',
  rtmpUrl: 'rtmp://127.0.0.1/live',
  streamKey: 'test-key',
};
const FRAME_RATE = 15;
const DURATION_SECONDS = 6;

interface FfmpegResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runFfmpeg(args: string[], input?: Buffer): Promise<FfmpegResult & { stdoutBytes: Buffer }> {
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  const stdoutBytes = Buffer.concat(stdout);
  return { code, signal, stdout: stdoutBytes.toString('utf8'), stdoutBytes, stderr };
}

async function countVideoFrames(file: string): Promise<number> {
  const result = await runFfmpeg([
    '-v', 'error', '-nostats', '-progress', 'pipe:1',
    '-i', file, '-map', '0:v:0', '-f', 'null', '-',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr.trim(), '', 'relay output should decode cleanly');
  const frames = [...result.stdout.matchAll(/^frame=(\d+)$/gm)].map((match) => Number(match[1]));
  return frames.at(-1) ?? 0;
}

// The production relay args, writing FLV to a local file instead of RTMP.
function startRelay(outputPath: string) {
  const args = createFfmpegArgs(destination, {
    video: { width: 320, height: 240, frameRate: FRAME_RATE, videoBitsPerSecond: 500_000 },
    audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 64_000 },
  });
  args[args.length - 1] = outputPath;
  const child: ChildProcessByStdio<Writable, null, Readable> = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const closed = once(child, 'close').then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
    stderr,
  }));
  return { child, closed, feed: new WebmSinkFeed(child.stdin) };
}

function splitRandomly(stream: Buffer, seed: number, maxChunk: number): Buffer[] {
  let state = seed;
  const chunks: Buffer[] = [];
  for (let start = 0; start < stream.length;) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const end = Math.min(stream.length, start + 1 + (state % maxChunk));
    chunks.push(stream.subarray(start, end));
    start = end;
  }
  return chunks;
}

function clusterOffsets(stream: Buffer): number[] {
  const offsets: number[] = [];
  for (let pos = 0; pos < stream.length;) {
    const header = readEbmlElementHeader(stream, pos);
    if (typeof header === 'string') throw new Error(`Unexpected ${header} element at ${pos}`);
    if (header.id === WEBM_CLUSTER_ID) offsets.push(pos);
    pos += header.headerLength + (header.id === WEBM_SEGMENT_ID ? 0 : header.size ?? 0);
  }
  return offsets;
}

// Rewrites FFmpeg's known-size Clusters as unknown-size ones, the layout
// Chrome's MediaRecorder streams.
function withUnknownSizeClusters(stream: Buffer): Buffer {
  const out = Buffer.from(stream);
  for (const offset of clusterOffsets(stream)) {
    const header = readEbmlElementHeader(stream, offset);
    if (typeof header === 'string') throw new Error('Cluster header vanished');
    const sizeStart = offset + header.idLength;
    const sizeLength = header.headerLength - header.idLength;
    out[sizeStart] = 0xff >> (sizeLength - 1);
    out.fill(0xff, sizeStart + 1, sizeStart + sizeLength);
  }
  return out;
}

describe('RTMP relay restart with FFmpeg', { skip: !ffmpegAvailable && 'ffmpeg binary unavailable', timeout: 120_000 }, () => {
  let workDir = '';
  let knownSizeStream: Buffer = Buffer.alloc(0);
  let uninterruptedFrames = 0;

  before(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'relay-restart-test-'));
    // A MediaRecorder-like VP8/Opus WebM with a keyframe (and Cluster) every second.
    const source = await runFfmpeg([
      '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${FRAME_RATE}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(DURATION_SECONDS),
      '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-g', String(FRAME_RATE), '-b:v', '300k',
      '-c:a', 'libopus', '-b:a', '64k',
      '-f', 'webm', 'pipe:1',
    ]);
    assert.equal(source.code, 0, source.stderr);
    knownSizeStream = source.stdoutBytes;
    assert.ok(clusterOffsets(knownSizeStream).length >= DURATION_SECONDS);

    const control = startRelay(path.join(workDir, 'uninterrupted.flv'));
    control.child.stdin.end(knownSizeStream);
    const result = await control.closed;
    assert.equal(result.code, 0, result.stderr);
    uninterruptedFrames = await countVideoFrames(path.join(workDir, 'uninterrupted.flv'));
    assert.ok(uninterruptedFrames >= FRAME_RATE * (DURATION_SECONDS - 1));
  });

  after(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('shows a respawned FFmpeg rejects mid-stream media without the init segment', async () => {
    const offsets = clusterOffsets(knownSizeStream);
    const relay = startRelay(path.join(workDir, 'no-init.flv'));
    relay.child.stdin.on('error', () => {});
    // Even starting exactly on a Cluster boundary is not enough.
    relay.child.stdin.end(knownSizeStream.subarray(offsets[Math.floor(offsets.length / 2)]));
    const result = await relay.closed;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EBML header parsing failed|Invalid data found/);
  });

  for (const layout of ['known-size', 'unknown-size'] as const) {
    it(`reconnects a killed destination while the other keeps streaming (${layout} clusters)`, async () => {
      const stream = layout === 'known-size' ? knownSizeStream : withUnknownSizeClusters(knownSizeStream);
      const chunks = splitRandomly(stream, layout === 'known-size' ? 7 : 11, 8 * 1024);
      const tracker = new WebmStreamTracker();

      const steady = startRelay(path.join(workDir, `${layout}-steady.flv`));
      const original = startRelay(path.join(workDir, `${layout}-original.flv`));
      assert.equal(steady.feed.join(tracker), 'from-start');
      assert.equal(original.feed.join(tracker), 'from-start');
      const relays = [steady, original];

      // Mirrors handleBinaryChunk: one parse per chunk, one write per destination.
      const pushChunk = (chunk: Buffer) => {
        const info = tracker.push(chunk);
        for (const relay of relays) relay.feed.write(chunk, info);
      };

      const killAt = Math.floor(chunks.length * 0.4);
      let next = 0;
      for (; next < killAt; next += 1) pushChunk(chunks[next]);

      original.child.kill('SIGKILL');
      // Media keeps arriving before the close event lands.
      for (const end = next + 3; next < end; next += 1) pushChunk(chunks[next]);
      const killed = await original.closed;
      assert.equal(killed.signal, 'SIGKILL');
      relays.splice(relays.indexOf(original), 1);

      // The restart timer fires later still; more media flows meanwhile.
      for (const end = next + 5; next < end; next += 1) pushChunk(chunks[next]);
      const respawned = startRelay(path.join(workDir, `${layout}-respawned.flv`));
      assert.equal(respawned.feed.join(tracker), 'resync');
      relays.push(respawned);
      for (; next < chunks.length; next += 1) pushChunk(chunks[next]);

      steady.child.stdin.end();
      respawned.child.stdin.end();
      const [steadyResult, respawnedResult] = await Promise.all([steady.closed, respawned.closed]);
      assert.equal(respawnedResult.code, 0, respawnedResult.stderr);
      // Resuming on a Cluster boundary demuxes cleanly; partial-cluster bytes
      // would log EBML parse errors here even when FFmpeg recovers from them.
      assert.equal(respawnedResult.stderr.trim(), '', 'respawned relay should demux without errors');
      assert.equal(steadyResult.code, 0, steadyResult.stderr);

      const steadyFrames = await countVideoFrames(path.join(workDir, `${layout}-steady.flv`));
      const respawnedFrames = await countVideoFrames(path.join(workDir, `${layout}-respawned.flv`));
      assert.equal(steadyFrames, uninterruptedFrames, 'the other destination is unaffected');
      assert.ok(respawnedFrames >= FRAME_RATE, `respawned relay encoded ${respawnedFrames} frames`);
      assert.ok(respawnedFrames < steadyFrames, 'respawned relay resumes mid-stream');
    });
  }
});
