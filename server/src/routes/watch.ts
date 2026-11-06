import { Router } from 'express';
import { findRoomByWatchId, registerRoomGuest, RoomRegistrationError } from '../services/signaling.js';

/**
 * The public watch page is addressed by a private watch id, not the room id:
 * the room id is what lets a guest into the green room, so it must never be
 * published with a watch link. These routes give the watch page only what it
 * shows (title, schedule, registration) and accept viewer registrations.
 */
export const watchRouter = Router();

watchRouter.get('/:watchId', (req, res) => {
  const room = findRoomByWatchId(req.params.watchId);
  if (!room) {
    res.status(404).json({ error: 'This broadcast was not found or has ended' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: req.params.watchId,
    name: room.name,
    status: room.status,
    hostName: room.hostName,
    scheduledFor: room.scheduledFor,
    registration: room.registration,
  });
});

watchRouter.post('/:watchId/registrants', (req, res) => {
  const room = findRoomByWatchId(req.params.watchId);
  if (!room) {
    res.status(404).json({ error: 'This broadcast was not found or has ended', code: 'ROOM_NOT_FOUND' });
    return;
  }
  try {
    const result = registerRoomGuest(room.id, {
      name: req.body?.name,
      email: req.body?.email,
    });
    // The registrant record names the studio; the watch page needs only the count.
    res.status(201).json({ total: result.total, registrant: { name: result.registrant.name, email: result.registrant.email, registeredAt: result.registrant.registeredAt } });
  } catch (err) {
    if (err instanceof RoomRegistrationError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Failed to register' });
  }
});
