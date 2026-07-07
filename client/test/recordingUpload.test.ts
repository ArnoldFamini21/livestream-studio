import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildRecordingUploadTracks,
  downloadRecordingExportArtifact,
  exportDistributedRecordingSession,
  getDistributedRecordingSession,
  getRecordingExportJob,
  pollRecordingExportJob,
  requestRecordingClipExport,
  uploadRecordingToMediaServer,
  waitForDistributedRecordingSession,
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
  it('builds MP4 and WebM track manifests with safe unique ids', () => {
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
      {
        label: 'Host WebCodecs bitstream',
        fileName: 'host-webcodecs.vp9',
        kind: 'video',
        blob: makeBlob(4, 'video/x-vp9'),
      },
    ]);

    assert.equal(skippedTracks, 1);
    assert.equal(tracks.length, 3);
    assert.equal(tracks[0].manifest.id, 'Show-Program');
    assert.equal(tracks[1].manifest.id, 'Show-Program-2');
    assert.equal(tracks[2].manifest.id, 'export');
    assert.equal(tracks[0].manifest.kind, 'program');
    assert.equal(tracks[2].manifest.kind, 'video');
    assert.equal(tracks[2].manifest.mimeType, 'video/mp4');
    assert.equal(tracks[0].manifest.expectedBytes, 8);
    assert.equal(tracks[0].manifest.durationMs, 5_000);
  });

  it('uploads recording tracks as bounded chunks and finalizes the session', async () => {
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
      participantId: 'host-1',
      participantName: 'Host program',
      mediaHttpUrl: 'https://media.example.com',
      chunkSizeBytes: 4,
      exportPollIntervalMs: 0,
      exportPollTimeoutMs: 1_000,
      exportVideoCodec: 'h265',
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
    assert.deepEqual(JSON.parse(String(calls[4].init?.body)), {
      basename: 'session-1',
      includeAudioStems: true,
      video: {
        codec: 'h265',
      },
    });
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)).participantId, 'host-1');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)).participantName, 'Host program');
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

  it('fetches one recording export status for manual library refresh', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        exportId: 'export-refresh',
        uploadId: 'upload-refresh',
        roomId: 'room-1',
        status: 'running',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:01.000Z',
        artifacts: [{ id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'running' }],
      });
    };

    const job = await getRecordingExportJob({
      token: 'token-123',
      uploadId: 'upload-refresh',
      exportId: 'export-refresh',
      mediaHttpUrl: 'https://media.example.com',
    });

    assert.equal(job.status, 'running');
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://media.example.com/recordings/uploads/upload-refresh/exports/export-refresh'
    );
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
  });

  it('requests frame-accurate clip exports on an existing upload and polls to ready', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse({
          exportId: 'export-clip',
          uploadId: 'upload-3',
          roomId: 'room-1',
          status: 'queued',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
          artifacts: [{ id: 'final-mp4', label: 'Final MP4 clip', format: 'mp4', status: 'queued' }],
        });
      }
      return jsonResponse({
        exportId: 'export-clip',
        uploadId: 'upload-3',
        roomId: 'room-1',
        status: 'ready',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:02.000Z',
        artifacts: [{ id: 'final-mp4', label: 'Final MP4 clip', format: 'mp4', status: 'ready', bytes: 2048 }],
      });
    };

    const job = await requestRecordingClipExport({
      token: 'token-123',
      uploadId: 'upload-3',
      clip: { startSeconds: 5, endSeconds: 65 },
      basename: 'Launch Demo clip',
      exportVideoCodec: 'h264',
      mediaHttpUrl: 'https://media.example.com',
      pollIntervalMs: 0,
      pollTimeoutMs: 1_000,
    });

    assert.equal(job.status, 'ready');
    assert.equal(job.artifacts[0].label, 'Final MP4 clip');
    assert.equal(calls[0].url, 'https://media.example.com/recordings/uploads/upload-3/exports');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-123');
    const requestBody = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(requestBody.clip, { startSeconds: 5, endSeconds: 65 });
    assert.equal(requestBody.includeAudioStems, false);
    assert.equal(requestBody.basename, 'Launch Demo clip');
    assert.equal(requestBody.video.codec, 'h264');
    assert.equal(
      calls.at(-1)?.url,
      'https://media.example.com/recordings/uploads/upload-3/exports/export-clip'
    );
  });

  it('waits for participant uploads and starts one combined recording export', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let sessionReads = 0;
    globalThis.fetch = async (url, init) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, init });
      if (requestUrl.endsWith('/recordings/sessions/room-1/recording-1') && (!init?.method || init.method === 'GET')) {
        sessionReads += 1;
        const completed = sessionReads >= 2 ? 2 : 1;
        return jsonResponse({
          roomId: 'room-1',
          sessionId: 'recording-1',
          uploadCount: completed,
          completedUploadCount: completed,
          trackCount: completed * 2,
          bytesReceived: completed * 100,
          uploads: [],
        });
      }
      if (requestUrl.endsWith('/recordings/sessions/room-1/recording-1/exports')) {
        return jsonResponse({
          exportId: 'combined-export',
          uploadId: 'program-upload',
          roomId: 'room-1',
          sessionId: 'recording-1',
          status: 'queued',
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:00.000Z',
          artifacts: [{ id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'queued' }],
        }, 202);
      }
      if (requestUrl.endsWith('/recordings/uploads/program-upload/exports/combined-export')) {
        return jsonResponse({
          exportId: 'combined-export',
          uploadId: 'program-upload',
          roomId: 'room-1',
          sessionId: 'recording-1',
          status: 'ready',
          createdAt: '2026-07-05T00:00:00.000Z',
          updatedAt: '2026-07-05T00:00:01.000Z',
          artifacts: [{ id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'ready' }],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const initial = await getDistributedRecordingSession({
      token: 'host-token',
      roomId: 'room-1',
      sessionId: 'recording-1',
      mediaHttpUrl: 'https://media.example.com',
    });
    const ready = await waitForDistributedRecordingSession({
      token: 'host-token',
      roomId: 'room-1',
      sessionId: 'recording-1',
      expectedUploads: 2,
      intervalMs: 0,
      timeoutMs: 1_000,
      mediaHttpUrl: 'https://media.example.com',
    });
    const job = await exportDistributedRecordingSession({
      token: 'host-token',
      roomId: 'room-1',
      sessionId: 'recording-1',
      basename: 'Combined show',
      pollIntervalMs: 0,
      pollTimeoutMs: 1_000,
      mediaHttpUrl: 'https://media.example.com',
    });

    assert.equal(initial.completedUploadCount, 1);
    assert.equal(ready.completedUploadCount, 2);
    assert.equal(job.status, 'ready');
    const exportCall = calls.find((call) => call.url.endsWith('/recording-1/exports'));
    assert.deepEqual(JSON.parse(String(exportCall?.init?.body)), {
      basename: 'Combined show',
      includeAudioStems: true,
      video: { codec: 'h264' },
    });
    assert.equal((exportCall?.init?.headers as Record<string, string>).Authorization, 'Bearer host-token');
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

  it('rejects uploads when no MP4 or WebM tracks are available', async () => {
    await assert.rejects(
      () => uploadRecordingToMediaServer({
        token: 'token-123',
        roomId: 'room-1',
        mediaHttpUrl: 'https://media.example.com',
        files: [{ label: 'Video bitstream', fileName: 'video.vp9', kind: 'video', blob: makeBlob(4, 'video/x-vp9') }],
      }),
      /No uploadable MP4 or WebM recording tracks/
    );
  });
});
