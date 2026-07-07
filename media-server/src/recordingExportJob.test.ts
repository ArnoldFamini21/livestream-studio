import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RecordingExportCommand } from './recordingExport.js';
import {
  RecordingExportJobError,
  RecordingExportJobStore,
  type RecordingExportArtifactUploadInput,
  type RecordingExportRunner,
} from './recordingExportJob.js';
import { RecordingUploadStore } from './recordingUpload.js';

async function createCompletedUpload() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recording-export-job-test-'));
  const uploads = new RecordingUploadStore(root);
  const session = await uploads.createSession({
    roomId: 'room-123',
    sessionId: 'session-123',
    tracks: [
      { id: 'program', label: 'Program mix', kind: 'program', mimeType: 'video/webm', expectedBytes: 7, durationMs: 65_000 },
      { id: 'host-camera', label: 'Host camera', kind: 'video', mimeType: 'video/webm', expectedBytes: 6, durationMs: 65_000 },
      { id: 'host-audio', label: 'Host audio', kind: 'audio', mimeType: 'audio/webm', expectedBytes: 5, durationMs: 65_000 },
    ],
  });
  await uploads.appendChunk({
    uploadId: session.uploadId,
    trackId: 'program',
    sequence: 0,
    final: true,
    data: Buffer.from('program'),
  });
  await uploads.appendChunk({
    uploadId: session.uploadId,
    trackId: 'host-camera',
    sequence: 0,
    final: true,
    data: Buffer.from('camera'),
  });
  await uploads.appendChunk({
    uploadId: session.uploadId,
    trackId: 'host-audio',
    sequence: 0,
    final: true,
    data: Buffer.from('audio'),
  });
  uploads.completeSession(session.uploadId);
  return {
    root,
    uploads,
    session,
  };
}

