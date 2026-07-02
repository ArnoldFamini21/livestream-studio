import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocalRecordingSession } from '../src/hooks/useRecordingLibrary.ts';
import type { SavedBrandKit } from '../src/utils/brandKits.ts';
import type { SavedHostStudio } from '../src/utils/hostSession.ts';
import type { SavedWorkspaceTeamMember } from '../src/utils/workspaceTeam.ts';
import {
  buildWorkspaceBackup,
  mergeWorkspaceBackup,
  parseWorkspaceBackupJson,
  serializeWorkspaceBackup,
} from '../src/utils/workspaceBackup.ts';

const studio: SavedHostStudio = {
  id: 'studio-1',
  name: 'Launch Studio',
  hostName: 'Arnold',
  hostToken: 'LaunchHostToken_1234567890',
  createdAt: '2026-07-01T10:00:00.000Z',
  scheduledFor: '2026-07-05T18:00:00.000Z',
  passwordProtected: true,
  status: 'scheduled',
};

const brandKit: SavedBrandKit = {
  id: 'kit-1',
  name: 'Launch Brand',
  createdAt: '2026-07-02T12:00:00.000Z',
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
};

const recording: LocalRecordingSession = {
  id: 'recording-1',
  roomName: 'Launch Recording',
  createdAt: '2026-07-02T13:00:00.000Z',
  trackCount: 3,
  totalBytes: 5_242_880,
  durationSeconds: 1850,
  files: [],
  cloud: {
    provider: 'google-drive',
    folderId: 'drive-folder-1',
    webViewLink: 'https://drive.google.com/drive/folders/drive-folder-1',
    uploadedAt: '2026-07-02T14:00:00.000Z',
    expiresAt: '2026-08-01T14:00:00.000Z',
    retentionPolicyId: 'cloud-30-days',
    permanent: false,
    fileCount: 3,
    totalBytes: 5_242_880,
  },
  mediaExport: {
    uploadId: 'upload-recording-1',
    exportId: 'export-recording-1',
    roomId: 'room-recording-1',
    sessionId: 'recording-1',
    status: 'ready',
    createdAt: '2026-07-02T14:05:00.000Z',
    updatedAt: '2026-07-02T14:08:00.000Z',
    savedAt: '2026-07-02T14:08:10.000Z',
    artifacts: [
      {
        id: 'final-mp4',
        label: 'Launch Recording.mp4',
        format: 'mp4',
        status: 'ready',
        bytes: 8_388_608,
        storage: {
          provider: 's3',
          bucket: 'recordings',
          key: 'studio/recordings/launch.mp4',
          url: 'https://cdn.example.com/recordings/launch.mp4',
          uploadedAt: '2026-07-02T14:08:05.000Z',
        },
      },
      {
        id: 'export-manifest',
        label: 'Export manifest',
        format: 'json',
        status: 'ready',
        bytes: 1024,
      },
    ],
  },
};

const teamMember: SavedWorkspaceTeamMember = {
  id: 'producer-1',
  name: 'Producer One',
  email: 'producer@example.com',
  role: 'producer',
  createdAt: '2026-07-02T15:00:00.000Z',
};

