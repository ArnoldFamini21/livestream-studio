import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalRecordingSession } from '../src/hooks/useRecordingLibrary.ts';
import {
  buildRecordingLibraryDashboardSummary,
  buildRecordingLibraryCatalogCsv,
  buildRecordingLibraryCatalogFilename,
  filterRecordingLibrarySessions,
  getReadyFinalMp4ShareUrl,
  getRecordingArtifactShareUrl,
  getReadyFinalMp4Artifact,
  getRecordingCloudRetentionLabel,
  hasReadyFinalMp4Export,
  isRecordingMediaExportRefreshable,
  isRawWebCodecsBitstreamFile,
  isPreviewableRecordingFile,
} from '../src/components/RecordingPanel.tsx';
import { getRecordingCloudRetentionExpiresAt } from '../src/hooks/useRecordingLibrary.ts';

const sessions: LocalRecordingSession[] = [
  {
    id: 'recording-1',
    roomName: 'Weekly Launch Show',
    createdAt: '2026-06-01T12:00:00.000Z',
    durationSeconds: 1800,
    trackCount: 3,
    totalBytes: 1024,
    files: [
      {
        id: 'recording-1-track-1',
        label: 'Host audio',
        fileName: 'weekly_launch_host_audio.webm',
        size: 256,
        type: 'audio/webm',
        kind: 'audio',
      },
      {
        id: 'recording-1-track-2',
        label: 'Host camera',
        fileName: 'weekly_launch_host_camera.webm',
        size: 512,
        type: 'video/webm',
        kind: 'video',
      },
      {
        id: 'recording-1-track-3',
        label: 'Deck screen',
        fileName: 'weekly_launch_deck_screen.webm',
        size: 256,
        type: 'video/webm',
        kind: 'screen',
      },
    ],
    markers: [
      {
        id: 'marker-1',
        label: 'Product demo',
        seconds: 420,
        createdAt: '2026-06-01T12:07:00.000Z',
      },
    ],
  },
  {
    id: 'recording-2',
    roomName: 'Podcast Interview',
    createdAt: '2026-06-02T15:00:00.000Z',
    durationSeconds: 2400,
    trackCount: 1,
    totalBytes: 512,
    files: [
      {
        id: 'recording-2-track-1',
        label: 'Guest audio',
        fileName: 'podcast_guest_audio.webm',
        size: 512,
        type: 'audio/webm',
        kind: 'audio',
      },
    ],
    markers: [],
    cloud: {
      provider: 'google-drive',
      folderId: 'drive-folder-123',
      webViewLink: 'https://drive.google.com/drive/folders/drive-folder-123',
      uploadedAt: '2026-06-02T16:00:00.000Z',
      expiresAt: '2026-07-02T16:00:00.000Z',
      retentionPolicyId: 'cloud-30-days',
      permanent: false,
      fileCount: 4,
      totalBytes: 4096,
    },
  },
  {
    id: 'recording-3',
    roomName: 'Design Review',
    createdAt: '2026-06-03T09:00:00.000Z',
    durationSeconds: 900,
    trackCount: 1,
    totalBytes: 768,
    files: [
      {
        id: 'recording-3-track-1',
        label: 'Figma screen share',
        fileName: 'design_review_screen.webm',
        size: 768,
        type: 'video/webm',
        kind: 'screen',
      },
    ],
  },
  {
    id: 'recording-4',
    roomName: 'Town Hall',
    createdAt: '2026-06-04T10:00:00.000Z',
    durationSeconds: 1200,
    trackCount: 1,
    totalBytes: 2048,
    files: [
      {
        id: 'recording-4-track-1',
        label: 'Program mix',
        fileName: 'town_hall_program_mix.webm',
        size: 2048,
        type: 'video/webm',
        kind: 'program',
      },
    ],
    mediaExport: {
      uploadId: 'upload-town-hall',
      exportId: 'export-town-hall',
      roomId: 'room-town-hall',
      sessionId: 'recording-4',
      status: 'ready',
      createdAt: '2026-06-04T10:21:00.000Z',
      updatedAt: '2026-06-04T10:22:00.000Z',
      savedAt: '2026-06-04T10:22:10.000Z',
      artifacts: [
        {
          id: 'final-mp4',
          label: 'Town Hall.mp4',
          format: 'mp4',
          status: 'ready',
          bytes: 4096,
          storage: {
            provider: 's3',
            bucket: 'recordings',
            key: 'studio/exports/export-town-hall/final-mp4-Town_Hall.mp4',
            url: 'https://cdn.example.com/recordings/studio/exports/export-town-hall/final-mp4-Town_Hall.mp4',
            uploadedAt: '2026-06-04T10:22:05.000Z',
          },
        },
        {
          id: 'export-manifest',
          label: 'Export manifest',
          format: 'json',
          status: 'ready',
          bytes: 512,
        },
      ],
    },
  },
  {
    id: 'recording-5',
    roomName: 'Founder Interview',
    createdAt: '2026-06-05T14:00:00.000Z',
    durationSeconds: 1500,
    trackCount: 1,
    totalBytes: 1536,
    files: [
      {
        id: 'recording-5-track-1',
        label: 'Host ISO',
        fileName: 'founder_interview_host_iso.webm',
        size: 1536,
        type: 'video/webm',
        kind: 'iso',
      },
    ],
  },
];