describe('recording export jobs', () => {
  it('creates a private FFmpeg export job from completed uploaded WebM tracks', async () => {
    const { uploads: uploadStore, session } = await createCompletedUpload();
    const commands: RecordingExportCommand[] = [];
    const artifactUploads: RecordingExportArtifactUploadInput[] = [];
    const runner: RecordingExportRunner = async (command) => {
      commands.push(command);
      await writeFile(command.outputPath, Buffer.from(command.label));
    };
    const exports = new RecordingExportJobStore(runner, async (input) => {
      artifactUploads.push(input);
      return {
        provider: 's3',
        bucket: 'recordings',
        key: `exports/${input.exportId}/${input.artifactId}`,
        uploadedAt: '2026-07-01T20:00:00.000Z',
      };
    });

    const queued = await exports.createJob(uploadStore.getExportSource(session.uploadId), {
      basename: 'Launch Demo',
      includeAudioStems: true,
    });

    assert.equal(queued.uploadId, session.uploadId);
    assert.equal(queued.roomId, 'room-123');
    assert.equal(queued.sessionId, 'session-123');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.artifacts.length, 7);
    assert.equal(queued.artifacts.some((artifact) => 'outputPath' in artifact), false);
    assert.deepEqual(queued.artifacts.map((artifact) => artifact.format), ['mp4', 'mp4', 'wav', 'mp3', 'wav', 'mp3', 'json']);
    assert.equal(queued.artifacts[1].id, 'isolated-video-host-camera');

    await exports.startJob(queued.exportId);
    const ready = exports.getJob(queued.exportId, session.uploadId);

    assert.equal(ready.status, 'ready');
    assert.equal(commands.length, 6);
    assert.equal(artifactUploads.length, 7);
    assert.equal(artifactUploads[0].artifactId, 'final-mp4');
    assert.equal(artifactUploads[0].contentType, 'video/mp4');
    assert.equal(artifactUploads.at(-1)?.artifactId, 'export-manifest');
    assert.equal(artifactUploads.at(-1)?.contentType, 'application/json');
    assert.equal(ready.artifacts.every((artifact) => artifact.status === 'ready'), true);
    assert.equal(ready.artifacts.every((artifact) => typeof artifact.bytes === 'number' && artifact.bytes > 0), true);
    assert.equal(ready.artifacts.every((artifact) => artifact.storage?.provider === 's3'), true);
    assert.match(commands[0].outputPath, /Launch_Demo\.mp4$/);
    assert.equal(commands[0].args.includes('libx264'), true);

    const artifact = exports.getArtifact(queued.exportId, 'final-mp4', session.uploadId);
    assert.equal(artifact.format, 'mp4');
    assert.match(artifact.path, /Launch_Demo\.mp4$/);

    const isolatedVideo = exports.getArtifact(queued.exportId, 'isolated-video-host-camera', session.uploadId);
    assert.equal(isolatedVideo.format, 'mp4');
    assert.match(isolatedVideo.path, /Launch_Demo_Host_camera_video\.mp4$/);

    const manifest = exports.getArtifact(queued.exportId, 'export-manifest', session.uploadId);
    assert.equal(manifest.format, 'json');
    assert.match(manifest.path, /Launch_Demo_manifest\.json$/);
    const manifestJson = JSON.parse(await readFile(manifest.path, 'utf8')) as {
      exportType: string;
      export: { exportId: string };
      tracks: Array<{ durationMs?: number }>;
      artifacts: Array<{ format: string; storage?: { provider: string; key: string } }>;
    };
    assert.equal(manifestJson.exportType, 'recording-export-manifest');
    assert.equal(manifestJson.export.exportId, queued.exportId);
    assert.equal(manifestJson.tracks[0].durationMs, 65_000);
    assert.deepEqual(manifestJson.artifacts.map((item) => item.format), ['mp4', 'mp4', 'wav', 'mp3', 'wav', 'mp3']);
    assert.equal(manifestJson.artifacts.every((item) => item.storage?.provider === 's3'), true);
    assert.equal(manifestJson.artifacts[0].storage?.key, `exports/${queued.exportId}/final-mp4`);
  });

  it('can create a final-MP4-only export job', async () => {
    const { uploads, session } = await createCompletedUpload();
    const commands: RecordingExportCommand[] = [];
    const runner: RecordingExportRunner = async (command) => {
      commands.push(command);
      await writeFile(command.outputPath, Buffer.from(command.label));
    };
    const exports = new RecordingExportJobStore(runner);

    const queued = await exports.createJob(uploads.getExportSource(session.uploadId), {
      includeAudioStems: false,
      video: { codec: 'h265' },
    });

    assert.deepEqual(queued.artifacts.map((artifact) => artifact.format), ['mp4', 'mp4', 'json']);
    await exports.startJob(queued.exportId);
    assert.equal(commands.length, 2);
    assert.equal(commands.every((command) => command.args.includes('libx265')), true);
    assert.equal(commands.every((command) => command.args.includes('hvc1')), true);
    assert.equal(commands.every((command) => !command.args.includes('libx264')), true);
  });

  it('marks the export job as failed when configured artifact storage fails', async () => {
    const { uploads, session } = await createCompletedUpload();
    const runner: RecordingExportRunner = async (command) => {
      await writeFile(command.outputPath, Buffer.from(command.label));
    };
    const exports = new RecordingExportJobStore(runner, async () => {
      throw new Error('object storage unavailable');
    });

    const queued = await exports.createJob(uploads.getExportSource(session.uploadId), {
      basename: 'Storage Failure',
      includeAudioStems: false,
    });
    await exports.startJob(queued.exportId);
    const failed = exports.getJob(queued.exportId, session.uploadId);

    assert.equal(failed.status, 'error');
    assert.equal(failed.artifacts[0].status, 'error');
    assert.equal(failed.artifacts[0].error, 'object storage unavailable');
    assert.equal(failed.artifacts[1].status, 'error');
  });

  it('rejects export jobs before all declared upload tracks are complete and non-empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'recording-export-incomplete-test-'));
    const uploads = new RecordingUploadStore(root);
    const session = await uploads.createSession({
      roomId: 'room-123',
      tracks: [
        { id: 'program', label: 'Program mix', kind: 'program', mimeType: 'video/webm' },
      ],
    });
    const exports = new RecordingExportJobStore(async () => {});

    await assert.rejects(
      () => exports.createJob(uploads.getExportSource(session.uploadId)),
      (err) => err instanceof RecordingExportJobError && err.code === 'RECORDING_EXPORT_UPLOAD_INCOMPLETE'
    );

    uploads.completeSession(session.uploadId);
    await assert.rejects(
      () => exports.createJob(uploads.getExportSource(session.uploadId)),
      (err) => err instanceof RecordingExportJobError && err.code === 'RECORDING_EXPORT_TRACK_EMPTY'
    );
  });
  it('creates frame-accurate clip export jobs when a clip range is requested', async () => {
    const { uploads, session } = await createCompletedUpload();
    const commands: RecordingExportCommand[] = [];
    const runner: RecordingExportRunner = async (command) => {
      commands.push(command);
      await writeFile(command.outputPath, Buffer.from(command.label));
    };
    const exports = new RecordingExportJobStore(runner);

    const queued = await exports.createJob(uploads.getExportSource(session.uploadId), {
      basename: 'Launch Demo',
      includeAudioStems: true,
      clip: { startSeconds: 5, endSeconds: 65 },
    });

    assert.equal(queued.status, 'queued');
    assert.equal(queued.artifacts[0].label, 'Final MP4 clip');

    await exports.startJob(queued.exportId);
    const ready = exports.getJob(queued.exportId, session.uploadId);
    assert.equal(ready.status, 'ready');

    const mp4 = exports.getArtifact(queued.exportId, 'final-mp4', session.uploadId);
    assert.match(mp4.path, /Launch_Demo_clip_0m05s-1m05s\.mp4$/);
    for (const command of commands) {
      const seekIndex = command.args.indexOf('-ss');
      assert.ok(seekIndex > -1, `${command.label} should seek to the clip start`);
      assert.equal(command.args[seekIndex + 1], '5.000');
      const durationIndex = command.args.indexOf('-t');
      assert.ok(durationIndex > -1, `${command.label} should bound the clip duration`);
      assert.equal(command.args[durationIndex + 1], '60.000');
    }

    const manifest = exports.getArtifact(queued.exportId, 'export-manifest', session.uploadId);
    const parsed = JSON.parse(await readFile(manifest.path, 'utf8'));
    assert.deepEqual(parsed.export.clip, { startSeconds: 5, endSeconds: 65, aspect: 'source' });
  });

  it('rejects invalid clip ranges before creating a job', async () => {
    const { uploads, session } = await createCompletedUpload();
    const exports = new RecordingExportJobStore(async () => {});

    await assert.rejects(
      () => exports.createJob(uploads.getExportSource(session.uploadId), {
        clip: { startSeconds: 65, endSeconds: 5 },
      }),
      (err) => err instanceof RecordingExportJobError
        && err.code === 'RECORDING_EXPORT_INVALID_CLIP'
        && err.statusCode === 400
    );

    await assert.rejects(
      () => exports.createJob(uploads.getExportSource(session.uploadId), {
        clip: { startSeconds: 0 },
      }),
      (err) => err instanceof RecordingExportJobError && err.code === 'RECORDING_EXPORT_INVALID_CLIP'
    );
  });

  it('omits clip metadata from the manifest when no clip is requested', async () => {
    const { uploads, session } = await createCompletedUpload();
    const runner: RecordingExportRunner = async (command) => {
      await writeFile(command.outputPath, Buffer.from(command.label));
    };
    const exports = new RecordingExportJobStore(runner);

    const queued = await exports.createJob(uploads.getExportSource(session.uploadId), {
      basename: 'Launch Demo',
    });
    await exports.startJob(queued.exportId);

    const manifest = exports.getArtifact(queued.exportId, 'export-manifest', session.uploadId);
    const parsed = JSON.parse(await readFile(manifest.path, 'utf8'));
    assert.equal(parsed.export.clip, null);
  });
});