describe('workspace backup files', () => {
  it('builds a portable workspace backup with private host access and recording catalog metadata', () => {
    const backup = buildWorkspaceBackup({
      studios: [studio],
      brandKits: [brandKit],
      teamMembers: [teamMember],
      recordings: [recording],
    }, '2026-07-03T00:00:00.000Z');

    assert.equal(backup.type, 'livestream-studio-workspace-backup');
    assert.equal(backup.version, 1);
    assert.equal(backup.exportedAt, '2026-07-03T00:00:00.000Z');
    assert.deepEqual(backup.studios, [studio]);
    assert.deepEqual(backup.brandKits, [brandKit]);
    assert.deepEqual(backup.teamMembers, [teamMember]);
    assert.deepEqual(backup.recordingCatalog, [{
      id: 'recording-1',
      roomName: 'Launch Recording',
      createdAt: '2026-07-02T13:00:00.000Z',
      trackCount: 3,
      totalBytes: 5_242_880,
      durationSeconds: 1850,
      cloud: {
        provider: 'google-drive',
        folderId: 'drive-folder-1',
        webViewLink: 'https://drive.google.com/drive/folders/drive-folder-1',
        uploadedAt: '2026-07-02T14:00:00.000Z',
        expiresAt: '2026-08-01T14:00:00.000Z',
        permanent: false,
      },
      mediaExport: {
        status: 'ready',
        uploadId: 'upload-recording-1',
        exportId: 'export-recording-1',
        roomId: 'room-recording-1',
        sessionId: 'recording-1',
        updatedAt: '2026-07-02T14:08:00.000Z',
        savedAt: '2026-07-02T14:08:10.000Z',
        readyMp4: true,
        mp4ShareUrl: 'https://cdn.example.com/recordings/launch.mp4',
        artifactCount: 2,
        readyArtifactCount: 2,
      },
    }]);
  });

  it('parses only supported backup files and drops invalid private host entries', () => {
    const json = JSON.stringify({
      type: 'livestream-studio-workspace-backup',
      version: 1,
      exportedAt: '2026-07-03T00:00:00.000Z',
      studios: [
        studio,
        { ...studio, id: 'bad-token', hostToken: 'short' },
        { ...studio, id: 'bad-name', hostName: '' },
      ],
      brandKits: [brandKit, { ...brandKit, id: '', name: '' }],
      teamMembers: [teamMember, { ...teamMember, id: '', name: '' }],
      recordingCatalog: [
        {
          id: 'recording-1',
          roomName: 'Launch Recording',
          createdAt: '2026-07-02T13:00:00.000Z',
          trackCount: 3,
          totalBytes: 5_242_880,
          durationSeconds: 1850,
          mediaExport: {
            status: 'ready',
            uploadId: 'upload-1',
            exportId: 'export-1',
            roomId: 'room-1',
            updatedAt: '2026-07-02T14:08:00.000Z',
            readyMp4: true,
            mp4ShareUrl: 'javascript:alert(1)',
            artifactCount: 1,
            readyArtifactCount: 1,
          },
        },
        { id: '', roomName: '' },
      ],
    });

    const backup = parseWorkspaceBackupJson(json);

    assert.deepEqual(backup.studios, [studio]);
    assert.deepEqual(backup.brandKits, [brandKit]);
    assert.deepEqual(backup.teamMembers, [teamMember]);
    assert.equal(backup.recordingCatalog.length, 1);
    assert.equal(backup.recordingCatalog[0]?.mediaExport?.mp4ShareUrl, undefined);
    assert.throws(() => parseWorkspaceBackupJson('not json'), /valid JSON/);
    assert.throws(
      () => parseWorkspaceBackupJson(JSON.stringify({ type: 'other', version: 1 })),
      /not supported/
    );
  });

  it('serializes sanitized backup JSON and preserves the recording catalog', () => {
    const backup = buildWorkspaceBackup({
      studios: [studio],
      brandKits: [brandKit],
      teamMembers: [teamMember],
      recordings: [recording],
    }, '2026-07-03T00:00:00.000Z');

    const roundTrip = parseWorkspaceBackupJson(serializeWorkspaceBackup(backup));

    assert.deepEqual(roundTrip.studios, [studio]);
    assert.deepEqual(roundTrip.brandKits, [brandKit]);
    assert.deepEqual(roundTrip.teamMembers, [teamMember]);
    assert.equal(roundTrip.recordingCatalog.length, 1);
    assert.equal(roundTrip.recordingCatalog[0]?.cloud?.folderId, 'drive-folder-1');
    assert.equal(roundTrip.recordingCatalog[0]?.mediaExport?.readyMp4, true);
    assert.equal(roundTrip.recordingCatalog[0]?.mediaExport?.mp4ShareUrl, 'https://cdn.example.com/recordings/launch.mp4');
    assert.equal(roundTrip.recordingCatalog[0]?.mediaExport?.artifactCount, 2);
  });

  it('merges imported studios and brand kits over existing local copies', () => {
    const existingStudio: SavedHostStudio = {
      ...studio,
      name: 'Old name',
      scheduledFor: '2026-07-01T18:00:00.000Z',
    };
    const existingKit: SavedBrandKit = {
      ...brandKit,
      name: 'Old kit',
    };
    const existingTeamMember: SavedWorkspaceTeamMember = {
      ...teamMember,
      name: 'Old producer',
    };
    const backup = buildWorkspaceBackup({
      studios: [studio],
      brandKits: [brandKit],
      teamMembers: [teamMember],
      recordings: [recording],
    }, '2026-07-03T00:00:00.000Z');

    const result = mergeWorkspaceBackup([existingStudio], [existingKit], backup, [existingTeamMember]);

    assert.equal(result.importedStudios, 1);
    assert.equal(result.importedBrandKits, 1);
    assert.equal(result.importedTeamMembers, 1);
    assert.equal(result.catalogRecordings, 1);
    assert.equal(result.studios.length, 1);
    assert.equal(result.studios[0]?.name, 'Launch Studio');
    assert.equal(result.brandKits.length, 1);
    assert.equal(result.brandKits[0]?.name, 'Launch Brand');
    assert.equal(result.teamMembers.length, 1);
    assert.equal(result.teamMembers[0]?.name, 'Producer One');
  });
});
