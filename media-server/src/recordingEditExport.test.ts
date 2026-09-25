import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStaticPath from 'ffmpeg-static';
import {
  MAX_EXPORT_KEEP_RANGES,
  createRecordingExportCommands,
  getRecordingExportEditIssue,
  normalizeRecordingExportEdit,
} from './recordingExport.js';
import { RecordingExportJobStore, createFfmpegExportRunner } from './recordingExportJob.js';

const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || '';
const ffmpegAvailable = Boolean(ffmpegPath) && existsSync(ffmpegPath);

describe('recording export edits', () => {
  it('validates kept ranges', () => {
    assert.equal(getRecordingExportEditIssue(undefined), null);
    assert.match(getRecordingExportEditIssue({ keepRanges: [] }) || '', /at least one range/);
    assert.match(getRecordingExportEditIssue({ keepRanges: [{ startSeconds: 2, endSeconds: 1 }] }) || '', /later end/);
    assert.match(getRecordingExportEditIssue({ keepRanges: [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 1, endSeconds: 3 }] }) || '', /overlap/);
    const tooMany = Array.from({ length: MAX_EXPORT_KEEP_RANGES + 1 }, (_, i) => ({ startSeconds: i, endSeconds: i + 0.5 }));
    assert.match(getRecordingExportEditIssue({ keepRanges: tooMany }) || '', /at most/);
    assert.equal(getRecordingExportEditIssue({ keepRanges: [{ startSeconds: 0, endSeconds: 1.5 }, { startSeconds: 2, endSeconds: 3 }] }), null);
  });

  it('snaps ranges to video frames and merges ranges that touch', () => {
    const edit = normalizeRecordingExportEdit({
      keepRanges: [
        { startSeconds: 0.01, endSeconds: 1.02 },
        { startSeconds: 1.03, endSeconds: 2 },
        { startSeconds: 2.5, endSeconds: 2.51 },
        { startSeconds: 3, endSeconds: 4 },
      ],
    }, 30);
    assert.deepEqual(edit?.keepRanges, [
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 3, endSeconds: 4 },
    ]);
    assert.throws(() => normalizeRecordingExportEdit({ keepRanges: [{ startSeconds: 0, endSeconds: 0.5 }] }, 30), /at least 1 second/);
  });

  it('builds frame-accurate filter scripts for every output and rejects clip plus edit', () => {
    const plan = {
      tracks: [
        { id: 'program', label: 'Program', kind: 'program' as const, path: '/tmp/program.webm', hasAudio: true, hasVideo: true },
        { id: 'host-video', label: 'Host', kind: 'video' as const, path: '/tmp/host.webm', hasAudio: false, hasVideo: true },
        { id: 'host-audio', label: 'Host mic', kind: 'audio' as const, path: '/tmp/host-mic.webm', hasAudio: true, hasVideo: false },
      ],
      outputDirectory: '/tmp/out',
      basename: 'Episode 12',
      video: { frameRate: 30 },
      edit: { keepRanges: [{ startSeconds: 0, endSeconds: 1 }, { startSeconds: 2, endSeconds: 4 }] },
    };
    const commands = createRecordingExportCommands(plan);
    assert.equal(commands.mp4.outputPath, '/tmp/out/Episode_12_cleaned.mp4');
    assert.equal(commands.mp4.label, 'Final MP4 (cleaned)');
    const script = commands.mp4.filterScript!;
    assert.equal(script.path, '/tmp/out/Episode_12_cleaned.mp4.filtergraph.txt');
    assert.ok(commands.mp4.args.includes('-filter_complex_script'));
    assert.ok(!commands.mp4.args.includes('-ss'), 'edits do not also seek');
    assert.match(script.content, /fps=30,select='gte\(t,-0\.016667\)\*lt\(t,0\.983333\)\+gte\(t,1\.983333\)\*lt\(t,3\.983333\)'/);
    // The program mix carries its own audio, which is cut with the same ranges.
    assert.match(script.content, /\[0:a:0\]aresample=48000,asetnsamples=n=48:p=0,aselect='gte\(t,0\.000000\)\*lt\(t,1\.000000\)\+gte\(t,2\.000000\)\*lt\(t,4\.000000\)',asetpts=N\/SR\/TB\[aout\]/);

    // Without a program mix, the separate mic tracks are mixed and then cut once.
    const mixed = createRecordingExportCommands({ ...plan, tracks: plan.tracks.filter((track) => track.kind !== 'program') });
    assert.match(mixed.mp4.filterScript!.content, /\[1:a:0\]amix=inputs=1:duration=longest:dropout_transition=2,aresample=48000/);

    const [isolated] = commands.isolatedVideos;
    assert.ok(isolated.filterScript && !isolated.filterScript.content.includes('[aout]'), 'a camera track without audio gets no audio chain');
    assert.equal(commands.stems.length, 4);
    for (const stem of commands.stems) {
      assert.match(stem.outputPath, /_cleaned\.(wav|mp3)$/);
      assert.match(stem.filterScript!.content, /asetnsamples=n=48:p=0,aselect=/);
    }

    assert.throws(() => createRecordingExportCommands({ ...plan, clip: { startSeconds: 0, endSeconds: 2 } }), /clip range or an edit/);
  });
});

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const [code] = await once(child, 'close') as [number | null];
  return { code, stdout, stderr };
}

