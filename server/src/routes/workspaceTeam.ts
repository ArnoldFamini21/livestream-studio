import { Router, type Request, type Response } from 'express';
import {
  buildWorkspaceTeamCatalogListResponse,
  InMemoryWorkspaceTeamCatalogStore,
  normalizeWorkspaceTeamCatalogMember,
  WorkspaceTeamCatalogError,
  type WorkspaceTeamCatalogStore,
} from '../services/workspaceTeamCatalog.js';
import { getRoomHostAccess } from '../services/signaling.js';

export const workspaceTeamRouter = Router();

let workspaceTeamCatalogStore: WorkspaceTeamCatalogStore = new InMemoryWorkspaceTeamCatalogStore();

export function configureWorkspaceTeamCatalogStore(store: WorkspaceTeamCatalogStore | null) {
  workspaceTeamCatalogStore = store || new InMemoryWorkspaceTeamCatalogStore();
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendHostAccessError(res: Response, status: 'not_found' | 'forbidden') {
  if (status === 'not_found') {
    res.status(404).json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    return;
  }
  res.status(403).json({ error: 'Host access is required for workspace team catalog.', code: 'HOST_TOKEN_INVALID' });
}

function getHostAuthorizedRoom(req: Request, res: Response) {
  const access = getRoomHostAccess(req.params.roomId, getHeaderValue(req.headers['x-host-token']));
  if (access.status !== 'ok') {
    sendHostAccessError(res, access.status);
    return null;
  }
  return access.room;
}

workspaceTeamRouter.get('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const members = await workspaceTeamCatalogStore.listRoomMembers(room.id);
    res.json(buildWorkspaceTeamCatalogListResponse(room.id, members));
  } catch (err) {
    console.error('Failed to list workspace team catalog:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to list workspace team catalog', code: 'WORKSPACE_TEAM_CATALOG_LIST_FAILED' });
  }
});

workspaceTeamRouter.post('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const entry = normalizeWorkspaceTeamCatalogMember(room.id, req.body);
    const saved = await workspaceTeamCatalogStore.upsertMember(entry);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof WorkspaceTeamCatalogError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Failed to save workspace team catalog member:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to save workspace team catalog member', code: 'WORKSPACE_TEAM_CATALOG_SAVE_FAILED' });
  }
});

workspaceTeamRouter.delete('/rooms/:roomId/catalog/:memberId', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    await workspaceTeamCatalogStore.deleteMember(room.id, req.params.memberId);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete workspace team catalog member:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to delete workspace team catalog member', code: 'WORKSPACE_TEAM_CATALOG_DELETE_FAILED' });
  }
});
