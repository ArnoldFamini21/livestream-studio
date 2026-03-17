import { Router } from 'express';
import { createRoom, getRooms } from '../services/signaling.js';

export const roomRouter = Router();

// Input validation helpers
const MAX_NAME_LENGTH = 100;
const MAX_HOST_NAME_LENGTH = 50;

function sanitizeString(str: unknown): string | null {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed.length === 0) return null;
  // Strip control characters
  return trimmed.replace(/[\x00-\x1F\x7F]/g, '');
}

// Create a new room
roomRouter.post('/', (req, res) => {
  const name = sanitizeString(req.body.name);
  const hostName = sanitizeString(req.body.hostName);

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

  const room = createRoom(name, hostName);
  res.status(201).json(room);
});

// Schedule a room in advance (creates with 'scheduled' status)
roomRouter.post('/schedule', (req, res) => {
  const name = sanitizeString(req.body.name);
  const hostName = sanitizeString(req.body.hostName);
  const scheduledFor = sanitizeString(req.body.scheduledFor);

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

  const room = createRoom(name, hostName, {
    status: 'scheduled',
    scheduledFor: scheduledFor || undefined,
  });
  res.status(201).json(room);
});

// Get room info (requires knowing the room ID)
roomRouter.get('/:id', (req, res) => {
  const rooms = getRooms();
  const roomState = rooms.get(req.params.id);

  if (!roomState) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const participants = Array.from(roomState.participants.values()).map((p) => p.participant);

  res.json({
    ...roomState.room,
    participants,
    participantCount: participants.length,
  });
});

// Check if room exists (for guest join page) — reduced info to prevent enumeration
roomRouter.get('/:id/exists', (req, res) => {
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
  });
});
