import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalRecordingSession } from '../src/hooks/useRecordingLibrary.ts';
import type { SavedBrandKit } from '../src/utils/brandKits.ts';
import type { SavedHostStudio } from '../src/utils/hostSession.ts';
import {
  buildWorkspaceDashboardSummary,
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

describe('workspace dashboard summary', () => {
  it('summarizes saved studios, local recordings, and brand kits', () => {
    const summary = buildWorkspaceDashboardSummary(
      studios,
      recordings,
      brandKits,
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
      totalBrandKits: 2,
      brandKitsWithLogo: 1,
      brandKitsWithBackground: 1,
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
    });
  });

  it('formats compact dashboard file sizes and durations', () => {
    assert.equal(formatWorkspaceFileSize(0), '0 B');
    assert.equal(formatWorkspaceFileSize(1536), '1.5 KB');
    assert.equal(formatWorkspaceFileSize(1024 * 1024 * 5), '5.0 MB');
    assert.equal(formatWorkspaceDuration(null), '0:00');
    assert.equal(formatWorkspaceDuration(95), '1:35');
    assert.equal(formatWorkspaceDuration(3661), '1:01:01');
  });
});
