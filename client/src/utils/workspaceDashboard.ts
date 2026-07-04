import type { RecordingCatalogEntry, RecordingCatalogMediaExportSummary, RecordingExportArtifactStatus } from '@studio/shared';
import type { LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import type { SavedBrandKit } from './brandKits.ts';
import type { SavedHostStudio } from './hostSession.ts';
import type { SavedWorkspaceTeamMember } from './workspaceTeam.ts';

export type WorkspaceDashboardRecordingSource = 'local' | 'server' | 'local-and-server';

export interface WorkspaceDashboardRecording {
  id: string;
  roomId?: string;
  roomName: string;
  createdAt: string;
  durationSeconds: number | null;
  trackCount: number;
  totalBytes: number;
  source: WorkspaceDashboardRecordingSource;
  cloud?: {
    provider: 'google-drive';
    fileCount: number;
    totalBytes: number;
    uploadedAt: string;
    expiresAt: string | null;
    permanent: boolean;
  };
  mediaExport?: RecordingCatalogMediaExportSummary;
}

export interface WorkspaceDashboardSummary {
  totalStudios: number;
  upcomingStudios: number;
  readyStudios: number;
  passwordProtectedStudios: number;
  totalRecordings: number;
  totalRecordingTracks: number;
  totalRecordingBytes: number;
  totalRecordingDurationSeconds: number;
  cloudRecordingCount: number;
  mediaExportRecordingCount: number;
  readyMp4RecordingCount: number;
  totalBrandKits: number;
  brandKitsWithLogo: number;
  brandKitsWithBackground: number;
  totalTeamMembers: number;
  productionTeamMembers: number;
  latestStudio: Pick<SavedHostStudio, 'id' | 'name' | 'hostName' | 'createdAt' | 'scheduledFor'> | null;
  latestRecording: Pick<WorkspaceDashboardRecording, 'id' | 'roomName' | 'createdAt'> | null;
  latestBrandKit: Pick<SavedBrandKit, 'id' | 'name' | 'createdAt'> | null;
  latestTeamMember: Pick<SavedWorkspaceTeamMember, 'id' | 'name' | 'role' | 'createdAt'> | null;
}

export type WorkspaceRecordingExportState = 'not-started' | 'queued' | 'running' | 'ready' | 'error';

function getStudioTime(studio: SavedHostStudio): number {
  const scheduledAt = Date.parse(studio.scheduledFor || '');
  if (Number.isFinite(scheduledAt)) return scheduledAt;
  const createdAt = Date.parse(studio.createdAt || '');
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function getCreatedAtTime(value: { createdAt?: string }): number {
  const createdAt = Date.parse(value.createdAt || '');
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function getReadyFinalMp4Artifact(
  artifacts: RecordingExportArtifactStatus[] | undefined
): RecordingExportArtifactStatus | null {
  return artifacts?.find((artifact) => artifact.status === 'ready' && artifact.id === 'final-mp4') ||
    artifacts?.find((artifact) => artifact.status === 'ready' && artifact.format === 'mp4') ||
    null;
}

function getSafeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function buildLocalMediaExportSummary(
  recording: LocalRecordingSession
): RecordingCatalogMediaExportSummary | undefined {
  if (!recording.mediaExport) return undefined;
  const artifacts = recording.mediaExport.artifacts || [];
  const readyMp4 = getReadyFinalMp4Artifact(artifacts);
  const mp4ShareUrl = getSafeHttpUrl(readyMp4?.storage?.url);

  return {
    status: recording.mediaExport.status,
    uploadId: recording.mediaExport.uploadId,
    exportId: recording.mediaExport.exportId,
    updatedAt: recording.mediaExport.updatedAt,
    readyMp4: Boolean(readyMp4),
    ...(mp4ShareUrl ? { mp4ShareUrl } : {}),
    artifactCount: artifacts.length,
    readyArtifactCount: artifacts.filter((artifact) => artifact.status === 'ready').length,
  };
}

function buildLocalRecordingDashboardItem(recording: LocalRecordingSession): WorkspaceDashboardRecording {
  return {
    id: recording.id,
    roomName: recording.roomName,
    createdAt: recording.createdAt,
    durationSeconds: recording.durationSeconds,
    trackCount: recording.trackCount,
    totalBytes: recording.totalBytes,
    source: 'local',
    ...(recording.cloud ? {
      cloud: {
        provider: 'google-drive',
        fileCount: recording.cloud.fileCount,
        totalBytes: recording.cloud.totalBytes,
        uploadedAt: recording.cloud.uploadedAt,
        expiresAt: recording.cloud.expiresAt,
        permanent: recording.cloud.permanent,
      },
    } : {}),
    ...(recording.mediaExport ? { mediaExport: buildLocalMediaExportSummary(recording) } : {}),
  };
}

function buildServerRecordingDashboardItem(recording: RecordingCatalogEntry): WorkspaceDashboardRecording {
  return {
    id: recording.id,
    roomId: recording.roomId,
    roomName: recording.roomName,
    createdAt: recording.createdAt,
    durationSeconds: recording.durationSeconds,
    trackCount: recording.trackCount,
    totalBytes: recording.totalBytes,
    source: 'server',
    ...(recording.cloud ? { cloud: recording.cloud } : {}),
    ...(recording.mediaExport ? { mediaExport: recording.mediaExport } : {}),
  };
}

function mergeMediaExportSummary(
  local: RecordingCatalogMediaExportSummary | undefined,
  remote: RecordingCatalogMediaExportSummary | undefined
): RecordingCatalogMediaExportSummary | undefined {
  if (!local) return remote;
  if (!remote) return local;

  return {
    ...local,
    ...remote,
    readyMp4: local.readyMp4 || remote.readyMp4,
    mp4ShareUrl: remote.mp4ShareUrl || local.mp4ShareUrl,
    artifactCount: Math.max(local.artifactCount, remote.artifactCount),
    readyArtifactCount: Math.max(local.readyArtifactCount, remote.readyArtifactCount),
    updatedAt: getCreatedAtTime({ createdAt: remote.updatedAt }) >= getCreatedAtTime({ createdAt: local.updatedAt })
      ? remote.updatedAt
      : local.updatedAt,
  };
}

function getNormalizedRecordingKeyPart(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function getRecordingDashboardMatchKeys(recording: WorkspaceDashboardRecording): string[] {
  const keys = new Set<string>();
  const id = getNormalizedRecordingKeyPart(recording.id);
  const uploadId = getNormalizedRecordingKeyPart(recording.mediaExport?.uploadId);
  const exportId = getNormalizedRecordingKeyPart(recording.mediaExport?.exportId);

  if (id) keys.add(`id:${id}`);
  if (uploadId && exportId) keys.add(`media-export:${uploadId}:${exportId}`);
  if (uploadId) keys.add(`upload:${uploadId}`);
  if (exportId) keys.add(`export:${exportId}`);

  return Array.from(keys);
}

function mergeRecordingSource(
  base: WorkspaceDashboardRecordingSource,
  incoming: WorkspaceDashboardRecordingSource
): WorkspaceDashboardRecordingSource {
  if (base === incoming) return base;
  return 'local-and-server';
}

function mergeRecordingDashboardItems(
  base: WorkspaceDashboardRecording,
  incoming: WorkspaceDashboardRecording
): WorkspaceDashboardRecording {
  return {
    ...base,
    roomId: incoming.roomId || base.roomId,
    roomName: base.roomName || incoming.roomName,
    createdAt: base.createdAt || incoming.createdAt,
    durationSeconds: base.durationSeconds ?? incoming.durationSeconds,
    trackCount: base.trackCount || incoming.trackCount,
    totalBytes: base.totalBytes || incoming.totalBytes,
    source: mergeRecordingSource(base.source, incoming.source),
    cloud: incoming.cloud || base.cloud,
    mediaExport: mergeMediaExportSummary(base.mediaExport, incoming.mediaExport),
  };
}

export function buildWorkspaceRecordingDashboardItems(
  localRecordings: LocalRecordingSession[],
  serverRecordings: RecordingCatalogEntry[] = []
): WorkspaceDashboardRecording[] {
  const items: Array<WorkspaceDashboardRecording | null> = [];
  const indexByKey = new Map<string, number>();

  const addOrMerge = (item: WorkspaceDashboardRecording) => {
    const keys = getRecordingDashboardMatchKeys(item);
    const matchingIndexes = new Set<number>();
    for (const key of keys) {
      const index = indexByKey.get(key);
      if (index !== undefined && items[index]) matchingIndexes.add(index);
    }

    if (matchingIndexes.size === 0) {
      const index = items.length;
      items.push(item);
      for (const key of keys) indexByKey.set(key, index);
      return;
    }

    const indexes = Array.from(matchingIndexes).sort((a, b) => a - b);
    const targetIndex = indexes[0];
    let merged = items[targetIndex] as WorkspaceDashboardRecording;
    for (const duplicateIndex of indexes.slice(1)) {
      merged = mergeRecordingDashboardItems(merged, items[duplicateIndex] as WorkspaceDashboardRecording);
      items[duplicateIndex] = null;
    }

    merged = mergeRecordingDashboardItems(merged, item);
    items[targetIndex] = merged;
    for (const key of new Set([...keys, ...getRecordingDashboardMatchKeys(merged)])) {
      indexByKey.set(key, targetIndex);
    }
  };

  for (const recording of localRecordings) {
    addOrMerge(buildLocalRecordingDashboardItem(recording));
  }

  for (const recording of serverRecordings) {
    addOrMerge(buildServerRecordingDashboardItem(recording));
  }

  return items
    .filter((item): item is WorkspaceDashboardRecording => Boolean(item))
    .sort((a, b) => getCreatedAtTime(b) - getCreatedAtTime(a));
}

function hasReadyMp4Export(recording: WorkspaceDashboardRecording): boolean {
  return Boolean(recording.mediaExport?.readyMp4);
}

export function getWorkspaceRecordingExportState(
  recording: Pick<WorkspaceDashboardRecording, 'mediaExport'>
): WorkspaceRecordingExportState {
  const mediaExport = recording.mediaExport;
  if (!mediaExport) return 'not-started';
  if (mediaExport.readyMp4) return 'ready';
  if (mediaExport.status === 'error') return 'error';
  if (mediaExport.status === 'queued') return 'queued';
  if (mediaExport.status === 'running') return 'running';
  return mediaExport.readyArtifactCount > 0 ? 'ready' : 'running';
}

export function getWorkspaceRecordingExportLabel(
  recording: Pick<WorkspaceDashboardRecording, 'mediaExport'>
): string {
  const mediaExport = recording.mediaExport;
  const state = getWorkspaceRecordingExportState(recording);
  if (!mediaExport) return 'No MP4 export yet';
  if (state === 'ready') {
    return mediaExport.mp4ShareUrl ? 'MP4 ready, share link ready' : 'MP4 ready';
  }
  if (state === 'error') return 'MP4 export needs attention';
  if (state === 'queued') return 'MP4 export queued';
  return 'MP4 export processing';
}

export function buildWorkspaceDashboardSummary(
  studios: SavedHostStudio[],
  recordings: WorkspaceDashboardRecording[],
  brandKits: SavedBrandKit[],
  teamMembersOrNowMs: SavedWorkspaceTeamMember[] | number = [],
  maybeNowMs = Date.now()
): WorkspaceDashboardSummary {
  const teamMembers = Array.isArray(teamMembersOrNowMs) ? teamMembersOrNowMs : [];
  const nowMs = typeof teamMembersOrNowMs === 'number' ? teamMembersOrNowMs : maybeNowMs;
  const latestStudio = studios.reduce<SavedHostStudio | null>((latest, studio) => {
    if (!latest) return studio;
    return getStudioTime(studio) > getStudioTime(latest) ? studio : latest;
  }, null);
  const latestRecording = recordings.reduce<WorkspaceDashboardRecording | null>((latest, recording) => {
    if (!latest) return recording;
    return getCreatedAtTime(recording) > getCreatedAtTime(latest) ? recording : latest;
  }, null);
  const latestBrandKit = brandKits.reduce<SavedBrandKit | null>((latest, kit) => {
    if (!latest) return kit;
    return getCreatedAtTime(kit) > getCreatedAtTime(latest) ? kit : latest;
  }, null);
  const latestTeamMember = teamMembers.reduce<SavedWorkspaceTeamMember | null>((latest, member) => {
    if (!latest) return member;
    return getCreatedAtTime(member) > getCreatedAtTime(latest) ? member : latest;
  }, null);

  return {
    totalStudios: studios.length,
    upcomingStudios: studios.filter((studio) => {
      const scheduledAt = Date.parse(studio.scheduledFor || '');
      return Number.isFinite(scheduledAt) && scheduledAt > nowMs;
    }).length,
    readyStudios: studios.filter((studio) => {
      const scheduledAt = Date.parse(studio.scheduledFor || '');
      return !Number.isFinite(scheduledAt) || scheduledAt <= nowMs;
    }).length,
    passwordProtectedStudios: studios.filter((studio) => studio.passwordProtected).length,
    totalRecordings: recordings.length,
    totalRecordingTracks: recordings.reduce((total, recording) => total + recording.trackCount, 0),
    totalRecordingBytes: recordings.reduce((total, recording) => total + recording.totalBytes, 0),
    totalRecordingDurationSeconds: Math.round(recordings.reduce((total, recording) => {
      if (!Number.isFinite(recording.durationSeconds)) return total;
      return total + Math.max(0, Number(recording.durationSeconds));
    }, 0)),
    cloudRecordingCount: recordings.filter((recording) => Boolean(recording.cloud)).length,
    mediaExportRecordingCount: recordings.filter((recording) => Boolean(recording.mediaExport)).length,
    readyMp4RecordingCount: recordings.filter(hasReadyMp4Export).length,
    totalBrandKits: brandKits.length,
    brandKitsWithLogo: brandKits.filter((kit) => Boolean(kit.logoUrl)).length,
    brandKitsWithBackground: brandKits.filter((kit) => kit.stageBackground.type !== 'none' && Boolean(kit.stageBackground.value)).length,
    totalTeamMembers: teamMembers.length,
    productionTeamMembers: teamMembers.filter((member) => member.role === 'owner' || member.role === 'producer').length,
    latestStudio: latestStudio
      ? {
          id: latestStudio.id,
          name: latestStudio.name,
          hostName: latestStudio.hostName,
          createdAt: latestStudio.createdAt,
          scheduledFor: latestStudio.scheduledFor,
        }
      : null,
    latestRecording: latestRecording
      ? {
          id: latestRecording.id,
          roomName: latestRecording.roomName,
          createdAt: latestRecording.createdAt,
        }
      : null,
    latestBrandKit: latestBrandKit
      ? {
          id: latestBrandKit.id,
          name: latestBrandKit.name,
          createdAt: latestBrandKit.createdAt,
        }
      : null,
    latestTeamMember: latestTeamMember
      ? {
          id: latestTeamMember.id,
          name: latestTeamMember.name,
          role: latestTeamMember.role,
          createdAt: latestTeamMember.createdAt,
        }
      : null,
  };
}

export function formatWorkspaceFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatWorkspaceDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const totalSeconds = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
