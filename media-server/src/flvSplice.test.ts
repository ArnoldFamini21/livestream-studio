import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStaticPath from 'ffmpeg-static';
import { FlvProgram, flvTagsIn, readFlvTimestamp, withFlvTimestamp } from './flvSplice.js';
import { describeFlvTag, FLV_TAG_AUDIO, FLV_TAG_SCRIPT, FLV_TAG_VIDEO, type FlvChunk } from './flvStream.js';
import { createFfmpegPushArgs, createFfmpegSlateArgs } from './rtmp.js';

const FILE_HEADER = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]);

function tag(type: number, ms: number, data: number[]): Buffer {
  const bytes = Buffer.alloc(11 + data.length + 4);
  bytes[0] = type;
  bytes.writeUIntBE(data.length, 1, 3);
  bytes.writeUIntBE(ms & 0xffffff, 4, 3);
  bytes[7] = (ms >>> 24) & 0xff;
  Buffer.from(data).copy(bytes, 11);
  bytes.writeUInt32BE(11 + data.length, 11 + data.length);
  return bytes;
}

const metadata = (ms = 0) => tag(FLV_TAG_SCRIPT, ms, [2, 0, 10]);
const avcConfig = (ms = 0) => tag(FLV_TAG_VIDEO, ms, [0x17, 0, 0, 0, 0, 1]);
const aacConfig = (ms = 0) => tag(FLV_TAG_AUDIO, ms, [0xaf, 0, 0x11]);
const keyframe = (ms: number) => tag(FLV_TAG_VIDEO, ms, [0x17, 1, 0, 0, 0, 9]);
const frame = (ms: number) => tag(FLV_TAG_VIDEO, ms, [0x27, 1, 0, 0, 0, 9]);
const audio = (ms: number) => tag(FLV_TAG_AUDIO, ms, [0xaf, 1, 7]);

function encoderOutput(...tags: Buffer[]): Buffer {
  return Buffer.concat([FILE_HEADER, metadata(), avcConfig(), aacConfig(), ...tags]);
}

function collect() {
  const chunks: FlvChunk[] = [];
  const program = new FlvProgram((chunk) => chunks.push(chunk));
  const tags = () => chunks.flatMap((chunk) => [...flvTagsIn(chunk.bytes)]).map((bytes) => ({
    ...describeFlvTag(bytes),
    ms: readFlvTimestamp(bytes),
  }));
  const bytes = () => Buffer.concat(chunks.map((chunk) => chunk.bytes));
  return { program, tags, bytes };
}

describe('FLV timestamps', () => {
  it('reads and writes 32-bit timestamps', () => {
    const later = withFlvTimestamp(frame(5), 0x01234567);
    assert.equal(readFlvTimestamp(later), 0x01234567);
    assert.equal(readFlvTimestamp(frame(5)), 5);
  });
});

