import type {
  RecordingCatalogEntry,
  RecordingCatalogListResponse,
  RecordingCatalogMediaExportSummary,
  RecordingCatalogUpsertRequest,
  RecordingExportArtifactStatus,
} from '@studio/shared';
import type { LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import { ApiRequestError, buildApiUrl, getJson, postJson } from './apiClient.ts';

export interface SyncRecordingCatalogInput {
  roomId: string;
  hostToken: string;
  session: LocalRecordingSession;
}

function catalogHeaders(hostToken: string): Headers {
  const headers = new Headers();
  headers.set('x-host-token', hostToken);
  return headers;
}

function getReadyFinalMp4Artifact(
  artifacts: RecordingExportArtifactStatus[] | undefined
): RecordingExportArtifactStatus | null {
  return artifacts?.find((artifact) => artifact.status === 'ready' && artifact.id === 'final-mp4') ||
    artifacts?.find((artifact) => artifact.status === 'ready' && artifact.format === 'mp4') ||
    null;
}

function buildMediaExportSummary(
  session: LocalRecordingSession
): RecordingCatalogMediaExportSummary | undefined {
  if (!session.mediaExport) return undefined;
  const artifacts = session.mediaExport.artifacts || [];
  return {
    status: session.mediaExport.status,
    uploadId: session.mediaExport.uploadId,
    exportId: session.mediaExport.exportId,
    updatedAt: session.mediaExport.updatedAt,
    readyMp4: Boolean(getReadyFinalMp4Artifact(artifacts)),
    artifactCount: artifacts.length,
    readyArtifactCount: artifacts.filter((artifact) => artifact.status === 'ready').length,
  };
}

export function buildRecordingCatalogUpsertRequest(
  session: LocalRecordingSession
): RecordingCatalogUpsertRequest {
  return {
    id: session.id,
    roomName: session.roomName,
    createdAt: session.createdAt,
    durationSeconds: session.durationSeconds,
    trackCount: session.trackCount,
    totalBytes: session.totalBytes,
    markerCount: session.markers?.length || 0,
    ...(session.cloud ? {
      cloud: {
        provider: 'google-drive',
        fileCount: session.cloud.fileCount,
        totalBytes: session.cloud.totalBytes,
        uploadedAt: session.cloud.uploadedAt,
        expiresAt: session.cloud.expiresAt,
        permanent: session.cloud.permanent,
      },
    } : {}),
    ...(session.mediaExport ? { mediaExport: buildMediaExportSummary(session) } : {}),
  };
}

export function fetchRecordingCatalog(
  roomId: string,
  hostToken: string
): Promise<RecordingCatalogListResponse> {
  return getJson<RecordingCatalogListResponse>(
    `/api/recordings/rooms/${encodeURIComponent(roomId)}/catalog`,
    { headers: catalogHeaders(hostToken) }
  );
}

export function syncRecordingCatalogEntry({
  roomId,
  hostToken,
  session,
}: SyncRecordingCatalogInput): Promise<RecordingCatalogEntry> {
  return postJson<RecordingCatalogEntry>(
    `/api/recordings/rooms/${encodeURIComponent(roomId)}/catalog`,
    buildRecordingCatalogUpsertRequest(session),
    { headers: catalogHeaders(hostToken) }
  );
}

export async function deleteRecordingCatalogEntry(
  roomId: string,
  hostToken: string,
  recordingId: string
): Promise<void> {
  const response = await fetch(buildApiUrl(
    `/api/recordings/rooms/${encodeURIComponent(roomId)}/catalog/${encodeURIComponent(recordingId)}`
  ), {
    method: 'DELETE',
    headers: catalogHeaders(hostToken),
  });

  if (!response.ok) {
    throw new ApiRequestError(
      `Studio server returned ${response.status}. Please try again.`,
      { status: response.status, responseText: await response.text().catch(() => '') }
    );
  }
}
