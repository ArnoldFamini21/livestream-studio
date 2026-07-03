import type {
  WorkspaceTeamCatalogListResponse,
  WorkspaceTeamCatalogMember,
  WorkspaceTeamCatalogUpsertRequest,
} from '@studio/shared';
import {
  normalizeWorkspaceTeamMembers,
  type SavedWorkspaceTeamMember,
} from './workspaceTeam.ts';
import { ApiRequestError, buildApiUrl, getJson, postJson } from './apiClient.ts';

export interface SyncWorkspaceTeamCatalogInput {
  roomId: string;
  hostToken: string;
  member: SavedWorkspaceTeamMember;
}

function catalogHeaders(hostToken: string): Headers {
  const headers = new Headers();
  headers.set('x-host-token', hostToken);
  return headers;
}

export function buildWorkspaceTeamCatalogUpsertRequest(
  member: SavedWorkspaceTeamMember
): WorkspaceTeamCatalogUpsertRequest {
  return {
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    createdAt: member.createdAt,
  };
}

export function catalogMemberToSavedWorkspaceTeamMember(
  entry: WorkspaceTeamCatalogMember
): SavedWorkspaceTeamMember {
  return {
    id: entry.id,
    name: entry.name,
    email: entry.email,
    role: entry.role,
    createdAt: entry.createdAt,
  };
}

export function mergeWorkspaceTeamCatalogMembers(
  localMembers: SavedWorkspaceTeamMember[],
  serverMembers: WorkspaceTeamCatalogMember[] = []
): SavedWorkspaceTeamMember[] {
  const byId = new Map<string, SavedWorkspaceTeamMember>();
  for (const member of localMembers) byId.set(member.id, member);
  for (const member of serverMembers) {
    if (!byId.has(member.id)) byId.set(member.id, catalogMemberToSavedWorkspaceTeamMember(member));
  }
  return normalizeWorkspaceTeamMembers(Array.from(byId.values()));
}

export function fetchWorkspaceTeamCatalog(
  roomId: string,
  hostToken: string
): Promise<WorkspaceTeamCatalogListResponse> {
  return getJson<WorkspaceTeamCatalogListResponse>(
    `/api/workspace-team/rooms/${encodeURIComponent(roomId)}/catalog`,
    { headers: catalogHeaders(hostToken) }
  );
}

export function syncWorkspaceTeamCatalogMember({
  roomId,
  hostToken,
  member,
}: SyncWorkspaceTeamCatalogInput): Promise<WorkspaceTeamCatalogMember> {
  return postJson<WorkspaceTeamCatalogMember>(
    `/api/workspace-team/rooms/${encodeURIComponent(roomId)}/catalog`,
    buildWorkspaceTeamCatalogUpsertRequest(member),
    { headers: catalogHeaders(hostToken) }
  );
}

export async function deleteWorkspaceTeamCatalogMember(
  roomId: string,
  hostToken: string,
  memberId: string
): Promise<void> {
  const response = await fetch(buildApiUrl(
    `/api/workspace-team/rooms/${encodeURIComponent(roomId)}/catalog/${encodeURIComponent(memberId)}`
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
