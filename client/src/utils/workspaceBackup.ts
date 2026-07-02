import type { LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import {
  parseSavedBrandKits,
  type SavedBrandKit,
} from './brandKits.ts';
import {
  getValidHostToken,
  type SavedHostStudio,
} from './hostSession.ts';
import {
  normalizeWorkspaceTeamMembers,
  type SavedWorkspaceTeamMember,
} from './workspaceTeam.ts';

const WORKSPACE_BACKUP_TYPE = 'livestream-studio-workspace-backup';
const WORKSPACE_BACKUP_VERSION = 1;
const MAX_BACKUP_STUDIOS = 20;

type WorkspaceRecordingMediaExportStatus = 'queued' | 'running' | 'ready' | 'error';

export interface WorkspaceRecordingCatalogItem {
  id: string;
  roomName: string;
  createdAt: string;
  trackCount: number;
  totalBytes: number;
  durationSeconds: number | null;
  cloud?: {
    provider: 'google-drive';
    folderId: string;
    webViewLink: string;
    uploadedAt: string;
    expiresAt: string | null;
    permanent: boolean;
  };
  mediaExport?: {
    status: WorkspaceRecordingMediaExportStatus;
    uploadId: string;
    exportId: string;
    roomId: string;
    sessionId?: string;
    updatedAt: string;
    savedAt?: string;
    readyMp4: boolean;
    mp4ShareUrl?: string;
    artifactCount: number;
    readyArtifactCount: number;
  };
}

export interface WorkspaceBackupFile {
  type: typeof WORKSPACE_BACKUP_TYPE;
  version: typeof WORKSPACE_BACKUP_VERSION;
  exportedAt: string;
  studios: SavedHostStudio[];
  brandKits: SavedBrandKit[];
  teamMembers: SavedWorkspaceTeamMember[];
  recordingCatalog: WorkspaceRecordingCatalogItem[];
}

export interface WorkspaceImportResult {
  studios: SavedHostStudio[];
  brandKits: SavedBrandKit[];
  teamMembers: SavedWorkspaceTeamMember[];
  importedStudios: number;
  importedBrandKits: number;
  importedTeamMembers: number;
  catalogRecordings: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
}

function readIsoDate(value: unknown, fallback = new Date(0).toISOString()): string {
  const input = readString(value, 64);
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function readOptionalIsoDate(value: unknown): string | undefined {
  const input = readString(value, 64);
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function readMediaExportStatus(value: unknown): WorkspaceRecordingMediaExportStatus | null {
  return value === 'queued' || value === 'running' || value === 'ready' || value === 'error'
    ? value
    : null;
}

function readSafeHttpUrl(value: unknown, maxLength = 2048): string {
  const text = readString(value, maxLength);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, maxLength) : '';
  } catch {
    return '';
  }
}

function sanitizeStudio(value: unknown): SavedHostStudio | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id, 128);
  const hostName = readString(value.hostName, 80);
  const hostToken = getValidHostToken(value.hostToken);
  if (!id || !hostName || !hostToken) return null;

  const studio: SavedHostStudio = {
    id,
    name: readString(value.name, 120) || undefined,
    hostName,
    hostToken,
    createdAt: readOptionalIsoDate(value.createdAt),
    scheduledFor: readOptionalIsoDate(value.scheduledFor),
    passwordProtected: Boolean(value.passwordProtected),
    status: readString(value.status, 40) || undefined,
  };

  return Object.fromEntries(
    Object.entries(studio).filter(([, item]) => item !== undefined)
  ) as SavedHostStudio;
}

function sanitizeStudios(values: unknown): SavedHostStudio[] {
  if (!Array.isArray(values)) return [];
  const byId = new Map<string, SavedHostStudio>();
  for (const studio of values) {
    const sanitized = sanitizeStudio(studio);
    if (sanitized) byId.set(sanitized.id, sanitized);
  }
  return sortStudios(Array.from(byId.values())).slice(0, MAX_BACKUP_STUDIOS);
}

function sortStudios(studios: SavedHostStudio[]): SavedHostStudio[] {
  return studios.sort((a, b) => {
    const aTime = Date.parse(a.scheduledFor || a.createdAt || '');
    const bTime = Date.parse(b.scheduledFor || b.createdAt || '');
    if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) return a.id.localeCompare(b.id);
    if (!Number.isFinite(aTime)) return 1;
    if (!Number.isFinite(bTime)) return -1;
    return aTime - bTime;
  });
}

