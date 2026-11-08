import { Router } from 'express';
import { createHash } from 'node:crypto';
import { castWatchPollVote, findWatchLinkRoom, getWatchPoll, registerRoomGuest, RoomRegistrationError, WatchPollVoteError } from '../services/signaling.js';

/**
 * The public watch page is addressed by a private watch id, not the room id:
 * the room id is what lets a guest into the green room, so it must never be
 * published with a watch link. These routes give the watch page only what it
 * shows (title, schedule, registration) and accept viewer registrations.
 * Studios from before private watch ids still answer to the /watch/<roomId>
 * links already shared; the response always carries the canonical watch id.
 */
export const watchRouter = Router();

watchRouter.get('/:watchId', (req, res) => {
  const found = findWatchLinkRoom(req.params.watchId);
  if (!found) {
    res.status(404).json({ error: 'This broadcast was not found or has ended' });
    return;
  }
  const { room, watchId } = found;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: watchId,
    name: room.name,
    status: room.status,
    hostName: room.hostName,
    scheduledFor: room.scheduledFor,
    registration: room.registration,
  });
});

watchRouter.post('/:watchId/registrants', (req, res) => {
  const room = findWatchLinkRoom(req.params.watchId)?.room;
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

// Live polls for viewers: the poll on screen, and an anonymous vote per browser.
watchRouter.get('/:watchId/poll', (req, res) => {
  const room = findWatchLinkRoom(req.params.watchId)?.room;
  res.setHeader('Cache-Control', 'no-store');
  if (!room) {
    res.status(404).json({ error: 'This broadcast was not found or has ended' });
    return;
  }
  res.json({ poll: getWatchPoll(room.id) });
});

watchRouter.post('/:watchId/poll-votes', (req, res) => {
  const room = findWatchLinkRoom(req.params.watchId)?.room;
  if (!room) {
    res.status(404).json({ error: 'This broadcast was not found or has ended', code: 'ROOM_NOT_FOUND' });
    return;
  }
  // Only a hash of the address is kept, to cap votes per network.
  const networkKey = createHash('sha256').update(req.ip || 'unknown').digest('base64url').slice(0, 22);
  try {
    const poll = castWatchPollVote(room.id, {
      pollId: req.body?.pollId,
      optionId: req.body?.optionId,
      voterId: req.body?.voterId,
      networkKey,
    });
    res.json({ poll });
  } catch (err) {
    if (err instanceof WatchPollVoteError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'Failed to record the vote' });
  }
});
