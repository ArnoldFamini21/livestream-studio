import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  downloadRtmpBackupRecording,
  pollRtmpBackupRecording,
} from '../src/utils/rtmpBackupRecording.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RTMP live backup recording client helpers', () => {
  it('polls latest backup recording until it is ready', async () => {
    const calls: string[] = [];
    let attempt = 0;
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
      attempt += 1;
      return jsonResponse({
        backupId: 'backup-1',
        roomId: 'room-1',
        fileName: 'room-1-live-backup.mp4',
        startedAt: '2026-07-01T21:00:00.000Z',
        status: attempt === 1 ? 'finalizing' : 'ready',
        downloadPath: attempt === 1 ? undefined : '/rtmp/backups/backup-1/download',
      });
    };

    const backup = await pollRtmpBackupRecording({
      token: 'token-123',
      roomId: 'room-1',
      mediaHttpUrl: 'https://media.example.com',
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    assert.equal(backup?.status, 'ready');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'https://media.example.com/rtmp/backups/latest?roomId=room-1');
  });

  it('returns null when no backup recording exists', async () => {
    globalThis.fetch = async () => jsonResponse({ error: 'not found' }, 404);

    const backup = await pollRtmpBackupRecording({
      token: 'token-123',
      roomId: 'room-1',
      mediaHttpUrl: 'https://media.example.com',
      intervalMs: 1,
      timeoutMs: 10,
    });

    assert.equal(backup, null);
  });

  it('downloads a ready backup recording with bearer auth', async () => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://media.example.com/rtmp/backups/backup-1/download');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-disposition': 'attachment; filename="backup.mp4"',
        },
      });
    };

    const download = await downloadRtmpBackupRecording({
      token: 'token-123',
      mediaHttpUrl: 'https://media.example.com',
      backup: {
        backupId: 'backup-1',
        roomId: 'room-1',
        fileName: 'fallback.mp4',
        startedAt: '2026-07-01T21:00:00.000Z',
        status: 'ready',
        downloadPath: '/rtmp/backups/backup-1/download',
      },
    });

    assert.equal(download.fileName, 'backup.mp4');
    assert.equal(download.contentType, 'video/mp4');
    assert.equal(download.blob.size, 3);
  });
});
