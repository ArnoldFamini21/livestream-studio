import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalRecordingSession } from '../src/hooks/useRecordingLibrary.ts';
import type { SavedBrandKit } from '../src/utils/brandKits.ts';
import type { SavedHostStudio } from '../src/utils/hostSession.ts';
import type { SavedWorkspaceTeamMember } from '../src/utils/workspaceTeam.ts';
import {
  buildWorkspaceDashboardSummary,
  buildWorkspaceRecordingDashboardItems,
  formatWorkspaceDuration,
  formatWorkspaceFileSize,
} from '../src/utils/workspaceDashboard.ts';

const studios: SavedHostStudio[] = [
  {
    id: 'studio-ready',
    name: 'Ready Studio',
    hostName: 'Arnold',
    hostToken: 'ReadyHostToken_1234567890',
    createdAt: '2026-06-28T10:00:00.000Z',
    passwordProtected: true,
  },
  {
    id: 'studio-upcoming',
    name: 'Upcoming Studio',
    hostName: 'Arnold',
    hostToken: 'UpcomingHostToken_1234567890',
    createdAt: '2026-06-29T10:00:00.000Z',
    scheduledFor: '2026-07-05T18:00:00.000Z',
    passwordProtected: false,
  },
];

const recordings: LocalRecordingSession[] = [
  {
    id: 'recording-1',
    roomName: 'Launch Show',
    createdAt: '2026-07-01T10:00:00.000Z',
    trackCount: 3,
    totalBytes: 1024 * 1024 * 3,
    durationSeconds: 3605,
    files: [],
    cloud: {
      provider: 'google-drive',
      folderId: 'folder-1',
      webViewLink: 'https://drive.google.com/folders/folder-1',
      uploadedAt: '2026-07-01T11:00:00.000Z',
      expiresAt: '2026-07-31T11:00:00.000Z',
      retentionPolicyId: 'cloud-30-days',
      permanent: false,
      fileCount: 3,
      totalBytes: 1024,
    },
    mediaExport: {
      uploadId: 'upload-launch',
      exportId: 'export-launch',
      roomId: 'room-launch',
      sessionId: 'recording-1',
      status: 'ready',
      createdAt: '2026-07-01T11:05:00.000Z',
      updatedAt: '2026-07-01T11:08:00.000Z',
      savedAt: '2026-07-01T11:08:10.000Z',
      artifacts: [
        {
          id: 'final-mp4',
          label: 'Launch Show.mp4',
          format: 'mp4',
          status: 'ready',
          bytes: 2048,
        },
      ],
    },
  },
  {
    id: 'recording-2',
    roomName: 'Audio Edit',
    createdAt: '2026-06-30T10:00:00.000Z',
    trackCount: 1,
    totalBytes: 512,
    durationSeconds: null,
    files: [],
  },
];

const brandKits: SavedBrandKit[] = [
  {
    id: 'kit-1',
    name: 'Launch Brand',
    createdAt: '2026-06-30T12:00:00.000Z',
    studioTheme: 'colorful',
    brandColor: '#2563eb',
    stageBackground: { type: 'gradient', value: 'linear-gradient(#111827, #2563eb)' },
    logoUrl: 'data:image/png;base64,logo',
    logoPlacement: 'top-right',
    logoPosition: null,
    logoSize: 'medium',
    logoOpacity: 0.8,
    cameraShape: 'rounded',
    nameTagStyle: 'block',
  },
  {
    id: 'kit-2',
    name: 'Clean Brand',
    createdAt: '2026-07-02T12:00:00.000Z',
    studioTheme: 'dark',
    brandColor: '#14b8a6',
    stageBackground: { type: 'none', value: '' },
    logoUrl: null,
    logoPlacement: 'bottom-right',
    logoPosition: null,
    logoSize: 'small',
    logoOpacity: 0.6,
    cameraShape: 'rectangle',
    nameTagStyle: 'classic',
  },
];

const teamMembers: SavedWorkspaceTeamMember[] = [
  {
    id: 'team-owner',
    name: 'Arnold',
    email: 'arnold@example.com',
    role: 'owner',
    createdAt: '2026-07-01T12:00:00.000Z',
  },
  {
    id: 'team-editor',
    name: 'Editor',
    email: 'editor@example.com',
    role: 'editor',
    createdAt: '2026-07-02T12:00:00.000Z',
  },
];

