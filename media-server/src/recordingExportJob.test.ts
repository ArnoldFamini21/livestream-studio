import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RecordingExportCommand } from './recordingExport.js';
import {
  RecordingExportJobError,
  RecordingExportJobStore,
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
      { id: 'program', label: 'Program mix', kind: 'program', mimeType: 'video/webm', expectedBytes: 7 },
      { id: 'host-audio', label: 'Host audio', kind: 'audio', mimeType: 'audio/webm', expectedBytes: 5 },
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
    });

    assert.equal(queued.uploadId, session.uploadId);
    assert.equal(queued.roomId, 'room-123');
    assert.equal(queued.sessionId, 'session-123');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.artifacts.length, 5);
    assert.equal(queued.artifacts.some((artifact) => 'outputPath' in artifact), false);
    assert.deepEqual(queued.artifacts.map((artifact) => artifact.format), ['mp4', 'wav', 'mp3', 'wav', 'mp3']);

    await exports.startJob(queued.exportId);
    const ready = exports.getJob(queued.exportId, session.uploadId);

    assert.equal(ready.status, 'ready');
    assert.equal(commands.length, 5);
    assert.equal(ready.artifacts.every((artifact) => artifact.status === 'ready'), true);
    assert.equal(ready.artifacts.every((artifact) => typeof artifact.bytes === 'number' && artifact.bytes > 0), true);
    assert.match(commands[0].outputPath, /Launch_Demo\.mp4$/);
    assert.equal(commands[0].args.includes('libx264'), true);

    const artifact = exports.getArtifact(queued.exportId, 'final-mp4', session.uploadId);
    assert.equal(artifact.format, 'mp4');
    assert.match(artifact.path, /Launch_Demo\.mp4$/);
  });

  it('can create a final-MP4-only export job', async () => {
    const { uploads, session } = await createCompletedUpload();
    const runner: RecordingExportRunner = async (command) => {
      await writeFile(command.outputPath, Buffer.from(command.label));
    };
    const exports = new RecordingExportJobStore(runner);

    const queued = await exports.createJob(uploads.getExportSource(session.uploadId), {
      includeAudioStems: false,
    });

    assert.deepEqual(queued.artifacts.map((artifact) => artifact.format), ['mp4']);
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
});
