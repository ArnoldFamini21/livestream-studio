import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import { createFfmpegEncoderArgs, createFfmpegPushArgs } from './rtmp.js';
import { FlvSinkFeed, FlvTagStream } from './flvStream.js';
import { WebmSinkFeed, WebmStreamTracker } from './webmStream.js';

const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || '';
const ffmpegAvailable = Boolean(ffmpegPath) && existsSync(ffmpegPath);
const DURATION_SECONDS = 8;
const options = {
  video: { width: 320, height: 180, frameRate: 15, videoBitsPerSecond: 600_000 },
  audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 96_000 },
};

async function run(args: string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const [code] = await once(child, 'close') as [number | null];
  return { code, stdout: Buffer.concat(stdout), stderr };
}

async function probe(file: string): Promise<{ frames: number; durationSeconds: number }> {
  const result = await run(['-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-f', 'null', '-']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr.trim(), '', `${path.basename(file)} should decode cleanly`);
  const text = result.stdout.toString('utf8');
  const frames = Math.max(...[...text.matchAll(/^frame=(\d+)$/gm)].map((match) => Number(match[1])));
  const outTime = Math.max(...[...text.matchAll(/^out_time_us=(\d+)$/gm)].map((match) => Number(match[1])));
  return { frames, durationSeconds: outTime / 1e6 };
}

/** A destination uploader writing to a file instead of RTMP; optionally stalled at start. */
function spawnUploader(file: string, stallSeconds = 0) {
  const args = createFfmpegPushArgs({ id: 'file', name: 'File', rtmpUrl: 'rtmp://127.0.0.1/live', streamKey: 'k' });
  args[args.length - 1] = file;
  args.splice(args.length - 1, 0, '-y');
  const child = stallSeconds
    ? spawn('sh', ['-c', `sleep ${stallSeconds}; exec "$0" "$@"`, ffmpegPath, ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
    : spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'ignore'] });
  return child;
}

describe('encode-once fan-out with real FFmpeg', { skip: !ffmpegAvailable && 'FFmpeg is not available' }, () => {
  let dir = '';
  let webm: Buffer = Buffer.alloc(0);

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'encode-once-'));
    const source = await run([
      '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=15:duration=${DURATION_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION_SECONDS}`,
      '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '600k', '-g', '30',
      '-c:a', 'libopus', '-f', 'webm', 'pipe:1',
    ]);
    assert.equal(source.code, 0, source.stderr);
    webm = source.stdout;
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('feeds every destination from one encode: on time, late joiner, and a stalled uploader', { timeout: 60_000 }, async () => {
    const encoder = spawn(ffmpegPath, createFfmpegEncoderArgs(options), { stdio: ['pipe', 'pipe', 'ignore'] });
    const tracker = new WebmStreamTracker();
    const encoderFeed = new WebmSinkFeed(encoder.stdin);
    encoderFeed.join(tracker);
    const flv = new FlvTagStream();

    const files = { onTime: path.join(dir, 'on-time.flv'), late: path.join(dir, 'late.flv'), stalled: path.join(dir, 'stalled.flv') };
    const onTime = spawnUploader(files.onTime);
    const stalled = spawnUploader(files.stalled, 3);
    const onTimeFeed = new FlvSinkFeed(onTime.stdin, flv);
    const stalledFeed = new FlvSinkFeed(stalled.stdin, flv, { maxBufferedBytes: 120_000 });
    assert.equal(onTimeFeed.join(), 'from-start');
    stalledFeed.join();
    let late: ReturnType<typeof spawnUploader> | null = null;
    let lateFeed: FlvSinkFeed | null = null;
    let encodedBytes = 0;

    encoder.stdout.on('data', (data: Buffer) => {
      const chunk = flv.push(data);
      if (!chunk) return;
      encodedBytes += chunk.bytes.length;
      onTimeFeed.write(chunk);
      stalledFeed.write(chunk);
      if (!late && encodedBytes > 200_000) {
        late = spawnUploader(files.late);
        lateFeed = new FlvSinkFeed(late.stdin, flv);
        assert.equal(lateFeed.join(), 'resync');
      }
      lateFeed?.write(chunk);
    });
    const encoderDone = once(encoder.stdout, 'end');

    // Feed the studio's WebM at roughly real time, like the browser does.
    const step = Math.ceil(webm.length / (DURATION_SECONDS * 10));
    for (let offset = 0; offset < webm.length; offset += step) {
      const chunk = webm.subarray(offset, offset + step);
      encoderFeed.write(chunk, tracker.push(chunk));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    encoder.stdin.end();
    await encoderDone;

    const uploaders = [onTime, stalled, late].filter(Boolean) as Array<ReturnType<typeof spawnUploader>>;
    const closed = uploaders.map((child) => once(child, 'close'));
    for (const child of uploaders) child.stdin.end();
    await Promise.all(closed);

    assert.ok(flv.healthy);
    assert.ok(late, 'the late uploader joined');
    assert.equal(stalledFeed.overflowCount >= 1, true, 'the stalled uploader fell behind');
    assert.equal(stalledFeed.skipping, false, 'and caught up again');

    const full = await probe(files.onTime);
    const joined = await probe(files.late);
    const recovered = await probe(files.stalled);
    assert.ok(full.durationSeconds >= DURATION_SECONDS - 0.5, `on-time output covers the show (${full.durationSeconds}s)`);
    assert.ok(joined.frames > 0 && joined.frames < full.frames, 'the late joiner starts mid-show');
    assert.ok(recovered.frames > 0 && recovered.frames < full.frames, 'the stalled uploader skipped ahead');
  });
});