async function mediaDuration(file: string, stream: 'v' | 'a'): Promise<number> {
  const result = await run(['-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', `0:${stream}:0`, '-f', 'null', '-']);
  assert.equal(result.code, 0, result.stderr);
  const times = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map((match) => Number(match[1]));
  return Math.max(...times) / 1e6;
}

describe('edited export with real FFmpeg', { skip: !ffmpegAvailable && 'FFmpeg is not available' }, () => {
  let dir = '';
  let programPath = '';

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'edit-export-'));
    programPath = path.join(dir, 'program.webm');
    // A black picture that flashes white exactly while a beep plays (6.0-6.2 s).
    const result = await run([
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=320x180:r=30:d=10',
      '-f', 'lavfi', '-i', 'color=white:s=320x180:r=30:d=10',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=10',
      '-filter_complex', "[0:v][1:v]overlay=enable='between(t,6,6.2)'[v];[2:a]volume=enable='not(between(t,6,6.2))':volume=0[a]",
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '300k', '-c:a', 'libopus', '-f', 'webm', programPath,
    ]);
    assert.equal(result.code, 0, result.stderr);
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('exports an edited audio-only recording to playable WAV and MP3', async () => {
    const audioPath = path.join(dir, 'audio-only.webm');
    const converted = await run(['-v', 'error', '-i', programPath, '-vn', '-c:a', 'copy', audioPath]);
    assert.equal(converted.code, 0, converted.stderr);
    const store = new RecordingExportJobStore(createFfmpegExportRunner(ffmpegPath));
    const job = await store.createJob({
      uploadId: 'audio-upload', roomId: 'audio-room', rootDir: dir,
      tracks: [{ id: 'mic', label: 'Microphone', kind: 'audio', mimeType: 'audio/webm', filePath: audioPath, bytesReceived: (await stat(audioPath)).size, complete: true }],
    }, { includeAudioStems: false, edit: { keepRanges: [{ startSeconds: 1, endSeconds: 3 }] } });
    await store.startJob(job.exportId);
    const done = store.getJob(job.exportId);
    assert.equal(done.status, 'ready', done.error);
    assert.deepEqual(done.artifacts.map((artifact) => artifact.format), ['wav', 'mp3', 'json']);
    for (const artifact of done.artifacts.filter((item) => item.format !== 'json')) {
      assert.ok(Math.abs(await mediaDuration(store.getArtifact(job.exportId, artifact.id).path, 'a') - 2) < 0.1);
    }
  });

  it('removes the cut ranges and keeps picture and sound in sync', { timeout: 120_000 }, async () => {
    const bytes = (await stat(programPath)).size;
    const store = new RecordingExportJobStore(createFfmpegExportRunner(ffmpegPath));
    const job = await store.createJob({
      uploadId: 'upload-1',
      roomId: 'room-1',
      rootDir: dir,
      tracks: [{ id: 'program', label: 'Program', kind: 'program', mimeType: 'video/webm', filePath: programPath, bytesReceived: bytes, complete: true }],
    }, {
      basename: 'episode',
      video: { width: 320, height: 180, frameRate: 30, videoBitsPerSecond: 1_000_000 },
      edit: { keepRanges: [{ startSeconds: 0, endSeconds: 1 }, { startSeconds: 1.5, endSeconds: 3 }, { startSeconds: 4.2, endSeconds: 8 }] },
    });
    await store.startJob(job.exportId);
    const done = store.getJob(job.exportId);
    assert.equal(done.status, 'ready', done.error);

    const mp4 = store.getArtifact(job.exportId, 'final-mp4');
    const expected = 1 + 1.5 + 3.8;
    assert.ok(Math.abs(await mediaDuration(mp4.path, 'v') - expected) < 0.05, 'video keeps 6.3 s');
    assert.ok(Math.abs(await mediaDuration(mp4.path, 'a') - expected) < 0.05, 'audio keeps 6.3 s');

    // The flash (original 6.0 s) lands at 1 + 1.5 + 1.8 = 4.3 s, and the beep with it.
    const detect = await run(['-v', 'info', '-i', mp4.path, '-vf', 'blackdetect=d=0.05:pix_th=0.5', '-af', 'silencedetect=n=-30dB:d=0.05', '-f', 'null', '-']);
    const flashAt = Number(detect.stderr.match(/black_end:([\d.]+)/)?.[1]);
    const beepAt = Number(detect.stderr.match(/silence_end: ([\d.]+)/)?.[1]);
    assert.ok(Math.abs(flashAt - 4.3) < 0.05, `flash at ${flashAt}`);
    assert.ok(Math.abs(beepAt - 4.3) < 0.05, `beep at ${beepAt}`);
    assert.ok(Math.abs(flashAt - beepAt) < 0.04, `picture and sound stay within one frame (${flashAt} vs ${beepAt})`);

    const manifest = JSON.parse(await readFile(store.getArtifact(job.exportId, 'export-manifest').path, 'utf8'));
    assert.deepEqual(manifest.export.edit, { keptRanges: 3, keptSeconds: 6.3 });
  });
});