function sanitizeBrandKits(values: unknown): SavedBrandKit[] {
  return parseSavedBrandKits(JSON.stringify(Array.isArray(values) ? values : []));
}

function sanitizeRecordingCatalogItem(value: unknown): WorkspaceRecordingCatalogItem | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id, 128);
  const roomName = readString(value.roomName, 120);
  if (!id || !roomName) return null;

  const item: WorkspaceRecordingCatalogItem = {
    id,
    roomName,
    createdAt: readIsoDate(value.createdAt),
    trackCount: readNonNegativeInteger(value.trackCount),
    totalBytes: readNonNegativeInteger(value.totalBytes),
    durationSeconds: Number.isFinite(value.durationSeconds)
      ? Math.max(0, Math.round(Number(value.durationSeconds)))
      : null,
  };

  if (isRecord(value.cloud)) {
    const folderId = readString(value.cloud.folderId, 256);
    const webViewLink = readString(value.cloud.webViewLink, 2048);
    const uploadedAt = readOptionalIsoDate(value.cloud.uploadedAt);
    if (value.cloud.provider === 'google-drive' && folderId && webViewLink && uploadedAt) {
      item.cloud = {
        provider: 'google-drive',
        folderId,
        webViewLink,
        uploadedAt,
        expiresAt: readOptionalIsoDate(value.cloud.expiresAt) || null,
        permanent: Boolean(value.cloud.permanent),
      };
    }
  }

  if (isRecord(value.mediaExport)) {
    const status = readMediaExportStatus(value.mediaExport.status);
    const uploadId = readString(value.mediaExport.uploadId, 128);
    const exportId = readString(value.mediaExport.exportId, 128);
    const roomId = readString(value.mediaExport.roomId, 128);
    if (status && uploadId && exportId && roomId) {
      const sessionId = readString(value.mediaExport.sessionId, 128);
      const savedAt = readOptionalIsoDate(value.mediaExport.savedAt);
      const mp4ShareUrl = readSafeHttpUrl(value.mediaExport.mp4ShareUrl);
      item.mediaExport = {
        status,
        uploadId,
        exportId,
        roomId,
        ...(sessionId ? { sessionId } : {}),
        updatedAt: readIsoDate(value.mediaExport.updatedAt),
        ...(savedAt ? { savedAt } : {}),
        readyMp4: Boolean(value.mediaExport.readyMp4),
        ...(mp4ShareUrl ? { mp4ShareUrl } : {}),
        artifactCount: readNonNegativeInteger(value.mediaExport.artifactCount),
        readyArtifactCount: readNonNegativeInteger(value.mediaExport.readyArtifactCount),
      };
    }
  }

  return item;
}

function sanitizeRecordingCatalog(values: unknown): WorkspaceRecordingCatalogItem[] {
  if (!Array.isArray(values)) return [];
  return values
    .map(sanitizeRecordingCatalogItem)
    .filter((item): item is WorkspaceRecordingCatalogItem => Boolean(item))
    .slice(0, 100);
}

function recordingToCatalogItem(session: LocalRecordingSession): WorkspaceRecordingCatalogItem {
  const item: WorkspaceRecordingCatalogItem = {
    id: session.id,
    roomName: session.roomName,
    createdAt: session.createdAt,
    trackCount: Math.max(0, Math.floor(session.trackCount)),
    totalBytes: Math.max(0, Math.floor(session.totalBytes)),
    durationSeconds: Number.isFinite(session.durationSeconds)
      ? Math.max(0, Math.round(Number(session.durationSeconds)))
      : null,
  };

  if (session.cloud) {
    item.cloud = {
      provider: 'google-drive',
      folderId: session.cloud.folderId,
      webViewLink: session.cloud.webViewLink,
      uploadedAt: session.cloud.uploadedAt,
      expiresAt: session.cloud.expiresAt,
      permanent: session.cloud.permanent,
    };
  }

  if (session.mediaExport) {
    const readyArtifactCount = session.mediaExport.artifacts.filter((artifact) => artifact.status === 'ready').length;
    const readyMp4Artifact = session.mediaExport.artifacts.find((artifact) => (
      artifact.status === 'ready' && artifact.id === 'final-mp4'
    )) || session.mediaExport.artifacts.find((artifact) => (
      artifact.status === 'ready' && (artifact.id === 'final-mp4' || artifact.format === 'mp4')
    ));
    const mp4ShareUrl = readSafeHttpUrl(readyMp4Artifact?.storage?.url);
    item.mediaExport = {
      status: session.mediaExport.status,
      uploadId: session.mediaExport.uploadId,
      exportId: session.mediaExport.exportId,
      roomId: session.mediaExport.roomId,
      ...(session.mediaExport.sessionId ? { sessionId: session.mediaExport.sessionId } : {}),
      updatedAt: session.mediaExport.updatedAt,
      savedAt: session.mediaExport.savedAt,
      readyMp4: Boolean(readyMp4Artifact),
      ...(mp4ShareUrl ? { mp4ShareUrl } : {}),
      artifactCount: session.mediaExport.artifacts.length,
      readyArtifactCount,
    };
  }

  return item;
}