describe('FlvProgram', () => {
  it('passes the first source through unchanged, with one file header', () => {
    const { program, tags, bytes } = collect();
    const source = program.createSource('encoder');
    program.switchTo(source);
    const input = encoderOutput(keyframe(0), audio(10), frame(33));
    source.push(input);
    assert.deepEqual(bytes(), input);
    assert.deepEqual(tags().map((t) => t.ms), [0, 0, 0, 0, 10, 33]);
  });

  it('switches at the next keyframe and continues the timestamps', () => {
    const { program, tags, bytes } = collect();
    const first = program.createSource('encoder');
    program.switchTo(first);
    first.push(encoderOutput(keyframe(0), audio(20), frame(1000)));
    const before = tags().length;

    const slate = program.createSource('slate');
    program.switchTo(slate);
    // The slate's opening tags before its keyframe, and its metadata, stay off air.
    slate.push(encoderOutput(audio(0), keyframe(500), audio(510), frame(533)));
    first.push(Buffer.concat([frame(1033)]));

    const after = tags().slice(before);
    assert.deepEqual(after.map((t) => [t.type, t.sequenceHeader, t.ms]), [
      [FLV_TAG_VIDEO, true, 1040],
      [FLV_TAG_AUDIO, true, 1040],
      [FLV_TAG_VIDEO, false, 1040],
      [FLV_TAG_AUDIO, false, 1050],
      [FLV_TAG_VIDEO, false, 1073],
    ]);
    assert.equal(program.activeSource, slate);
    assert.equal(program.switches, 1);
    // Still exactly one file header and one metadata tag.
    assert.equal(bytes().toString('latin1').split('FLV').length - 1, 1);
    assert.equal(tags().filter((t) => t.type === FLV_TAG_SCRIPT).length, 1);
  });

  it('keeps each track moving forward when the new source runs early', () => {
    const { program, tags } = collect();
    const first = program.createSource('a');
    program.switchTo(first);
    first.push(encoderOutput(keyframe(0), audio(2000)));
    const next = program.createSource('b');
    program.switchTo(next);
    next.push(encoderOutput(keyframe(100), audio(40)));
    const audioMs = tags().filter((t) => t.type === FLV_TAG_AUDIO && !t.sequenceHeader).map((t) => t.ms);
    assert.deepEqual(audioMs, [2000, 2000]);
  });

  it('switching back to the source on air cancels a pending switch', () => {
    const { program } = collect();
    const first = program.createSource('a');
    program.switchTo(first);
    first.push(encoderOutput(keyframe(0)));
    const slate = program.createSource('slate');
    program.switchTo(slate);
    program.switchTo(first);
    assert.equal(program.pendingSource, null);
    slate.push(encoderOutput(keyframe(0)));
    assert.equal(program.activeSource, first);
  });

  it('gives late joiners the codec setup of the source on air', () => {
    const { program } = collect();
    const first = program.createSource('a');
    program.switchTo(first);
    first.push(encoderOutput(keyframe(0)));
    const next = program.createSource('b');
    program.switchTo(next);
    const newConfig = tag(FLV_TAG_VIDEO, 0, [0x17, 0, 0, 0, 0, 2]);
    next.push(Buffer.concat([FILE_HEADER, metadata(), newConfig, aacConfig(), keyframe(0)]));
    const init = program.stream.initSegment;
    assert.ok(init);
    assert.ok(init.includes(Buffer.from([0x17, 0, 0, 0, 0, 2])), 'the new AVC configuration');
  });
});

const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || '';
const ffmpegAvailable = Boolean(ffmpegPath) && existsSync(ffmpegPath);
const slateImage = fileURLToPath(new URL('../assets/reconnecting-slate.jpg', import.meta.url));
const options = {
  video: { width: 320, height: 180, frameRate: 15, videoBitsPerSecond: 600_000 },
  audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 96_000 },
};

describe('FlvProgram with real FFmpeg', { skip: !ffmpegAvailable && 'FFmpeg is not available' }, () => {
  it('splices two encoders into one continuous stream a copy-only uploader accepts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'flv-splice-'));
    try {
      const file = path.join(dir, 'program.flv');
      const args = createFfmpegPushArgs({ id: 'file', name: 'File', rtmpUrl: 'rtmp://127.0.0.1/live', streamKey: 'k' });
      args[args.length - 1] = file;
      args.splice(args.length - 1, 0, '-y');
      const uploader = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let uploaderErrors = '';
      uploader.stderr.on('data', (chunk: Buffer) => { uploaderErrors += chunk.toString('utf8'); });
      const program = new FlvProgram((chunk) => uploader.stdin.write(chunk.bytes));

      const runSource = async (name: string, seconds: number) => {
        const source = program.createSource(name);
        program.switchTo(source);
        const child = spawn(ffmpegPath, createFfmpegSlateArgs(options, slateImage), { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.on('data', (data: Buffer) => source.push(data));
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        child.kill('SIGTERM');
        await once(child, 'close');
      };
      await runSource('first', 2.5);
      await runSource('second', 2.5);
      assert.equal(program.switches, 1);
      uploader.stdin.end();
      const [code] = await once(uploader, 'close') as [number | null];
      assert.equal(code, 0, uploaderErrors);
      assert.doesNotMatch(uploaderErrors, /Non-monoton|invalid|error/i);

      const decoded = spawn(ffmpegPath, ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let progress = '';
      let decodeErrors = '';
      decoded.stdout.on('data', (chunk: Buffer) => { progress += chunk.toString('utf8'); });
      decoded.stderr.on('data', (chunk: Buffer) => { decodeErrors += chunk.toString('utf8'); });
      await once(decoded, 'close');
      assert.equal(decodeErrors.trim(), '', 'the spliced program decodes cleanly');
      const outTime = Math.max(...[...progress.matchAll(/^out_time_us=(\d+)$/gm)].map((match) => Number(match[1])));
      // Both sources' time, back to back: timestamps continued instead of restarting at zero.
      assert.ok(outTime / 1e6 > 3.5, `program duration ${outTime / 1e6}s`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
