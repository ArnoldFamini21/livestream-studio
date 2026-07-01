import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildRecordingUploadTracks,
  uploadRecordingToMediaServer,
} from '../src/utils/recordingUpload.ts';

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

function makeBlob(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size).fill(1)], { type });
}

describe('recording media-server upload helper', () => {
  it('builds WebM-only track manifests with safe unique ids', () => {
    const { tracks, skippedTracks } = buildRecordingUploadTracks([
      {
        label: 'Program Mix',
        fileName: 'Show Program.webm',
        kind: 'program',
        blob: makeBlob(8, 'video/webm;codecs=vp9,opus'),
        capture: {
          sourceId: 'program',
          sourceKind: 'program',
          sourceLabel: 'Program',
          mimeType: 'video/webm',
          requestedBitsPerSecond: 10_000_000,
          startedAt: '2026-07-01T00:00:00.000Z',
          stoppedAt: '2026-07-01T00:00:05.000Z',
          durationMs: 5_000,
          trackCount: 2,
          tracks: [],
        },
      },
      {
        label: 'Program Mix Copy',
        fileName: 'Show Program.webm',
        kind: 'program',
        blob: makeBlob(4, 'video/webm'),
      },
      {
        label: 'MP4 export',
        fileName: 'export.mp4',
        kind: 'video',
        blob: makeBlob(4, 'video/mp4'),
      },
    ]);

    assert.equal(skippedTracks, 1);
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].manifest.id, 'Show-Program');
    assert.equal(tracks[1].manifest.id, 'Show-Program-2');
    assert.equal(tracks[0].manifest.kind, 'program');
    assert.equal(tracks[0].manifest.expectedBytes, 8);
    assert.equal(tracks[0].manifest.durationMs, 5_000);
  });

  it('uploads WebM tracks as bounded chunks and finalizes the session', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/recordings/uploads')) {
        return jsonResponse({
          uploadId: 'upload-1',
          roomId: 'room-1',
          sessionId: 'session-1',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-01T06:00:00.000Z',
          maxBytes: 10,
          bytesReceived: 0,
          tracks: [],
        }, 201);
      }
      if (String(url).includes('/chunks?sequence=0')) {
        return jsonResponse({ uploadId: 'upload-1', track: { bytesReceived: 262_144 }, bytesReceived: 262_144 });
      }
      if (String(url).includes('/chunks?sequence=1')) {
        return jsonResponse({ uploadId: 'upload-1', track: { bytesReceived: 300_000 }, bytesReceived: 300_000 });
      }
      if (String(url).endsWith('/complete')) {
        return jsonResponse({
          uploadId: 'upload-1',
          roomId: 'room-1',
          sessionId: 'session-1',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-01T06:00:00.000Z',
          maxBytes: 300_000,
          bytesReceived: 300_000,
          tracks: [
            {
              id: 'program',
              label: 'Program',
              kind: 'program',
              mimeType: 'video/webm',
              bytesReceived: 300_000,
              chunksReceived: 2,
              complete: true,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const progress: number[] = [];
    const summary = await uploadRecordingToMediaServer({
      token: 'token-123',
      roomId: 'room-1',
      sessionId: 'session-1',
      mediaHttpUrl: 'https://media.example.com',
      chunkSizeBytes: 4,
      files: [
        {
          label: 'Program',
          fileName: 'program.webm',
          kind: 'program',
          blob: makeBlob(300_000, 'video/webm'),
        },
      ],
      onProgress: (next) => progress.push(next.bytesUploaded),
    });

    assert.equal(summary.uploadId, 'upload-1');
    assert.equal(summary.bytesReceived, 300_000);
    assert.equal(summary.uploadedTracks, 1);
    assert.deepEqual(progress, [262_144, 300_000]);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, 'https://media.example.com/recordings/uploads');
    assert.match(calls[1].url, /sequence=0&offset=0/);
    assert.match(calls[2].url, /sequence=1&offset=262144&final=1/);
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
    assert.equal((calls[1].init?.body as Blob).size, 262_144);
    assert.equal((calls[2].init?.body as Blob).size, 37_856);
  });

  it('cleans up the upload session after a chunk failure', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push(`${init?.method || 'GET'} ${String(url)}`);
      if (String(url).endsWith('/recordings/uploads')) {
        return jsonResponse({
          uploadId: 'upload-fail',
          roomId: 'room-1',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-01T06:00:00.000Z',
          maxBytes: 4,
          bytesReceived: 0,
          tracks: [],
        }, 201);
      }
      if (String(url).includes('/chunks')) {
        return jsonResponse({ error: 'chunk rejected' }, 409);
      }
      if (String(url).endsWith('/recordings/uploads/upload-fail')) {
        return jsonResponse({ deleted: true });
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    await assert.rejects(
      () => uploadRecordingToMediaServer({
        token: 'token-123',
        roomId: 'room-1',
        mediaHttpUrl: 'https://media.example.com',
        files: [{ label: 'Program', fileName: 'program.webm', kind: 'program', blob: makeBlob(4, 'video/webm') }],
      }),
      /chunk rejected/
    );

    assert.deepEqual(calls, [
      'POST https://media.example.com/recordings/uploads',
      'POST https://media.example.com/recordings/uploads/upload-fail/tracks/program/chunks?sequence=0&offset=0&final=1',
      'DELETE https://media.example.com/recordings/uploads/upload-fail',
    ]);
  });

  it('rejects uploads when no WebM tracks are available', async () => {
    await assert.rejects(
      () => uploadRecordingToMediaServer({
        token: 'token-123',
        roomId: 'room-1',
        mediaHttpUrl: 'https://media.example.com',
        files: [{ label: 'Video', fileName: 'video.mp4', kind: 'video', blob: makeBlob(4, 'video/mp4') }],
      }),
      /No WebM recording tracks/
    );
  });
});
