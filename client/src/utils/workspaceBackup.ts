import type { LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import {
  parseSavedBrandKits,
  type SavedBrandKit,
} from './brandKits.ts';
import {
  getValidHostToken,
  type SavedHostStudio,
} from './hostSession.ts';

const WORKSPACE_BACKUP_TYPE = 'livestream-studio-workspace-backup';
const WORKSPACE_BACKUP_VERSION = 1;
const MAX_BACKUP_STUDIOS = 20;

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
}

export interface WorkspaceBackupFile {
  type: typeof WORKSPACE_BACKUP_TYPE;
  version: typeof WORKSPACE_BACKUP_VERSION;
  exportedAt: string;
  studios: SavedHostStudio[];
  brandKits: SavedBrandKit[];
  recordingCatalog: WorkspaceRecordingCatalogItem[];
}

export interface WorkspaceImportResult {
  studios: SavedHostStudio[];
  brandKits: SavedBrandKit[];
  importedStudios: number;
  importedBrandKits: number;
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

  return item;
}

export function buildWorkspaceBackup(input: {
  studios: SavedHostStudio[];
  brandKits: SavedBrandKit[];
  recordings?: LocalRecordingSession[];
}, exportedAt = new Date().toISOString()): WorkspaceBackupFile {
  return {
    type: WORKSPACE_BACKUP_TYPE,
    version: WORKSPACE_BACKUP_VERSION,
    exportedAt: readIsoDate(exportedAt, new Date().toISOString()),
    studios: sanitizeStudios(input.studios),
    brandKits: sanitizeBrandKits(input.brandKits),
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
    recordingCatalog: sanitizeRecordingCatalog(parsed.recordingCatalog),
  };
}

export function mergeWorkspaceBackup(
  currentStudios: SavedHostStudio[],
  currentBrandKits: SavedBrandKit[],
  backup: WorkspaceBackupFile
): WorkspaceImportResult {
  const studioMap = new Map<string, SavedHostStudio>();
  for (const studio of sanitizeStudios(currentStudios)) studioMap.set(studio.id, studio);
  for (const studio of backup.studios) studioMap.set(studio.id, studio);

  const brandKitMap = new Map<string, SavedBrandKit>();
  for (const kit of sanitizeBrandKits(currentBrandKits)) brandKitMap.set(kit.id, kit);
  for (const kit of backup.brandKits) brandKitMap.set(kit.id, kit);

  return {
    studios: sortStudios(Array.from(studioMap.values())).slice(0, MAX_BACKUP_STUDIOS),
    brandKits: Array.from(brandKitMap.values()).slice(0, 8),
    importedStudios: backup.studios.length,
    importedBrandKits: backup.brandKits.length,
    catalogRecordings: backup.recordingCatalog.length,
  };
}
