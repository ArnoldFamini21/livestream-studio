import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFfmpegLiveBackupArgs,
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
