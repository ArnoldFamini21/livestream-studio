import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildRecordingUploadTracks,
  downloadRecordingExportArtifact,
  pollRecordingExportJob,
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
      if (String(url).endsWith('/exports')) {
        return jsonResponse({
          exportId: 'export-1',
          uploadId: 'upload-1',
          roomId: 'room-1',
          sessionId: 'session-1',
          status: 'queued',
          createdAt: '2026-07-01T00:00:01.000Z',
          updatedAt: '2026-07-01T00:00:01.000Z',
          artifacts: [
            { id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'queued' },
          ],
        }, 202);
      }
      if (String(url).endsWith('/exports/export-1')) {
        return jsonResponse({
          exportId: 'export-1',
          uploadId: 'upload-1',
          roomId: 'room-1',
          sessionId: 'session-1',
          status: 'ready',
          createdAt: '2026-07-01T00:00:01.000Z',
          updatedAt: '2026-07-01T00:00:02.000Z',
          artifacts: [
            { id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'ready', bytes: 1_000 },
            { id: 'stem-1-wav', label: 'Host WAV stem', format: 'wav', status: 'ready', bytes: 500 },
            { id: 'export-manifest', label: 'Export manifest', format: 'json', status: 'ready', bytes: 300 },
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
      exportPollIntervalMs: 0,
      exportPollTimeoutMs: 1_000,
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
    assert.equal(summary.exportJob?.exportId, 'export-1');
    assert.equal(summary.exportJob?.status, 'ready');
    assert.deepEqual(summary.exportJob?.artifacts.map((artifact) => artifact.format), ['mp4', 'wav', 'json']);
    assert.deepEqual(progress, [262_144, 300_000]);
    assert.equal(calls.length, 6);
    assert.equal(calls[0].url, 'https://media.example.com/recordings/uploads');
    assert.match(calls[1].url, /sequence=0&offset=0/);
    assert.match(calls[2].url, /sequence=1&offset=262144&final=1/);
    assert.equal(calls[4].url, 'https://media.example.com/recordings/uploads/upload-1/exports');
    assert.equal(calls[5].url, 'https://media.example.com/recordings/uploads/upload-1/exports/export-1');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
    assert.equal((calls[1].init?.body as Blob).size, 262_144);
    assert.equal((calls[2].init?.body as Blob).size, 37_856);
  });

  it('polls export jobs until the media server reports ready or error', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return jsonResponse({
          exportId: 'export-2',
          uploadId: 'upload-2',
          roomId: 'room-1',
          status: 'running',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:01.000Z',
          artifacts: [{ id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'running' }],
        });
      }
      return jsonResponse({
        exportId: 'export-2',
        uploadId: 'upload-2',
        roomId: 'room-1',
        status: 'ready',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:02.000Z',
        artifacts: [{ id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'ready', bytes: 1234 }],
      });
    };

    const job = await pollRecordingExportJob({
      token: 'token-123',
      uploadId: 'upload-2',
      exportId: 'export-2',
      mediaHttpUrl: 'https://media.example.com',
      intervalMs: 0,
      timeoutMs: 1_000,
    });

    assert.equal(job.status, 'ready');
    assert.equal(job.artifacts[0].bytes, 1234);
    assert.deepEqual(calls, [
      'https://media.example.com/recordings/uploads/upload-2/exports/export-2',
      'https://media.example.com/recordings/uploads/upload-2/exports/export-2',
    ]);
  });

  it('downloads ready export artifacts with bearer auth and safe filenames', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-disposition': 'attachment; filename="Launch Demo Final.mp4"',
        },
      });
    };

    const download = await downloadRecordingExportArtifact({
      token: 'token-123',
      uploadId: 'upload-1',
      exportId: 'export-1',
      artifactId: 'final-mp4',
      artifactLabel: 'Final MP4',
      format: 'mp4',
      mediaHttpUrl: 'https://media.example.com',
    });

    assert.equal(download.fileName, 'Launch_Demo_Final.mp4');
    assert.equal(download.contentType, 'video/mp4');
    assert.equal(download.blob.size, 3);
    assert.equal(
      calls[0].url,
      'https://media.example.com/recordings/uploads/upload-1/exports/export-1/artifacts/final-mp4'
    );
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
  });

  it('downloads JSON export manifests with a JSON filename', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ exportType: 'recording-export-manifest' }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': 'attachment; filename="Launch Demo manifest.json"',
      },
    });

    const download = await downloadRecordingExportArtifact({
      token: 'token-123',
      uploadId: 'upload-1',
      exportId: 'export-1',
      artifactId: 'export-manifest',
      artifactLabel: 'Export manifest',
      format: 'json',
      mediaHttpUrl: 'https://media.example.com',
    });

    assert.equal(download.fileName, 'Launch_Demo_manifest.json');
    assert.equal(download.contentType, 'application/json');
  });

  it('surfaces export artifact download errors from the media server', async () => {
    globalThis.fetch = async () => jsonResponse({ error: 'Recording export artifact is not ready' }, 409);

    await assert.rejects(
      () => downloadRecordingExportArtifact({
        token: 'token-123',
        uploadId: 'upload-1',
        exportId: 'export-1',
        artifactId: 'final-mp4',
        mediaHttpUrl: 'https://media.example.com',
      }),
      /not ready/
    );
  });

  it('keeps the completed upload summary when export startup fails', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/recordings/uploads')) {
        return jsonResponse({
          uploadId: 'upload-no-export',
          roomId: 'room-1',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-01T06:00:00.000Z',
          maxBytes: 4,
          bytesReceived: 0,
          tracks: [],
        }, 201);
      }
      if (String(url).includes('/chunks')) {
        return jsonResponse({ uploadId: 'upload-no-export', track: { bytesReceived: 4 }, bytesReceived: 4 });
      }
      if (String(url).endsWith('/complete')) {
        return jsonResponse({
          uploadId: 'upload-no-export',
          roomId: 'room-1',
          createdAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-01T06:00:00.000Z',
          maxBytes: 4,
          bytesReceived: 4,
          tracks: [],
        });
      }
      if (String(url).endsWith('/exports')) {
        return jsonResponse({ error: 'FFmpeg binary is unavailable' }, 503);
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const summary = await uploadRecordingToMediaServer({
      token: 'token-123',
      roomId: 'room-1',
      mediaHttpUrl: 'https://media.example.com',
      files: [{ label: 'Program', fileName: 'program.webm', kind: 'program', blob: makeBlob(4, 'video/webm') }],
    });

    assert.equal(summary.uploadId, 'upload-no-export');
    assert.equal(summary.bytesReceived, 4);
    assert.match(summary.exportError || '', /FFmpeg binary/);
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
