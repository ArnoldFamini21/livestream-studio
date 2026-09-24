import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFfmpegLiveBackupArgs,
  fromStoredLiveBackupRecord,
  parseStoredLiveBackupRecord,
  storeLiveBackupRecording,
  getLiveBackupMaxBytes,
  isLiveBackupRecordingEnabled,
  sanitizeLiveBackupFilePart,
  toLiveBackupPublicStatus,
  type LiveBackupRecording,
} from './liveBackupRecording.js';

describe('live backup recording utilities', () => {
  it('normalizes backup recording env flags and byte limits', () => {
    assert.equal(isLiveBackupRecordingEnabled({}), true);
    assert.equal(isLiveBackupRecordingEnabled({ RTMP_BACKUP_RECORDING_ENABLED: 'false' }), false);
    assert.equal(isLiveBackupRecordingEnabled({ LIVE_BACKUP_RECORDING_ENABLED: 'off' }), false);

    assert.equal(getLiveBackupMaxBytes({ RTMP_BACKUP_RECORDING_MAX_BYTES: String(32 * 1024 * 1024) }), 64 * 1024 * 1024);
    assert.equal(getLiveBackupMaxBytes({ RTMP_BACKUP_RECORDING_MAX_BYTES: String(128 * 1024 * 1024) }), 128 * 1024 * 1024);
  });

  it('builds safe live backup file parts', () => {
    assert.equal(sanitizeLiveBackupFilePart('room 123/live', 'room'), 'room-123-live');
    assert.equal(sanitizeLiveBackupFilePart('...', 'room'), 'room');
  });

  it('builds bounded FFmpeg MP4 backup args', () => {
    const args = createFfmpegLiveBackupArgs('/tmp/live-backup.mp4', {
      video: {
        width: 1920,
        height: 1080,
        frameRate: 30,
        videoBitsPerSecond: 4_500_000,
      },
      audio: {
        sampleRate: 48_000,
        channelCount: 2,
        audioBitsPerSecond: 160_000,
      },
      maxBytes: 256 * 1024 * 1024,
    });

    assert.equal(args.includes('libx264'), true);
    assert.equal(args.includes('aac'), true);
    assert.equal(args.includes('+faststart'), true);
    assert.equal(args.includes('-fs'), true);
    assert.equal(args[args.indexOf('-fs') + 1], String(256 * 1024 * 1024));
    assert.equal(args.at(-1), '/tmp/live-backup.mp4');
  });

  it('exposes download path only when a backup is ready', () => {
    const recording: LiveBackupRecording = {
      backupId: 'backup-123',
      roomId: 'room-123',
      fileName: 'room-123-live-backup.mp4',
      filePath: '/tmp/room-123-live-backup.mp4',
      startedAt: '2026-07-01T21:00:00.000Z',
      stoppedAt: '2026-07-01T21:30:00.000Z',
      status: 'ready',
      sizeBytes: 1234,
    };

    assert.equal(toLiveBackupPublicStatus(recording).downloadPath, '/rtmp/backups/backup-123/download');
    recording.status = 'finalizing';
    assert.equal(toLiveBackupPublicStatus(recording).downloadPath, undefined);
  });
});

describe('live backup cloud storage', () => {
  const keys = { video: 'p/rooms/r/live-backups/show.mp4', record: 'p/live-backups/b1.json', latest: 'p/rooms/r/live-backups/latest.json' };

  async function readyRecording(): Promise<LiveBackupRecording> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'live-backup-store-'));
    const filePath = path.join(dir, 'show.mp4');
    await writeFile(filePath, 'mp4 bytes');
    return {
      backupId: 'b1',
      roomId: 'r',
      fileName: 'show.mp4',
      filePath,
      startedAt: '2026-01-01T00:00:00.000Z',
      stoppedAt: '2026-01-01T01:00:00.000Z',
      status: 'ready',
      sizeBytes: 9,
    };
  }

  it('uploads the MP4, saves findable records, and frees the local copy', async () => {
    const recording = await readyRecording();
    const uploads: string[] = [];
    const texts = new Map<string, string>();
    const pending = storeLiveBackupRecording(recording, {
      keys,
      uploadFile: async (input) => { uploads.push(`${input.key} ${input.contentType}`); },
      putText: async (key, body) => { texts.set(key, body); },
    });
    assert.equal(toLiveBackupPublicStatus(recording).storageStatus, 'uploading');
    await pending;

    assert.deepEqual(uploads, ['p/rooms/r/live-backups/show.mp4 video/mp4']);
    assert.equal(recording.storageStatus, 'stored');
    assert.equal(recording.storageKey, keys.video);
    assert.equal(existsSync(recording.filePath), false);
    assert.equal(texts.get(keys.record), texts.get(keys.latest));
    const record = parseStoredLiveBackupRecord(texts.get(keys.record) || null);
    assert.deepEqual(record, {
      backupId: 'b1',
      roomId: 'r',
      fileName: 'show.mp4',
      startedAt: '2026-01-01T00:00:00.000Z',
      stoppedAt: '2026-01-01T01:00:00.000Z',
      sizeBytes: 9,
      storageKey: keys.video,
    });

    // After a restart the record alone describes a ready, stored backup.
    const restored = toLiveBackupPublicStatus(fromStoredLiveBackupRecord(record!, ''));
    assert.equal(restored.status, 'ready');
    assert.equal(restored.storageStatus, 'stored');
    assert.equal(restored.downloadPath, '/rtmp/backups/b1/download');
  });

  it('keeps the local copy when the upload fails', async () => {
    const recording = await readyRecording();
    await storeLiveBackupRecording(recording, {
      keys,
      uploadFile: async () => { throw new Error('storage down'); },
      putText: async () => { throw new Error('unreachable'); },
    });
    assert.equal(recording.storageStatus, 'failed');
    assert.equal(recording.storageError, 'storage down');
    assert.equal(recording.storageKey, undefined);
    assert.equal(existsSync(recording.filePath), true);
  });

  it('keeps a stored backup stored when only its records fail', async () => {
    const recording = await readyRecording();
    await storeLiveBackupRecording(recording, {
      keys,
      uploadFile: async () => undefined,
      putText: async () => { throw new Error('records down'); },
    });
    assert.equal(recording.storageStatus, 'stored');
    assert.equal(recording.storageKey, keys.video);
  });

  it('rejects damaged records', () => {
    assert.equal(parseStoredLiveBackupRecord(null), null);
    assert.equal(parseStoredLiveBackupRecord('not json'), null);
    assert.equal(parseStoredLiveBackupRecord(JSON.stringify({ backupId: 'b1', roomId: 'r' })), null);
  });
});
