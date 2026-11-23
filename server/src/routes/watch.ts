import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { VIEWER_BODY_MAX_BYTES } from '@studio/shared';
import { castWatchPollVote, findWatchLinkRoom, getRoomViewerChat, getRoomWatchCalls, getWatchCaptionSnapshot, getWatchPoll, registerRoomGuest, RoomRegistrationError, watchCaptionsAvailable, WatchPollVoteError } from '../services/signaling.js';
import { authorizeWatchViewer, getWatchAccessSecret, issueWatchGrant, verifyWatchGrant } from '../services/watchAccess.js';
import { WatchCallInError } from '../services/watchCallIns.js';
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
    ...(room.premiere ? { premiere: true } : {}),
    registration: room.registration,
  });
});

watchRouter.post('/:watchId/registrants', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const found = findWatchLinkRoom(req.params.watchId);
  if (!found) {
    res.status(404).json({ error: 'This broadcast was not found or has ended', code: 'ROOM_NOT_FOUND' });
    return;
  }
  const { room, watchId } = found;
  const secret = getWatchAccessSecret();
  if (room.registration?.enabled && !secret) {
    res.status(503).json({ error: 'Protected viewing is not available for this broadcast.' });
    return;
  }
  const invite = room.registration?.inviteOnly && secret
    ? verifyWatchGrant(req.body?.invite, 'watch-invite', watchId, secret)
    : null;
  if (room.registration?.inviteOnly && !invite) {
    res.status(403).json({ error: 'This private broadcast needs a valid invite link from the host.', code: 'WATCH_INVITE_REQUIRED' });
    return;
  }
  try {
    const result = registerRoomGuest(room.id, {
      name: req.body?.name,
      email: req.body?.email,
    });
    // The registrant record names the studio; the watch page needs only the count.
    const access = secret ? issueWatchGrant('watch-playback', watchId, secret, invite?.exp) : undefined;
    res.status(201).json({
      total: result.total,
      registrant: { name: result.registrant.name, email: result.registrant.email, registeredAt: result.registrant.registeredAt },
      ...(access ? { access } : {}),
    });
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
  if (!authorizeWatchViewer(req, res, found)) return;
  res.json(getWatchCaptionSnapshot(found.room.id));
});

// Live polls for viewers: the poll on screen, and an anonymous vote per browser.
watchRouter.get('/:watchId/poll', (req, res) => {
  const found = findWatchLinkRoom(req.params.watchId);
  res.setHeader('Cache-Control', 'no-store');
  if (!found) {
    res.status(404).json({ error: 'This broadcast was not found or has ended' });
    return;
  }
  if (!authorizeWatchViewer(req, res, found)) return;
  res.json({ poll: getWatchPoll(found.room.id) });
});

watchRouter.post('/:watchId/poll-votes', (req, res) => {
  const found = findWatchLinkRoom(req.params.watchId);
  if (!found) {
    res.status(404).json({ error: 'This broadcast was not found or has ended', code: 'ROOM_NOT_FOUND' });
    return;
  }
  if (!authorizeWatchViewer(req, res, found)) return;
  // Only a salted hash of the address is kept, to cap votes per network.
  const networkKey = networkKeyFor(req.ip);
  try {
    const poll = castWatchPollVote(found.room.id, {
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

function viewerChatFor(req: Request, res: Response): { chat: ViewerChatRoom; roomId: string } | null {
  const found = findWatchLinkRoom(req.params.watchId);
  if (found && !authorizeWatchViewer(req, res, found)) return null;
  const chat = found ? getRoomViewerChat(found.room.id) : undefined;
  if (!found || !chat) {
    res.status(404).json({ error: 'This broadcast was not found or has ended', code: 'ROOM_NOT_FOUND' });
    return null;
  }
  return { chat, roomId: found.room.id };
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
  const viewerRoom = viewerChatFor(req, res);
  if (!viewerRoom) return;
  const { chat } = viewerRoom;
  try {
    const callInsEnabled = getRoomWatchCalls(viewerRoom.roomId)?.isEnabled() ?? false;
    res.json({ ...chat.live({ after: req.query.after, epoch: req.query.epoch }, Date.now(), viewerNetworkKey(req), callInsEnabled),
      ...(callInsEnabled ? { callInsEnabled } : {}),
      ...(watchCaptionsAvailable(viewerRoom.roomId) ? { captionsAvailable: true } : {}),
    });
  } catch (err) {
    answerViewerError(res, err);
  }
});

function viewerNetworkKey(req: Request): string {
  return networkKeyFor(req.ip || req.socket.remoteAddress);
}

watchRouter.post('/:watchId/chat', readViewerBody, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const viewerRoom = viewerChatFor(req, res);
  if (!viewerRoom) return;
  const { chat } = viewerRoom;
  try {
    res.status(201).json(chat.postMessage(req.body, viewerNetworkKey(req), Date.now()));
  } catch (err) {
    answerViewerError(res, err);
  }
});

watchRouter.post('/:watchId/questions', readViewerBody, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const viewerRoom = viewerChatFor(req, res);
  if (!viewerRoom) return;
  const { chat } = viewerRoom;
  try {
    chat.postQuestion(req.body, viewerNetworkKey(req), Date.now());
    res.status(201).json({ ok: true });
  } catch (err) {
    answerViewerError(res, err);
  }
});

watchRouter.post('/:watchId/reactions', readViewerBody, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const viewerRoom = viewerChatFor(req, res);
  if (!viewerRoom) return;
  const { chat } = viewerRoom;
  try {
    chat.postReaction(req.body, viewerNetworkKey(req), Date.now());
    res.json({ ok: true });
  } catch (err) {
    answerViewerError(res, err);
  }
});

function watchCallsFor(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const found = findWatchLinkRoom(req.params.watchId);
  if (found && !authorizeWatchViewer(req, res, found)) return null;
  const calls = found ? getRoomWatchCalls(found.room.id) : undefined;
  if (!found || !calls) {
    res.status(404).json({ error: 'This broadcast was not found or has ended' });
    return null;
  }
  return { calls, roomId: found.room.id };
}

watchRouter.post('/:watchId/call-ins', readViewerBody, (req, res) => {
  const room = watchCallsFor(req, res);
  if (!room) return;
  const network = viewerNetworkKey(req);
  try {
    getRoomViewerChat(room.roomId)?.requireViewer(req.body?.viewerId, network);
    const receipt = room.calls.request(req.body, network);
    res.status(201).json(receipt);
  } catch (error) {
    if (error instanceof WatchCallInError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    answerViewerError(res, error);
  }
});

watchRouter.get('/:watchId/call-ins/:id', (req, res) => {
  const room = watchCallsFor(req, res);
  if (!room) return;
  const status = room.calls.status(req.params.id, req.get('X-Watch-Call-Key') || '');
  if (!status) {
    res.status(404).json({ error: 'This call-in request is no longer available.' });
    return;
  }
  res.json(status);
});

watchRouter.post('/:watchId/call-ins/:id/cancel', (req, res) => {
  const room = watchCallsFor(req, res);
  if (!room) return;
  if (!room.calls.cancel(req.params.id, req.get('X-Watch-Call-Key') || '')) {
    res.status(404).json({ error: 'This call-in request is no longer waiting.' });
    return;
  }
  res.json({ state: 'cancelled' });
});