describe('recording library filters', () => {
  it('searches room names, file labels, file names, and marker labels', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'launch demo', 'all').map((session) => session.id),
      ['recording-1']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'guest audio', 'all').map((session) => session.id),
      ['recording-2']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'figma', 'all').map((session) => session.id),
      ['recording-3']
    );
  });

  it('filters sessions by recorded track kind', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'audio').map((session) => session.id),
      ['recording-1', 'recording-2']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'video').map((session) => session.id),
      ['recording-1', 'recording-4', 'recording-5']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'screen').map((session) => session.id),
      ['recording-1', 'recording-3']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'program').map((session) => session.id),
      ['recording-4']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'iso').map((session) => session.id),
      ['recording-5']
    );
  });

  it('filters sessions with recording markers', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'markers').map((session) => session.id),
      ['recording-1']
    );
  });

  it('filters and searches cloud recording handoffs', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'cloud').map((session) => session.id),
      ['recording-2']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '30-day cloud handoff drive-folder-123', 'all').map((session) => session.id),
      ['recording-2']
    );
    assert.equal(getRecordingCloudRetentionExpiresAt('cloud-30-days', '2026-06-02T16:00:00.000Z'), '2026-07-02T16:00:00.000Z');
    assert.match(getRecordingCloudRetentionLabel(sessions[1].cloud), /^Expires /);
  });

  it('filters and searches media-server MP4 exports', () => {
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, '', 'mp4').map((session) => session.id),
      ['recording-4']
    );
    assert.deepEqual(
      filterRecordingLibrarySessions(sessions, 'mp4 ready town hall', 'all').map((session) => session.id),
      ['recording-4']
    );
    assert.equal(hasReadyFinalMp4Export(sessions[3]), true);
    assert.equal(getReadyFinalMp4Artifact(sessions[3].mediaExport)?.id, 'final-mp4');
    assert.equal(
      getReadyFinalMp4ShareUrl(sessions[3].mediaExport),
      'https://cdn.example.com/recordings/studio/exports/export-town-hall/final-mp4-Town_Hall.mp4'
    );
    assert.equal(hasReadyFinalMp4Export(sessions[0]), false);
    assert.equal(isRecordingMediaExportRefreshable(sessions[3].mediaExport), false);
    assert.equal(isRecordingMediaExportRefreshable({
      exportId: 'export-running',
      uploadId: 'upload-running',
      roomId: 'room-running',
      status: 'running',
      createdAt: '2026-06-04T10:21:00.000Z',
      updatedAt: '2026-06-04T10:22:00.000Z',
      artifacts: [{ id: 'final-mp4', label: 'Final MP4', format: 'mp4', status: 'running' }],
    }), true);
    assert.equal(getRecordingArtifactShareUrl({
      status: 'ready',
      storage: {
        provider: 's3',
        bucket: 'recordings',
        key: 'bad',
        url: 'javascript:alert(1)',
      },
    }), null);
  });

  it('summarizes the saved recording dashboard totals', () => {
    const filtered = filterRecordingLibrarySessions(sessions, '', 'screen');
    const summary = buildRecordingLibraryDashboardSummary(sessions, filtered);

    assert.deepEqual(summary, {
      totalSessions: 5,
      visibleSessions: 2,
      totalTracks: 7,
      totalBytes: 5888,
      totalDurationSeconds: 7800,
      markerCount: 1,
      cloudSessionCount: 1,
      mediaExportSessionCount: 1,
      readyMp4ExportSessionCount: 1,
      expiringCloudSessionCount: 1,
      permanentCloudSessionCount: 0,
      latestSession: {
        id: 'recording-5',
        roomName: 'Founder Interview',
        createdAt: '2026-06-05T14:00:00.000Z',
      },
    });
  });

  it('ignores unknown recording durations in dashboard totals', () => {
    const summary = buildRecordingLibraryDashboardSummary([
      ...sessions,
      {
        ...sessions[0],
        id: 'recording-unknown-duration',
        createdAt: '2026-06-06T14:00:00.000Z',
        durationSeconds: null,
      },
    ]);

    assert.equal(summary.totalDurationSeconds, 7800);
    assert.equal(summary.latestSession?.id, 'recording-unknown-duration');
  });

  it('exports a recording library catalog row for each saved track', () => {
    const csv = buildRecordingLibraryCatalogCsv([sessions[0]]);
    const lines = csv.trimEnd().split('\n');

    assert.equal(lines.length, 4);
    assert.match(lines[0], /sessionId,roomName,createdAt,durationTimecode/);
    assert.match(lines[0], /cloudProvider,cloudFolderId,cloudShareLink,cloudUploadedAt,cloudRetentionPolicy,cloudExpiresAt,cloudPermanent/);
    assert.match(lines[0], /mediaExportStatus,mediaUploadId,mediaExportId,mediaMp4Ready,mediaMp4ShareUrl,mediaArtifactCount/);
    assert.match(lines[1], /recording-1,Weekly Launch Show,2026-06-01T12:00:00\.000Z,30:00,1800,3,1024,1,7:00 Product demo/);
    assert.match(lines[1], /Host audio,audio,weekly_launch_host_audio\.webm,audio\/webm,256/);
    assert.match(lines[3], /Deck screen,screen,weekly_launch_deck_screen\.webm/);
  });

  it('exports media-server MP4 metadata in the recording library catalog', () => {
    const csv = buildRecordingLibraryCatalogCsv([sessions[3]]);

    assert.match(csv, /ready,upload-town-hall,export-town-hall,true,https:\/\/cdn\.example\.com\/recordings\/studio\/exports\/export-town-hall\/final-mp4-Town_Hall\.mp4,2/);
    assert.match(csv, /Program mix,program,town_hall_program_mix\.webm/);
  });

  it('exports cloud retention metadata in the recording library catalog', () => {
    const csv = buildRecordingLibraryCatalogCsv([sessions[1]]);

    assert.match(csv, /google-drive,drive-folder-123,https:\/\/drive\.google\.com\/drive\/folders\/drive-folder-123/);
    assert.match(csv, /2026-06-02T16:00:00\.000Z,30-day cloud handoff,2026-07-02T16:00:00\.000Z,false/);
  });

  it('escapes catalog CSV cells and builds deterministic filenames', () => {
    const csv = buildRecordingLibraryCatalogCsv([
      {
        ...sessions[0],
        roomName: 'Launch, "Demo"',
        markers: [
          {
            id: 'marker-quote',
            label: 'Clip "this", please',
            seconds: 12,
            createdAt: '2026-06-01T12:00:12.000Z',
          },
        ],
      },
    ]);

    assert.match(csv, /"Launch, ""Demo"""/);
    assert.match(csv, /"0:12 Clip ""this"", please"/);
    assert.equal(
      buildRecordingLibraryCatalogFilename(new Date('2026-06-11T05:30:00.000Z')),
      'studio_recording_library_2026-06-11_05-30.csv'
    );
  });

  it('detects saved recording tracks that can be previewed in the browser', () => {
    assert.equal(isPreviewableRecordingFile({
      fileName: 'track.bin',
      type: 'audio/webm',
    }), true);
    assert.equal(isPreviewableRecordingFile({
      fileName: 'camera.webm',
      type: 'application/octet-stream',
    }), true);
    assert.equal(isPreviewableRecordingFile({
      fileName: 'recording-notes.txt',
      type: 'text/plain',
    }), false);
    assert.equal(isRawWebCodecsBitstreamFile({
      fileName: 'host-camera-webcodecs.vp9',
      type: 'video/x-vp9',
    }), true);
    assert.equal(isPreviewableRecordingFile({
      fileName: 'host-camera-webcodecs.vp9',
      type: 'video/x-vp9',
    }), false);
  });
});
