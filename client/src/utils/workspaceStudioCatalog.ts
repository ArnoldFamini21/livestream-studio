import type {
  WorkspaceStudioCatalogEntry,
  WorkspaceStudioCatalogListResponse,
  WorkspaceStudioCatalogUpsertRequest,
} from '@studio/shared';
import { ApiRequestError, buildApiUrl, getJson, postJson } from './apiClient.ts';
import { accountHeaders } from './accountAuth.ts';
import { getValidHostToken, type SavedHostStudio } from './hostSession.ts';

export interface SyncWorkspaceStudioCatalogInput {
  roomId: string;
  hostToken: string;
  studio: SavedHostStudio;
}

function catalogHeaders(hostToken: string): Headers {
  const headers = new Headers();
  headers.set('x-host-token', hostToken);
  return headers;
}

function getStudioSortTime(studio: Pick<SavedHostStudio, 'createdAt' | 'scheduledFor'>): number {
  const scheduledAt = studio.scheduledFor ? Date.parse(studio.scheduledFor) : NaN;
  if (Number.isFinite(scheduledAt)) return scheduledAt;
  const createdAt = studio.createdAt ? Date.parse(studio.createdAt) : NaN;
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
}

function sortWorkspaceStudios(studios: SavedHostStudio[]): SavedHostStudio[] {
  return studios.sort((a, b) => {
    const aTime = getStudioSortTime(a);
    const bTime = getStudioSortTime(b);
    if (aTime === bTime) return (a.name || a.id).localeCompare(b.name || b.id);
    return aTime - bTime;
  });
}

export function buildWorkspaceStudioCatalogUpsertRequest(
  studio: SavedHostStudio,
  now = new Date()
): WorkspaceStudioCatalogUpsertRequest {
  return {
    id: studio.id,
    name: studio.name || 'Untitled Studio',
    hostName: studio.hostName || 'Host',
    hostToken: studio.hostToken,
    createdAt: studio.createdAt || now.toISOString(),
    ...(studio.scheduledFor ? { scheduledFor: studio.scheduledFor } : {}),
    passwordProtected: Boolean(studio.passwordProtected),
    registrationEnabled: Boolean(studio.registrationEnabled),
    ...(studio.status === 'waiting' ||
    studio.status === 'scheduled' ||
    studio.status === 'live' ||
    studio.status === 'recording' ||
    studio.status === 'ended'
      ? { status: studio.status }
      : {}),
  };
}

export function catalogStudioToSavedHostStudio(
  entry: WorkspaceStudioCatalogEntry
): SavedHostStudio {
  return {
    id: entry.id,
    name: entry.name,
    hostName: entry.hostName,
    hostToken: entry.hostToken,
    createdAt: entry.createdAt,
    scheduledFor: entry.scheduledFor,
    passwordProtected: entry.passwordProtected,
    registrationEnabled: entry.registrationEnabled,
    status: entry.status,
  };
}

export function mergeWorkspaceStudioCatalogEntries(
  localStudios: SavedHostStudio[],
  serverStudios: WorkspaceStudioCatalogEntry[] = []
): SavedHostStudio[] {
  const byId = new Map<string, SavedHostStudio>();
  for (const studio of localStudios) {
    if (getValidHostToken(studio.hostToken)) byId.set(studio.id, studio);
  }
  for (const studio of serverStudios) {
    if (!byId.has(studio.id) && getValidHostToken(studio.hostToken)) {
      byId.set(studio.id, catalogStudioToSavedHostStudio(studio));
    }
  }
  return sortWorkspaceStudios(Array.from(byId.values()));
}

export function fetchWorkspaceStudioCatalog(
  roomId: string,
  hostToken: string
): Promise<WorkspaceStudioCatalogListResponse> {
  return getJson<WorkspaceStudioCatalogListResponse>(
    `/api/workspace-studios/rooms/${encodeURIComponent(roomId)}/catalog`,
    { headers: catalogHeaders(hostToken) }
  );
}

export function fetchAccountWorkspaceStudioCatalog(): Promise<WorkspaceStudioCatalogListResponse> {
  return getJson<WorkspaceStudioCatalogListResponse>(
    '/api/workspace-studios/account/catalog',
    {
      credentials: 'include',
      headers: accountHeaders(),
    }
  );
}

export function syncWorkspaceStudioCatalogEntry({
  roomId,
  hostToken,
  studio,
}: SyncWorkspaceStudioCatalogInput): Promise<WorkspaceStudioCatalogEntry> {
  return postJson<WorkspaceStudioCatalogEntry>(
    `/api/workspace-studios/rooms/${encodeURIComponent(roomId)}/catalog`,
    buildWorkspaceStudioCatalogUpsertRequest(studio),
    { headers: catalogHeaders(hostToken) }
  );
}

export function syncAccountWorkspaceStudioCatalogEntry(
  studio: SavedHostStudio
): Promise<WorkspaceStudioCatalogEntry> {
  return postJson<WorkspaceStudioCatalogEntry>(
    '/api/workspace-studios/account/catalog',
    buildWorkspaceStudioCatalogUpsertRequest(studio),
    {
      credentials: 'include',
      headers: accountHeaders(),
    }
  );
}

export async function deleteWorkspaceStudioCatalogEntry(
  roomId: string,
  hostToken: string,
  studioId: string
): Promise<void> {
  const response = await fetch(buildApiUrl(
    `/api/workspace-studios/rooms/${encodeURIComponent(roomId)}/catalog/${encodeURIComponent(studioId)}`
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

export async function deleteAccountWorkspaceStudioCatalogEntry(studioId: string): Promise<void> {
  const response = await fetch(buildApiUrl(
    `/api/workspace-studios/account/catalog/${encodeURIComponent(studioId)}`
  ), {
    method: 'DELETE',
    credentials: 'include',
    headers: accountHeaders(),
  });

  if (!response.ok) {
    throw new ApiRequestError(
      `Studio server returned ${response.status}. Please try again.`,
      { status: response.status, responseText: await response.text().catch(() => '') }
    );
  }
}