export function buildWorkspaceBackup(input: {
  studios: SavedHostStudio[];
  brandKits: SavedBrandKit[];
  teamMembers?: SavedWorkspaceTeamMember[];
  recordings?: LocalRecordingSession[];
}, exportedAt = new Date().toISOString()): WorkspaceBackupFile {
  return {
    type: WORKSPACE_BACKUP_TYPE,
    version: WORKSPACE_BACKUP_VERSION,
    exportedAt: readIsoDate(exportedAt, new Date().toISOString()),
    studios: sanitizeStudios(input.studios),
    brandKits: sanitizeBrandKits(input.brandKits),
    teamMembers: normalizeWorkspaceTeamMembers(input.teamMembers || []),
    recordingCatalog: (input.recordings || []).map(recordingToCatalogItem).slice(0, 100),
  };
}

export function serializeWorkspaceBackup(backup: WorkspaceBackupFile): string {
  return JSON.stringify({
    type: WORKSPACE_BACKUP_TYPE,
    version: WORKSPACE_BACKUP_VERSION,
    exportedAt: readIsoDate(backup.exportedAt, new Date().toISOString()),
    studios: sanitizeStudios(backup.studios),
    brandKits: sanitizeBrandKits(backup.brandKits),
    teamMembers: normalizeWorkspaceTeamMembers(backup.teamMembers),
    recordingCatalog: sanitizeRecordingCatalog(backup.recordingCatalog),
  }, null, 2);
}

export function parseWorkspaceBackupJson(json: string): WorkspaceBackupFile {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Workspace backup must be valid JSON.');
  }

  if (!isRecord(parsed) || parsed.type !== WORKSPACE_BACKUP_TYPE || parsed.version !== WORKSPACE_BACKUP_VERSION) {
    throw new Error('Workspace backup format is not supported.');
  }

  return {
    type: WORKSPACE_BACKUP_TYPE,
    version: WORKSPACE_BACKUP_VERSION,
    exportedAt: readIsoDate(parsed.exportedAt, new Date().toISOString()),
    studios: sanitizeStudios(parsed.studios),
    brandKits: sanitizeBrandKits(parsed.brandKits),
    teamMembers: normalizeWorkspaceTeamMembers(parsed.teamMembers),
    recordingCatalog: sanitizeRecordingCatalog(parsed.recordingCatalog),
  };
}

export function mergeWorkspaceBackup(
  currentStudios: SavedHostStudio[],
  currentBrandKits: SavedBrandKit[],
  backup: WorkspaceBackupFile,
  currentTeamMembers: SavedWorkspaceTeamMember[] = []
): WorkspaceImportResult {
  const studioMap = new Map<string, SavedHostStudio>();
  for (const studio of sanitizeStudios(currentStudios)) studioMap.set(studio.id, studio);
  for (const studio of backup.studios) studioMap.set(studio.id, studio);

  const brandKitMap = new Map<string, SavedBrandKit>();
  for (const kit of sanitizeBrandKits(currentBrandKits)) brandKitMap.set(kit.id, kit);
  for (const kit of backup.brandKits) brandKitMap.set(kit.id, kit);

  const teamMap = new Map<string, SavedWorkspaceTeamMember>();
  for (const member of normalizeWorkspaceTeamMembers(currentTeamMembers)) teamMap.set(member.id, member);
  for (const member of backup.teamMembers) teamMap.set(member.id, member);

  return {
    studios: sortStudios(Array.from(studioMap.values())).slice(0, MAX_BACKUP_STUDIOS),
    brandKits: Array.from(brandKitMap.values()).slice(0, 8),
    teamMembers: normalizeWorkspaceTeamMembers(Array.from(teamMap.values())),
    importedStudios: backup.studios.length,
    importedBrandKits: backup.brandKits.length,
    importedTeamMembers: backup.teamMembers.length,
    catalogRecordings: backup.recordingCatalog.length,
  };
}
