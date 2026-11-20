import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { VIEWER_BODY_MAX_BYTES } from '@studio/shared';
import { castWatchPollVote, findWatchLinkRoom, getRoomViewerChat, getWatchCaptionSnapshot, getWatchPoll, registerRoomGuest, RoomRegistrationError, WatchPollVoteError } from '../services/signaling.js';
import { ViewerChatError, networkKeyFor, type ViewerChatRoom } from '../services/viewerChat.js';

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

watchRouter.get('/:watchId/captions', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const found = findWatchLinkRoom(req.params.watchId);
  if (!found) {
    res.status(404).json({ error: 'This broadcast was not found or has ended' });
    return;
  }
  if (found.room.registration?.enabled) {
    res.status(401).json({ error: 'Viewer access is required' });
    return;
  }
  res.json(getWatchCaptionSnapshot(found.room.id));
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
  // Only a salted hash of the address is kept, to cap votes per network.
  const networkKey = networkKeyFor(req.ip);
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

// ============ Viewer chat, reactions and questions (P1.7) ============
//
// Viewers are anonymous and not part of the studio connection, so this is
// plain HTTP like poll voting: one GET (with a cursor) the page asks for every
// few seconds, and one small POST for each thing a viewer sends. Everything is
// decided on the server (switches, limits, filter, blocks); the page is never
// trusted. Nothing here logs: not text, names, addresses, ids or keys.

/** Bodies are tiny (a name and a few hundred characters). Anything bigger is refused before it is read. */
const parseViewerJson = express.json({ limit: VIEWER_BODY_MAX_BYTES, inflate: false, type: 'application/json' });

function readViewerBody(req: Request, res: Response, next: NextFunction): void {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    res.status(415).json({ error: 'Please send plain JSON.', code: 'UNSUPPORTED_MEDIA_TYPE' });
    return;
  }
  // Parser errors can quote untrusted text: answer with a fixed line and never let them reach the error logger.
  parseViewerJson(req, res, (error?: { status?: number }) => {
    if (error) {
      const status = error.status === 413 || error.status === 415 ? error.status : 400;
      res.status(status).json({
        error: status === 413 ? 'That message is too large to send.' : status === 415 ? 'Please send plain JSON.' : 'That request was not understood.',
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'VALIDATION_ERROR',
      });
      return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'That request was not understood.', code: 'VALIDATION_ERROR' });
      return;
    }
    next();
  });
}

function viewerChatFor(req: Request, res: Response): ViewerChatRoom | null {
  const room = findWatchLinkRoom(req.params.watchId)?.room;
  const chat = room ? getRoomViewerChat(room.id) : undefined;
  if (!chat) {
    res.status(404).json({ error: 'This broadcast was not found or has ended', code: 'ROOM_NOT_FOUND' });
    return null;
  }
  return chat;
}

function answerViewerError(res: Response, err: unknown): void {
  if (err instanceof ViewerChatError) {
    if (err.retryAfterMs !== undefined) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// What changed since the page last asked: chat, reactions and the three switches in one small answer.
watchRouter.get('/:watchId/live', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const chat = viewerChatFor(req, res);
  if (!chat) return;
  try {
    res.json(chat.live({ after: req.query.after, epoch: req.query.epoch }, Date.now(), viewerNetworkKey(req)));
  } catch (err) {
    answerViewerError(res, err);
  }
});

function viewerNetworkKey(req: Request): string {
  return networkKeyFor(req.ip || req.socket.remoteAddress);
}

watchRouter.post('/:watchId/chat', readViewerBody, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const chat = viewerChatFor(req, res);
  if (!chat) return;
  try {
    res.status(201).json(chat.postMessage(req.body, viewerNetworkKey(req), Date.now()));
  } catch (err) {
    answerViewerError(res, err);
  }
});

watchRouter.post('/:watchId/questions', readViewerBody, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const chat = viewerChatFor(req, res);
  if (!chat) return;
  try {
    chat.postQuestion(req.body, viewerNetworkKey(req), Date.now());
    res.status(201).json({ ok: true });
  } catch (err) {
    answerViewerError(res, err);
  }
});

watchRouter.post('/:watchId/reactions', readViewerBody, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const chat = viewerChatFor(req, res);
  if (!chat) return;
  try {
    chat.postReaction(req.body, viewerNetworkKey(req), Date.now());
    res.json({ ok: true });
  } catch (err) {
    answerViewerError(res, err);
  }
});
