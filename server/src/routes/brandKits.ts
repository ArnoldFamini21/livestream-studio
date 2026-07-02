import { Router, type Request, type Response } from 'express';
import {
  BrandKitCatalogError,
  buildBrandKitCatalogListResponse,
  InMemoryBrandKitCatalogStore,
  normalizeBrandKitCatalogEntry,
  type BrandKitCatalogStore,
} from '../services/brandKitCatalog.js';
import { getRoomHostAccess } from '../services/signaling.js';

export const brandKitRouter = Router();

let brandKitCatalogStore: BrandKitCatalogStore = new InMemoryBrandKitCatalogStore();

export function configureBrandKitCatalogStore(store: BrandKitCatalogStore | null) {
  brandKitCatalogStore = store || new InMemoryBrandKitCatalogStore();
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendHostAccessError(res: Response, status: 'not_found' | 'forbidden') {
  if (status === 'not_found') {
    res.status(404).json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    return;
  }
  res.status(403).json({ error: 'Host access is required for brand kit catalog.', code: 'HOST_TOKEN_INVALID' });
}

function getHostAuthorizedRoom(req: Request, res: Response) {
  const access = getRoomHostAccess(req.params.roomId, getHeaderValue(req.headers['x-host-token']));
  if (access.status !== 'ok') {
    sendHostAccessError(res, access.status);
    return null;
  }
  return access.room;
}

brandKitRouter.get('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const brandKits = await brandKitCatalogStore.listRoomBrandKits(room.id);
    res.json(buildBrandKitCatalogListResponse(room.id, brandKits));
  } catch (err) {
    console.error('Failed to list brand kit catalog:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to list brand kit catalog', code: 'BRAND_KIT_CATALOG_LIST_FAILED' });
  }
});

brandKitRouter.post('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const entry = normalizeBrandKitCatalogEntry(room.id, req.body);
    const saved = await brandKitCatalogStore.upsertBrandKit(entry);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof BrandKitCatalogError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Failed to save brand kit catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to save brand kit catalog entry', code: 'BRAND_KIT_CATALOG_SAVE_FAILED' });
  }
});

brandKitRouter.delete('/rooms/:roomId/catalog/:brandKitId', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    await brandKitCatalogStore.deleteBrandKit(room.id, req.params.brandKitId);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete brand kit catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to delete brand kit catalog entry', code: 'BRAND_KIT_CATALOG_DELETE_FAILED' });
  }
});
