import { Router, type Request, type Response } from 'express';
import {
  buildRecordingCatalogListResponse,
  InMemoryRecordingCatalogStore,
  normalizeRecordingCatalogEntry,
  RecordingCatalogError,
  type RecordingCatalogStore,
} from '../services/recordingCatalog.js';
import { getRoomHostAccess } from '../services/signaling.js';

export const recordingRouter = Router();

let recordingCatalogStore: RecordingCatalogStore = new InMemoryRecordingCatalogStore();

export function configureRecordingCatalogStore(store: RecordingCatalogStore | null) {
  recordingCatalogStore = store || new InMemoryRecordingCatalogStore();
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendHostAccessError(res: Response, status: 'not_found' | 'forbidden') {
  if (status === 'not_found') {
    res.status(404).json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
    return;
  }
  res.status(403).json({ error: 'Host access is required for recording catalog.', code: 'HOST_TOKEN_INVALID' });
}

function getHostAuthorizedRoom(req: Request, res: Response) {
  const access = getRoomHostAccess(req.params.roomId, getHeaderValue(req.headers['x-host-token']));
  if (access.status !== 'ok') {
    sendHostAccessError(res, access.status);
    return null;
  }
  return access.room;
}

recordingRouter.get('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const recordings = await recordingCatalogStore.listRoomRecordings(room.id);
    res.json(buildRecordingCatalogListResponse(room.id, recordings));
  } catch (err) {
    console.error('Failed to list recording catalog:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to list recording catalog', code: 'RECORDING_CATALOG_LIST_FAILED' });
  }
});

recordingRouter.post('/rooms/:roomId/catalog', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    const entry = normalizeRecordingCatalogEntry(room.id, room.name, req.body);
    const saved = await recordingCatalogStore.upsertRecording(entry);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof RecordingCatalogError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('Failed to save recording catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to save recording catalog entry', code: 'RECORDING_CATALOG_SAVE_FAILED' });
  }
});

recordingRouter.delete('/rooms/:roomId/catalog/:recordingId', async (req, res) => {
  const room = getHostAuthorizedRoom(req, res);
  if (!room) return;

  try {
    await recordingCatalogStore.deleteRecording(room.id, req.params.recordingId);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete recording catalog entry:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to delete recording catalog entry', code: 'RECORDING_CATALOG_DELETE_FAILED' });
  }
});