describe('workspace dashboard summary', () => {
  it('summarizes saved studios, local recordings, and brand kits', () => {
    const summary = buildWorkspaceDashboardSummary(
      studios,
      buildWorkspaceRecordingDashboardItems(recordings),
      brandKits,
      teamMembers,
      Date.parse('2026-07-01T00:00:00.000Z')
    );

    assert.deepEqual(summary, {
      totalStudios: 2,
      upcomingStudios: 1,
      readyStudios: 1,
      passwordProtectedStudios: 1,
      totalRecordings: 2,
      totalRecordingTracks: 4,
      totalRecordingBytes: 3146240,
      totalRecordingDurationSeconds: 3605,
      cloudRecordingCount: 1,
      mediaExportRecordingCount: 1,
      readyMp4RecordingCount: 1,
      totalBrandKits: 2,
      brandKitsWithLogo: 1,
      brandKitsWithBackground: 1,
      totalTeamMembers: 2,
      productionTeamMembers: 1,
      latestStudio: {
        id: 'studio-upcoming',
        name: 'Upcoming Studio',
        hostName: 'Arnold',
        createdAt: '2026-06-29T10:00:00.000Z',
        scheduledFor: '2026-07-05T18:00:00.000Z',
      },
      latestRecording: {
        id: 'recording-1',
        roomName: 'Launch Show',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
      latestBrandKit: {
        id: 'kit-2',
        name: 'Clean Brand',
        createdAt: '2026-07-02T12:00:00.000Z',
      },
      latestTeamMember: {
        id: 'team-editor',
        name: 'Editor',
        role: 'editor',
        createdAt: '2026-07-02T12:00:00.000Z',
      },
    });
  });

  it('keeps the legacy nowMs fourth argument for existing callers', () => {
    const summary = buildWorkspaceDashboardSummary(
      studios,
      buildWorkspaceRecordingDashboardItems(recordings),
      brandKits,
      Date.parse('2026-07-01T00:00:00.000Z')
    );

    assert.equal(summary.upcomingStudios, 1);
    assert.equal(summary.totalTeamMembers, 0);
    assert.equal(summary.latestTeamMember, null);
  });

  it('formats compact dashboard file sizes and durations', () => {
    assert.equal(formatWorkspaceFileSize(0), '0 B');
    assert.equal(formatWorkspaceFileSize(1536), '1.5 KB');
    assert.equal(formatWorkspaceFileSize(1024 * 1024 * 5), '5.0 MB');
    assert.equal(formatWorkspaceDuration(null), '0:00');
    assert.equal(formatWorkspaceDuration(95), '1:35');
    assert.equal(formatWorkspaceDuration(3661), '1:01:01');
  });

  it('merges server catalog recordings with local recording metadata', () => {
    const dashboardRecordings = buildWorkspaceRecordingDashboardItems(recordings, [
      {
        id: 'recording-1',
        roomId: 'room-launch',
        roomName: 'Launch Show',
        createdAt: '2026-07-01T10:00:00.000Z',
        updatedAt: '2026-07-01T11:10:00.000Z',
        durationSeconds: 3605,
        trackCount: 3,
        totalBytes: 1024 * 1024 * 3,
        markerCount: 2,
        mediaExport: {
          status: 'ready',
          uploadId: 'upload-launch',
          exportId: 'export-launch',
          updatedAt: '2026-07-01T11:10:00.000Z',
          readyMp4: true,
          mp4ShareUrl: 'https://cdn.example.com/launch.mp4',
          artifactCount: 2,
          readyArtifactCount: 2,
        },
      },
      {
        id: 'server-only',
        roomId: 'room-sermon',
        roomName: 'Sermon Archive',
        createdAt: '2026-07-02T09:00:00.000Z',
        updatedAt: '2026-07-02T09:15:00.000Z',
        durationSeconds: 1800,
        trackCount: 1,
        totalBytes: 1024 * 1024 * 42,
        markerCount: 0,
        mediaExport: {
          status: 'ready',
          uploadId: 'upload-sermon',
          exportId: 'export-sermon',
          updatedAt: '2026-07-02T09:15:00.000Z',
          readyMp4: true,
          mp4ShareUrl: 'https://cdn.example.com/sermon.mp4',
          artifactCount: 1,
          readyArtifactCount: 1,
        },
      },
    ]);

    assert.equal(dashboardRecordings.length, 3);
    assert.equal(dashboardRecordings[0]?.id, 'server-only');
    assert.equal(dashboardRecordings.find((item) => item.id === 'recording-1')?.source, 'local-and-server');
    assert.equal(
      dashboardRecordings.find((item) => item.id === 'recording-1')?.mediaExport?.mp4ShareUrl,
      'https://cdn.example.com/launch.mp4'
    );

    const summary = buildWorkspaceDashboardSummary(
      studios,
      dashboardRecordings,
      brandKits,
      teamMembers,
      Date.parse('2026-07-01T00:00:00.000Z')
    );

    assert.equal(summary.totalRecordings, 3);
    assert.equal(summary.mediaExportRecordingCount, 2);
    assert.equal(summary.readyMp4RecordingCount, 2);
    assert.equal(summary.latestRecording?.roomName, 'Sermon Archive');
  });
});
