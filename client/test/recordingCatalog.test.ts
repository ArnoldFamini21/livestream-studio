import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalRecordingSession } from '../src/hooks/useRecordingLibrary.ts';
import { buildRecordingCatalogUpsertRequest } from '../src/utils/recordingCatalog.ts';

describe('recording catalog helpers', () => {
  it('summarizes local recording sessions without recording blobs', () => {
    const session: LocalRecordingSession = {
      id: 'recording-1',
      roomName: 'Launch Recording',
      createdAt: '2026-07-02T13:00:00.000Z',
      durationSeconds: 1850,
      trackCount: 3,
      totalBytes: 5_242_880,
      files: [
        {
          id: 'file-1',
          label: 'Program mix',
          fileName: 'program.webm',
          type: 'video/webm',
          size: 5_242_880,
          kind: 'program',
        },
      ],
      markers: [
        {
          id: 'marker-1',
          label: 'Intro',
          seconds: 0,
          createdAt: '2026-07-02T13:00:10.000Z',
        },
      ],
      cloud: {
        provider: 'google-drive',
        folderId: 'drive-folder-1',
        webViewLink: 'https://drive.google.com/drive/folders/drive-folder-1',
        uploadedAt: '2026-07-02T14:00:00.000Z',
        expiresAt: '2026-08-01T14:00:00.000Z',
        retentionPolicyId: 'cloud-30-days',
        permanent: false,
        fileCount: 4,
        totalBytes: 8_000_000,
      },
      mediaExport: {
        uploadId: 'upload-1',
        exportId: 'export-1',
        roomId: 'room-1',
        sessionId: 'recording-1',
        status: 'ready',
        createdAt: '2026-07-02T14:01:00.000Z',
        updatedAt: '2026-07-02T14:02:00.000Z',
        savedAt: '2026-07-02T14:03:00.000Z',
        artifacts: [
          {
            id: 'final-mp4',
            label: 'Launch Recording.mp4',
            format: 'mp4',
            status: 'ready',
            bytes: 10_000_000,
          },
          {
            id: 'manifest',
            label: 'Manifest',
            format: 'json',
            status: 'queued',
          },
        ],
      },
    };

    const request = buildRecordingCatalogUpsertRequest(session);

    assert.deepEqual(Object.keys(request).sort(), [
      'cloud',
      'createdAt',
      'durationSeconds',
      'id',
      'markerCount',
      'mediaExport',
      'roomName',
      'totalBytes',
      'trackCount',
    ]);
    assert.equal(request.id, 'recording-1');
    assert.equal(request.markerCount, 1);
    assert.equal(request.cloud?.fileCount, 4);
    assert.equal(request.cloud?.permanent, false);
    assert.equal(request.mediaExport?.readyMp4, true);
    assert.equal(request.mediaExport?.artifactCount, 2);
    assert.equal(request.mediaExport?.readyArtifactCount, 1);
  });
});
