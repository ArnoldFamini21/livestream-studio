import { Router, type Response } from 'express';
import type { Room } from '@studio/shared';
import { createRoom, getRooms, recoverHostAccess, RoomQuotaError } from '../services/signaling.js';

export const roomRouter = Router();

// Input validation helpers
const MAX_NAME_LENGTH = 100;
const MAX_HOST_NAME_LENGTH = 50;
const MAX_PASSWORD_LENGTH = 100;

function sanitizeString(str: unknown): string | null {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed.length === 0) return null;
  // Strip control characters
  return trimmed.replace(/[\x00-\x1F\x7F]/g, '');
}

function sanitizeOptionalPassword(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.trim().replace(/[\x00-\x1F\x7F]/g, '');
  return sanitized || undefined;
}

function getClientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function sendCreatorRoom(res: Response, room: Room, hostToken: string, statusCode = 200): void {
  res.status(statusCode).json({
    id: room.id,
    name: room.name,
    status: room.status,
    createdAt: room.createdAt,
    hostName: room.hostName,
    scheduledFor: room.scheduledFor,
    settings: room.settings,
    // hostToken is shown to the creator and stored client-side only.
    // Anyone who later joins as 'host' must present this token to the WS signaling server.
    hostToken,
  });
}

// Create a new room
roomRouter.post('/', (req, res) => {
  try {
    const name = sanitizeString(req.body.name);
    const hostName = sanitizeString(req.body.hostName);
    const password = sanitizeOptionalPassword(req.body.password);

    if (!name || !hostName) {
      res.status(400).json({ error: 'name and hostName are required' });
      return;
    }

    if (name.length > MAX_NAME_LENGTH) {
      res.status(400).json({ error: `name must be ${MAX_NAME_LENGTH} characters or less` });
      return;
    }
    if (hostName.length > MAX_HOST_NAME_LENGTH) {
      res.status(400).json({ error: `hostName must be ${MAX_HOST_NAME_LENGTH} characters or less` });
      return;
    }
    if (password && password.length > MAX_PASSWORD_LENGTH) {
      res.status(400).json({ error: `password must be ${MAX_PASSWORD_LENGTH} characters or less` });
      return;
    }

    const { room, hostToken } = createRoom(name, hostName, { creatorIp: getClientIp(req), password });
    sendCreatorRoom(res, room, hostToken, 201);
  } catch (err) {
    if (err instanceof RoomQuotaError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Schedule a room in advance (creates with 'scheduled' status)
roomRouter.post('/schedule', (req, res) => {
  try {
    const name = sanitizeString(req.body.name);
    const hostName = sanitizeString(req.body.hostName);
    const scheduledFor = sanitizeString(req.body.scheduledFor);
    const password = sanitizeOptionalPassword(req.body.password);

    if (!name || !hostName) {
      res.status(400).json({ error: 'name and hostName are required' });
      return;
    }

    if (name.length > MAX_NAME_LENGTH) {
      res.status(400).json({ error: `name must be ${MAX_NAME_LENGTH} characters or less` });
      return;
    }
    if (hostName.length > MAX_HOST_NAME_LENGTH) {
      res.status(400).json({ error: `hostName must be ${MAX_HOST_NAME_LENGTH} characters or less` });
      return;
    }
    if (password && password.length > MAX_PASSWORD_LENGTH) {
      res.status(400).json({ error: `password must be ${MAX_PASSWORD_LENGTH} characters or less` });
      return;
    }

    if (scheduledFor) {
      const date = new Date(scheduledFor);
      if (isNaN(date.getTime())) {
        res.status(400).json({ error: 'Invalid date format for scheduledFor' });
        return;
      }
      if (date.getTime() < Date.now()) {
        res.status(400).json({ error: 'scheduledFor must be in the future' });
        return;
      }
    }

    const { room, hostToken } = createRoom(name, hostName, {
      status: 'scheduled',
      scheduledFor: scheduledFor || undefined,
      creatorIp: getClientIp(req),
      password,
    });
    sendCreatorRoom(res, room, hostToken, 201);
  } catch (err) {
    if (err instanceof RoomQuotaError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Failed to schedule room' });
  }
});

// Recover host access if the room creation response was interrupted or stripped.
roomRouter.post('/:id/host-access', (req, res) => {
  const result = recoverHostAccess(req.params.id, getClientIp(req));

  if (result.status === 'ok') {
    sendCreatorRoom(res, result.room, result.hostToken);
    return;
  }

  if (result.status === 'not_found') {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  if (result.status === 'forbidden') {
    res.status(403).json({ error: 'Host access can only be recovered from the creator network.' });
    return;
  }

  res.status(410).json({ error: 'Host access recovery expired. Create a new studio to get a fresh private host link.' });
});

// Get room info (requires knowing the room ID)
roomRouter.get('/:id', (req, res) => {
  try {
    const rooms = getRooms();
    const roomState = rooms.get(req.params.id);

    if (!roomState) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const participants = Array.from(roomState.participants.values()).map((p) => ({
      id: p.participant.id,
      name: p.participant.name,
      role: p.participant.role,
      audioEnabled: p.participant.audioEnabled,
      videoEnabled: p.participant.videoEnabled,
      screenSharing: p.participant.screenSharing,
      status: p.participant.status,
      joinedAt: p.participant.joinedAt,
    }));

    res.json({
      id: roomState.room.id,
      name: roomState.room.name,
      status: roomState.room.status,
      createdAt: roomState.room.createdAt,
      hostName: roomState.room.hostName,
      scheduledFor: roomState.room.scheduledFor,
      settings: roomState.room.settings,
      participants,
      participantCount: participants.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get room' });
  }
});

// Check if room exists (for guest join page) — reduced info to prevent enumeration
roomRouter.get('/:id/exists', (req, res) => {
  try {
    const rooms = getRooms();
    const roomState = rooms.get(req.params.id);

    if (!roomState) {
      res.status(404).json({ exists: false });
      return;
    }

    // Only return minimal info needed for the join page
    res.json({
      exists: true,
      name: roomState.room.name,
      participantCount: roomState.participants.size,
      status: roomState.room.status,
      hostName: roomState.room.hostName,
      scheduledFor: roomState.room.scheduledFor,
      passwordProtected: roomState.room.settings.passwordProtected,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check room' });
  }
});
