import { Router } from 'express';
import { createRoom, getRooms } from '../services/signaling.js';

export const roomRouter = Router();

// Create a new room
roomRouter.post('/', (req, res) => {
  const { name, hostName } = req.body;

  if (!name || !hostName) {
    res.status(400).json({ error: 'name and hostName are required' });
    return;
  }

  const room = createRoom(name, hostName);
  res.status(201).json(room);
});

// Get room info
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

// Check if room exists (for guest join page)
roomRouter.get('/:id/exists', (req, res) => {
  const rooms = getRooms();
  const roomState = rooms.get(req.params.id);

  if (!roomState) {
    res.status(404).json({ exists: false });
    return;
  }

  res.json({
    exists: true,
    name: roomState.room.name,
    participantCount: roomState.participants.size,
    status: roomState.room.status,
  });
});
