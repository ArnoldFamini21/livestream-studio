import { Router, type Request, type Response } from 'express';
import {
  buildWorkspaceStudioCatalogListResponse,
  InMemoryWorkspaceStudioCatalogStore,
  normalizeWorkspaceStudioCatalogEntry,
  WorkspaceStudioCatalogError,
  type WorkspaceStudioCatalogStore,
} from '../services/workspaceStudioCatalog.js';
import { getRoomHostAccess } from '../services/signaling.js';
import { getAccountSessionForRequest } from './auth.js';

export const workspaceStudioRouter = Router();

let workspaceStudioCatalogStore: WorkspaceStudioCatalogStore = new InMemoryWorkspaceStudioCatalogStore();

export function configureWorkspaceStudioCatalogStore(store: WorkspaceStudioCatalogStore | null) {
  workspaceStudioCatalogStore = store || new InMemoryWorkspaceStudioCatalogStore();
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendHostAccessError(res: Response, status: 'not_found' | 'forbidden') {
  if (status === 'not_found') {
    res.status(404).json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    return;
  }
  res.status(403).json({ error: 'Host access is required for workspace studio catalog.', code: 'HOST_TOKEN_INVALID' });
}

function getHostAuthorizedRoom(req: Request, res: Response) {
  const access = getRoomHostAccess(req.params.roomId, getHeaderValue(req.headers['x-host-token']));
  if (access.status !== 'ok') {
    sendHostAccessError(res, access.status);
    return null;
  }
  return access.room;
}

async function getAuthorizedAccountId(req: Request, res: Response): Promise<string | null> {
  const session = await getAccountSessionForRequest(req);
  if (!session.user) {
    res.status(401).json({ error: 'Account session is required.', code: 'ACCOUNT_SESSION_REQUIRED' });
    return null;
  }
  return session.user.id;
}

function buildVerifiedWorkspaceStudioEntry(body: unknown) {
  const entry = normalizeWorkspaceStudioCatalogEntry(body);
  const targetAccess = getRoomHostAccess(entry.id, entry.hostToken);
  if (targetAccess.status !== 'ok') {
    return { entry: null, accessStatus: targetAccess.status as 'not_found' | 'forbidden' };
  }

  const targetRoom = targetAccess.room;
  return {
    entry: {
      ...entry,
      name: targetRoom.name || entry.name,
      hostName: targetRoom.hostName || entry.hostName,
      createdAt: targetRoom.createdAt || entry.createdAt,
      scheduledFor: targetRoom.scheduledFor || entry.scheduledFor,
      passwordProtected: Boolean(targetRoom.settings?.passwordProtected),
      registrationEnabled: Boolean(targetRoom.registration?.enabled),
      status: targetRoom.status || entry.status,
    },
    accessStatus: 'ok' as const,
  };
}

workspaceStudioRouter.get('/account/catalog', async (req, res) => {
  try {
    const accountId = await getAuthorizedAccountId(req, res);
    if (!accountId) return;
    const studios = await workspaceStudioCatalogStore.listAccountStudios(accountId);
    res.json(buildWorkspaceStudioCatalogListResponse(`account:${accountId}`, studios));
  } catch (err) {
    console.error('Failed to list account workspace studio catalog:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to list account workspace studio catalog', code: 'ACCOUNT_WORKSPACE_STUDIO_CATALOG_LIST_FAILED' });
  }
});

workspaceStudioRouter.post('/account/catalog', async (req, res) => {
  try {
    const accountId = await getAuthorizedAccountId(req, res);
    if (!accountId) return;
    const verified = buildVerifiedWorkspaceStudioEntry(req.body);
    if (!verified.entry) {
      sendHostAccessError(res, verified.accessStatus);
      return;
    }
    const saved = await workspaceStudioCatalogStore.upsertAccountStudio(accountId, verified.entry);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof WorkspaceStudioCatalogError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Failed to save account workspace studio catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to save account workspace studio catalog entry', code: 'ACCOUNT_WORKSPACE_STUDIO_CATALOG_SAVE_FAILED' });
  }
});

workspaceStudioRouter.delete('/account/catalog/:studioId', async (req, res) => {
  try {
    const accountId = await getAuthorizedAccountId(req, res);
    if (!accountId) return;
    await workspaceStudioCatalogStore.deleteAccountStudio(accountId, req.params.studioId);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete account workspace studio catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to delete account workspace studio catalog entry', code: 'ACCOUNT_WORKSPACE_STUDIO_CATALOG_DELETE_FAILED' });
  }
});

workspaceStudioRouter.get('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const studios = await workspaceStudioCatalogStore.listRoomStudios(room.id);
    res.json(buildWorkspaceStudioCatalogListResponse(room.id, studios));
  } catch (err) {
    console.error('Failed to list workspace studio catalog:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to list workspace studio catalog', code: 'WORKSPACE_STUDIO_CATALOG_LIST_FAILED' });
  }
});

workspaceStudioRouter.post('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const verified = buildVerifiedWorkspaceStudioEntry(req.body);
    if (!verified.entry) {
      sendHostAccessError(res, verified.accessStatus);
      return;
    }

    const saved = await workspaceStudioCatalogStore.upsertStudio(room.id, verified.entry);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof WorkspaceStudioCatalogError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Failed to save workspace studio catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to save workspace studio catalog entry', code: 'WORKSPACE_STUDIO_CATALOG_SAVE_FAILED' });
  }
});

workspaceStudioRouter.delete('/rooms/:roomId/catalog/:studioId', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    await workspaceStudioCatalogStore.deleteStudio(room.id, req.params.studioId);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete workspace studio catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to delete workspace studio catalog entry', code: 'WORKSPACE_STUDIO_CATALOG_DELETE_FAILED' });
  }
});
