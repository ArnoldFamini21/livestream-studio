import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type {
  SignalMessage,
  Room,
  Participant,
  JoinRoomPayload,
  MediaStatePayload,
  ChatMessage,
  ChatTypingPayload,
  ChatReactionType,
  QAQuestion,
  LivePoll,
  StageActionPayload,
  StageBackground,
  RecordingStatePayload,
  LiveStreamStatePayload,
  LiveStreamTokenClaims,
  StudioBrandingPayload,
} from '@studio/shared';
import {
  ROOM_NOT_OPEN_ERROR_CODE,
  SCHEDULED_GUEST_ACCESS_MESSAGE,
  canExchangeStudioMedia,
  isChatReactionType,
  isScheduledGuestAccessBlocked,
} from '@studio/shared';

type RelaySignalMessage = Extract<SignalMessage, { type: 'offer' | 'answer' | 'ice-candidate' }>;

// In-memory store (replace with Redis/PostgreSQL later)
interface RoomState {
  room: Room;
  participants: Map<string, { participant: Participant; ws: WebSocket; joinSessionId?: string }>;
  bannedJoinSessionIds: Set<string>;
  chatMessages: Map<string, ChatMessage>;
  chatReactions: Map<string, Map<ChatReactionType, Set<string>>>;
  qaQuestions: Map<string, QAQuestion>;
  qaVotes: Map<string, Set<string>>;
  polls: Map<string, LivePoll>;
  pollVotes: Map<string, Map<string, string>>;
  studioBranding?: StudioBrandingPayload;
  coHostInviteTokens: Map<string, { expiresAt: number; issuedBy: string; createdAt: number }>;
  recordingStartedAt?: string;
  liveStreamStartedAt?: string;
  liveStreamStartedBy?: string;
  // Server-issued secret returned to the room creator and required on host join-room.
  hostToken: string;
  // Optional guest password verifier. The raw password is never stored.
  passwordHash?: string;
  passwordSalt?: string;
  // Creator IP, used to enforce a per-IP active-room quota.
  creatorIp: string;
  // True once any participant successfully joined; used for shorter idle expiry.
  hasBeenJoined: boolean;
  emptyRoomTimer?: ReturnType<typeof setTimeout>;
}

// Extend WebSocket to track heartbeat state
interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
  clientIp?: string;
}

// Known message types for validation (fix #10)
const KNOWN_MESSAGE_TYPES = new Set([
  'join-room',
  'offer',
  'answer',
  'ice-candidate',
  'media-state-changed',
  'chat-message',
  'chat-typing',
  'chat-reaction',
  'chat-star-update',
  'chat-pin-update',
  'qa-question-submitted',
  'qa-question-update',
  'qa-question-upvote',
  'poll-create',
  'poll-vote',
  'poll-update',
  'stage-action',
  'studio-branding-updated',
  'recording-state-changed',
  'live-stream-state-changed',
  'live-stream-token-request',
  'co-host-invite-token-request',
  'end-room',
]);

const STAGE_ACTIONS = new Set<StageActionPayload['action']>([
  'move-to-stage',
  'move-to-backstage',
  'move-to-green-room',
  'notify-next',
  'promote-co-host',
  'demote-to-guest',
  'mute',
  'unmute',
  'remove',
  'ban',
]);

const MAX_BRANDING_TEXT_LENGTH = 220;
const MAX_BRANDING_URL_LENGTH = 600_000;
const DEFAULT_BRANDING_COLOR = '#a78bfa';
const DEFAULT_WAITING_ROOM_HEADLINE = "You're in the green room";
const DEFAULT_WAITING_ROOM_MESSAGE = 'The host can see that you arrived and will bring you on stage when ready.';
const STAGE_BACKGROUND_TYPES = new Set<StageBackground['type']>(['none', 'color', 'gradient', 'image']);

const MAX_ROOMS = 1000;
const MAX_ROOMS_PER_IP = 5;
// Idle (never-joined) rooms expire fast so a bad actor can't squat on the global pool.
const NEVER_JOINED_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVE_IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMPTY_ROOM_GRACE_MS = parseBoundedDurationMs(
  process.env.EMPTY_ROOM_GRACE_MS,
  2 * 60 * 1000,
  10 * 1000,
  10 * 60 * 1000
);

const rooms = new Map<string, RoomState>();
const wsToParticipant = new Map<WebSocket, { roomId: string; participantId: string }>();
const endingTimers = new Map<string, NodeJS.Timeout>();
// IP -> Set<roomId> of rooms this IP created and that are still active.
const roomsByCreatorIp = new Map<string, Set<string>>();

// Stale room cleanup: never-joined rooms expire after 30 min, joined rooms after 24h.
const staleRoomCleanupTimer = setInterval(() => {
  const now = Date.now();
  rooms.forEach((roomState, id) => {
    if (roomState.participants.size > 0) return;
    const created = new Date(roomState.room.createdAt).getTime();
    const idleLimit = roomState.hasBeenJoined ? ACTIVE_IDLE_MS : NEVER_JOINED_IDLE_MS;
    if (now - created > idleLimit) {
      deleteRoom(id);
      console.log(`Stale room ${id} cleaned up (idle for >${Math.round(idleLimit / 60000)}m)`);
    }
  });
}, 10 * 60 * 1000); // Every 10 minutes
staleRoomCleanupTimer.unref?.();

// WebSocket per-connection rate limiting
const wsMessageCounts = new Map<WebSocket, { count: number; resetAt: number }>();
const WS_RATE_LIMIT_WINDOW = 10_000; // 10 seconds
const WS_RATE_LIMIT_MAX = 100; // 100 messages per 10 seconds

// Max lengths for user input
const MAX_CHAT_MESSAGE_LENGTH = 2000;
const MAX_CHAT_HISTORY_PER_ROOM = 500;
const MAX_QA_QUESTION_LENGTH = 500;
const MAX_QA_ANSWER_LENGTH = 1000;
const MAX_POLL_QUESTION_LENGTH = 240;
const MAX_POLL_OPTION_LENGTH = 80;
const MAX_POLL_OPTIONS = 6;
const MAX_ACTIVE_POLLS_PER_ROOM = 20;
const QA_QUESTION_COMMAND = /^(?:!|\/)(?:ask|q)\s+(.+)$/i;
const POLL_VOTE_COMMAND = /^(?:!|\/)vote\s+([1-6a-f])$/i;
const POLL_VOTE_OPTION_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];
const MAX_PARTICIPANT_NAME_LENGTH = 50;
const MAX_JOIN_SESSION_ID_LENGTH = 128;
const MAX_ROOM_PASSWORD_LENGTH = 100;
const LIVE_STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;
const CO_HOST_INVITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CO_HOST_INVITE_TOKENS_PER_ROOM = 20;
const HOST_ACCESS_RECOVERY_WINDOW_MS = parseBoundedDurationMs(
  process.env.HOST_ACCESS_RECOVERY_WINDOW_MS,
  10 * 60 * 1000,
  60 * 1000,
  60 * 60 * 1000
);

function parseBoundedDurationMs(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function getClientIpFromRequest(req?: IncomingMessage): string {
  if (!req) return 'unknown';
  const forwardedFor = getHeaderValue(req.headers['x-forwarded-for'])
    .split(',')[0]
    .trim();
  if (forwardedFor) return forwardedFor;
  const realIp = getHeaderValue(req.headers['x-real-ip']).trim();
  if (realIp) return realIp;
  return req.socket.remoteAddress || 'unknown';
}

function checkWsRateLimit(ws: WebSocket): boolean {
  const now = Date.now();
  const entry = wsMessageCounts.get(ws);
  if (!entry || now > entry.resetAt) {
    wsMessageCounts.set(ws, { count: 1, resetAt: now + WS_RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  if (entry.count > WS_RATE_LIMIT_MAX) {
    return false;
  }
  return true;
}

export function getRooms() {
  return rooms;
}

export interface CreatedRoom {
  room: Room;
  hostToken: string;
}

export type HostAccessRecoveryResult =
  | { status: 'ok'; room: Room; hostToken: string }
  | { status: 'not_found' | 'forbidden' | 'expired' | 'already_joined' };

export class RoomQuotaError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'RoomQuotaError';
  }
}

export function recoverHostAccess(roomId: string, creatorIp: string, nowMs = Date.now()): HostAccessRecoveryResult {
  const roomState = rooms.get(roomId);
  if (!roomState) return { status: 'not_found' };
  if (roomState.creatorIp !== creatorIp) return { status: 'forbidden' };
  if (roomState.hasBeenJoined || roomState.participants.size > 0) return { status: 'already_joined' };

  const createdAtMs = Date.parse(roomState.room.createdAt);
  if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > HOST_ACCESS_RECOVERY_WINDOW_MS) {
    return { status: 'expired' };
  }

  return {
    status: 'ok',
    room: roomState.room,
    hostToken: roomState.hostToken,
  };
}

function deleteRoom(roomId: string) {
  const state = rooms.get(roomId);
  if (!state) return;
  if (state.emptyRoomTimer) {
    clearTimeout(state.emptyRoomTimer);
    state.emptyRoomTimer = undefined;
  }
  const endingTimer = endingTimers.get(roomId);
  if (endingTimer) {
    clearTimeout(endingTimer);
    endingTimers.delete(roomId);
  }
  const ipSet = roomsByCreatorIp.get(state.creatorIp);
  if (ipSet) {
    ipSet.delete(roomId);
    if (ipSet.size === 0) roomsByCreatorIp.delete(state.creatorIp);
  }
  rooms.delete(roomId);
}

function cancelEmptyRoomDeletion(roomId: string, roomState: RoomState) {
  if (!roomState.emptyRoomTimer) return;
  clearTimeout(roomState.emptyRoomTimer);
  roomState.emptyRoomTimer = undefined;
  console.log(`Room ${roomId} empty cleanup cancelled`);
}

function scheduleEmptyRoomDeletion(roomId: string, roomState: RoomState) {
  if (roomState.room.status === 'scheduled' || roomState.emptyRoomTimer) return;

  roomState.emptyRoomTimer = setTimeout(() => {
    const current = rooms.get(roomId);
    if (!current) return;
    current.emptyRoomTimer = undefined;
    if (current.participants.size === 0 && current.room.status !== 'scheduled') {
      deleteRoom(roomId);
      console.log(`Room ${roomId} deleted (empty for >${Math.round(EMPTY_ROOM_GRACE_MS / 1000)}s)`);
    }
  }, EMPTY_ROOM_GRACE_MS);
  roomState.emptyRoomTimer.unref?.();

  console.log(`Room ${roomId} is empty; cleanup scheduled in ${Math.round(EMPTY_ROOM_GRACE_MS / 1000)}s`);
}

function clearRoomEndingTimer(roomId: string) {
  const endingTimer = endingTimers.get(roomId);
  if (!endingTimer) return false;
  clearTimeout(endingTimer);
  endingTimers.delete(roomId);
  return true;
}

function canUseCreatorNetworkHostFallback(ws: WebSocket, roomState: RoomState, nowMs = Date.now()): boolean {
  if (roomState.hasBeenJoined || roomState.participants.size > 0 || roomState.room.hostId) return false;
  const clientIp = (ws as AliveWebSocket).clientIp || 'unknown';
  if (clientIp === 'unknown' || roomState.creatorIp !== clientIp) return false;
  const createdAtMs = Date.parse(roomState.room.createdAt);
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= HOST_ACCESS_RECOVERY_WINDOW_MS;
}

function updateRoomActivityStatus(roomState: RoomState) {
  if (roomState.room.status === 'ended' || roomState.room.status === 'scheduled') return;
  if (roomState.liveStreamStartedAt) {
    roomState.room.status = 'live';
  } else if (roomState.recordingStartedAt) {
    roomState.room.status = 'recording';
  } else {
    roomState.room.status = 'waiting';
  }
}

function clearLiveStreamStateForParticipant(roomId: string, roomState: RoomState, participantId: string): boolean {
  if (roomState.liveStreamStartedBy !== participantId) return false;

  roomState.liveStreamStartedAt = undefined;
  roomState.liveStreamStartedBy = undefined;
  updateRoomActivityStatus(roomState);

  broadcastToRoom(roomId, {
    type: 'live-stream-state-changed',
    payload: {
      live: false,
      stoppedAt: new Date().toISOString(),
      performedBy: participantId,
    },
  });
  return true;
}

function replaceExistingHostSession(roomId: string, roomState: RoomState, existingHostId: string) {
  const existingHost = roomState.participants.get(existingHostId);
  if (!existingHost) return;

  send(existingHost.ws, {
    type: 'participant-removed',
    payload: { reason: 'Your host session was replaced by a newer host login.' },
  });

  roomState.participants.delete(existingHostId);
  wsToParticipant.delete(existingHost.ws);
  roomState.room.coHostIds = roomState.room.coHostIds.filter((id) => id !== existingHostId);

  if (clearRoomEndingTimer(roomId)) {
    broadcastToRoom(roomId, {
      type: 'room-ending-cancelled',
      payload: {},
    });
  }

  broadcastToRoom(roomId, {
    type: 'participant-left',
    payload: { participantId: existingHostId },
  });

  existingHost.ws.close(4000, 'Host session replaced');
  console.log(`Host session for room ${roomId} was replaced by a newer host login`);
}

export function createRoom(
  name: string,
  hostName: string,
  options: { status?: 'waiting' | 'scheduled'; scheduledFor?: string; creatorIp: string; password?: string }
): CreatedRoom {
  if (rooms.size >= MAX_ROOMS) {
    throw new RoomQuotaError('Global room limit reached. Please try again later.', 503);
  }

  const existingForIp = roomsByCreatorIp.get(options.creatorIp);
  if (existingForIp && existingForIp.size >= MAX_ROOMS_PER_IP) {
    throw new RoomQuotaError(
      `You have ${existingForIp.size} active rooms. Close one before creating another.`,
      429
    );
  }

  const room: Room = {
    id: nanoid(10),
    name,
    hostId: '',
    coHostIds: [],
    createdAt: new Date().toISOString(),
    status: options.status || 'waiting',
    settings: {
      maxParticipants: 7,
      resolution: '1080p',
      frameRate: 30,
      enableRecording: true,
      enableStreaming: false,
      greenRoomEnabled: true,
      passwordProtected: Boolean(options.password),
    },
    hostName,
    scheduledFor: options.scheduledFor,
  };

  const hostToken = nanoid(32);
  const passwordVerifier = options.password ? createPasswordVerifier(options.password) : {};

  rooms.set(room.id, {
    room,
    participants: new Map(),
    bannedJoinSessionIds: new Set(),
    chatMessages: new Map(),
    chatReactions: new Map(),
    qaQuestions: new Map(),
    qaVotes: new Map(),
    polls: new Map(),
    pollVotes: new Map(),
    coHostInviteTokens: new Map(),
    hostToken,
    ...passwordVerifier,
    creatorIp: options.creatorIp,
    hasBeenJoined: false,
  });

  let ipSet = roomsByCreatorIp.get(options.creatorIp);
  if (!ipSet) {
    ipSet = new Set();
    roomsByCreatorIp.set(options.creatorIp, ipSet);
  }
  ipSet.add(room.id);

  return { room, hostToken };
}

function createPasswordVerifier(password: string): { passwordHash: string; passwordSalt: string } {
  const passwordSalt = randomBytes(16).toString('base64url');
  const passwordHash = scryptSync(password, passwordSalt, 32).toString('base64url');
  return { passwordHash, passwordSalt };
}

function verifyRoomPassword(roomState: RoomState, password: unknown): boolean {
  if (!roomState.passwordHash || !roomState.passwordSalt) return true;
  if (typeof password !== 'string') return false;
  const sanitized = password.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (!sanitized || sanitized.length > MAX_ROOM_PASSWORD_LENGTH) return false;
  const actual = scryptSync(sanitized, roomState.passwordSalt, 32);
  const expected = Buffer.from(roomState.passwordHash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeJoinSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > MAX_JOIN_SESSION_ID_LENGTH) return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) return undefined;
  return normalized;
}

// Constant-time comparison to thwart timing attacks on the host token.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function getLiveStreamTokenSecret(): string | null {
  const secret = process.env.LIVE_STREAM_TOKEN_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== 'production') return 'development-live-stream-token-secret';
  return null;
}

function signLiveStreamToken(claims: LiveStreamTokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function pruneExpiredCoHostInviteTokens(roomState: RoomState, now = Date.now()) {
  for (const [token, invite] of roomState.coHostInviteTokens) {
    if (invite.expiresAt <= now) {
      roomState.coHostInviteTokens.delete(token);
    }
  }
}

function consumeCoHostInviteToken(roomState: RoomState, token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 120) return false;
  pruneExpiredCoHostInviteTokens(roomState);

  for (const [candidateToken] of roomState.coHostInviteTokens) {
    if (safeEqual(candidateToken, token)) {
      roomState.coHostInviteTokens.delete(candidateToken);
      return true;
    }
  }
  return false;
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeBrandingText(value: unknown, fallback: string, maxLength = MAX_BRANDING_TEXT_LENGTH): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLength) || fallback;
}

function normalizeBrandingColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BRANDING_COLOR;
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(color)) return color;
  if (/^#[\da-f]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  }
  return DEFAULT_BRANDING_COLOR;
}

function normalizeBrandingUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > MAX_BRANDING_URL_LENGTH || url.startsWith('blob:')) return null;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

function normalizeStageBackground(value: unknown): StageBackground {
  if (!isRecord(value) || !STAGE_BACKGROUND_TYPES.has(value.type as StageBackground['type'])) {
    return { type: 'none', value: '' };
  }
  const type = value.type as StageBackground['type'];
  const backgroundValue = typeof value.value === 'string'
    ? value.value.trim().slice(0, MAX_BRANDING_URL_LENGTH)
    : '';
  if (type === 'image') {
    const imageUrl = normalizeBrandingUrl(backgroundValue);
    return imageUrl ? { type: 'image', value: imageUrl } : { type: 'none', value: '' };
  }
  if (type === 'none') return { type: 'none', value: '' };
  return { type, value: backgroundValue };
}

function normalizeStudioBrandingPayload(payload: StudioBrandingPayload, updatedBy: string): StudioBrandingPayload {
  const waitingRoom: Record<string, unknown> = isRecord(payload.waitingRoom) ? payload.waitingRoom : {};
  return {
    brandColor: normalizeBrandingColor(payload.brandColor),
    logoUrl: normalizeBrandingUrl(payload.logoUrl),
    stageBackground: normalizeStageBackground(payload.stageBackground),
    waitingRoom: {
      headline: normalizeBrandingText(waitingRoom.headline, DEFAULT_WAITING_ROOM_HEADLINE, 80),
      message: normalizeBrandingText(waitingRoom.message, DEFAULT_WAITING_ROOM_MESSAGE),
      backgroundMode: waitingRoom.backgroundMode === 'studio' ? 'studio' : 'brand',
      showLogo: typeof waitingRoom.showLogo === 'boolean' ? waitingRoom.showLogo : true,
    },
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
}

// Fix #10: Validate incoming messages before processing
function validateMessage(data: unknown): data is SignalMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  if (!KNOWN_MESSAGE_TYPES.has(msg.type)) return false;
  if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null)) return false;
  return true;
}

export function setupSignalingServer(wss: WebSocketServer) {
  // Fix #3: Heartbeat ping/pong interval to detect dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const aliveWs = ws as AliveWebSocket;
      if (aliveWs.isAlive === false) {
        // Client did not respond to last ping within the interval — terminate
        aliveWs.terminate();
        return;
      }
      aliveWs.isAlive = false;
      aliveWs.ping();
    });
  }, 30_000);

  // Clean up interval on server close
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log('New WebSocket connection');

    // Fix #3: Mark connection as alive on connect and on pong
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.clientIp = getClientIpFromRequest(req);

    ws.on('pong', () => {
      (ws as AliveWebSocket).isAlive = true;
    });

    // Fix #1: Add error handler so unhandled socket errors don't crash the server
    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });

    ws.on('message', (data: Buffer) => {
      // Fix #2: Wrap entire message handling in try/catch
      try {
        // Rate limit WebSocket messages
        if (!checkWsRateLimit(ws)) {
          sendError(ws, 'Too many messages. Please slow down.', 'RATE_LIMITED');
          return;
        }

        const parsed = JSON.parse(data.toString());

        // Fix #10: Validate message structure before handling
        if (!validateMessage(parsed)) {
          sendError(ws, 'Invalid or unknown message type', 'INVALID_MESSAGE');
          return;
        }

        handleMessage(ws, parsed);
      } catch (err) {
        sendError(ws, 'Invalid message format', 'PARSE_ERROR');
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });
  });
}

function handleMessage(ws: WebSocket, message: SignalMessage) {
  switch (message.type) {
    case 'join-room':
      handleJoinRoom(ws, message.payload);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      relayToParticipant(ws, message);
      break;
    case 'media-state-changed':
      handleMediaStateChange(ws, message.payload);
      break;
    case 'chat-message':
      handleChatMessage(ws, message.payload);
      break;
    case 'chat-typing':
      handleChatTyping(ws, message.payload);
      break;
    case 'chat-reaction':
      handleChatReaction(ws, message.payload);
      break;
    case 'chat-star-update':
      handleChatStarUpdate(ws, message.payload);
      break;
    case 'chat-pin-update':
      handleChatPinUpdate(ws, message.payload);
      break;
    case 'qa-question-submitted':
      handleQAQuestionSubmitted(ws, message.payload);
      break;
    case 'qa-question-update':
      handleQAQuestionUpdate(ws, message.payload);
      break;
    case 'qa-question-upvote':
      handleQAQuestionUpvote(ws, message.payload);
      break;
    case 'poll-create':
      handlePollCreate(ws, message.payload);
      break;
    case 'poll-vote':
      handlePollVote(ws, message.payload);
      break;
    case 'poll-update':
      handlePollUpdate(ws, message.payload);
      break;
    case 'stage-action':
      handleStageAction(ws, message.payload);
      break;
    case 'studio-branding-updated':
      handleStudioBrandingUpdate(ws, message.payload);
      break;
    case 'recording-state-changed':
      handleRecordingStateChange(ws, message.payload);
      break;
    case 'live-stream-state-changed':
      handleLiveStreamStateChange(ws, message.payload);
      break;
    case 'live-stream-token-request':
      handleLiveStreamTokenRequest(ws, message.payload);
      break;
    case 'co-host-invite-token-request':
      handleCoHostInviteTokenRequest(ws, message.payload);
      break;
    case 'end-room':
      handleEndRoom(ws);
      break;
    default:
      sendError(ws, 'Unknown message type', 'UNKNOWN_TYPE');
  }
}

function handleJoinRoom(ws: WebSocket, payload: JoinRoomPayload) {
  // Duplicate join guard: prevent same WebSocket from joining twice
  if (wsToParticipant.has(ws)) {
    sendError(ws, 'Already in a room', 'ALREADY_JOINED');
    return;
  }

  // Validate payload field types
  if (typeof payload.roomId !== 'string' || typeof payload.name !== 'string') {
    sendError(ws, 'Invalid payload types', 'VALIDATION_ERROR');
    return;
  }

  const { roomId } = payload;
  const requestedRole: Participant['role'] =
    payload.role === 'host' || payload.role === 'co-host' ? payload.role : 'guest';
  const joinSessionId = normalizeJoinSessionId(payload.joinSessionId);
  // Sanitize and validate participant name
  const name = (typeof payload.name === 'string' ? payload.name : '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, MAX_PARTICIPANT_NAME_LENGTH) || 'Anonymous';
  const roomState = rooms.get(roomId);

  if (!roomState) {
    sendError(ws, 'Room not found', 'ROOM_NOT_FOUND');
    return;
  }

  // Host role requires the secret token returned at room creation. If the token
  // is valid, allow the creator to reclaim the host seat from a stale tab/socket.
  let effectiveRole: Participant['role'] = requestedRole === 'host' ? 'host' : 'guest';
  if (requestedRole === 'host') {
    const presented = typeof payload.hostToken === 'string' ? payload.hostToken : '';
    if (!presented || !safeEqual(presented, roomState.hostToken)) {
      if (!presented && canUseCreatorNetworkHostFallback(ws, roomState)) {
        console.warn(`Room ${roomId} accepted first host from creator network without a host token`);
      } else {
        sendError(ws, 'Host access is missing or expired. Reopen this studio from the creator browser or saved host entry.', 'HOST_TOKEN_INVALID');
        return;
      }
    } else {
      const existingHostId = roomState.room.hostId;
      const hostStillConnected =
        existingHostId !== '' && roomState.participants.has(existingHostId);
      if (hostStillConnected) {
        replaceExistingHostSession(roomId, roomState, existingHostId);
      }
    }
  }

  if (roomState.participants.size >= roomState.room.settings.maxParticipants) {
    sendError(ws, 'Room is full (max 7 participants)', 'ROOM_FULL');
    return;
  }

  if (
    requestedRole !== 'host' &&
    joinSessionId &&
    roomState.bannedJoinSessionIds.has(joinSessionId)
  ) {
    sendError(ws, 'You have been banned from this studio.', 'PARTICIPANT_BANNED');
    return;
  }

  if (requestedRole === 'co-host') {
    if (consumeCoHostInviteToken(roomState, payload.coHostInviteToken)) {
      effectiveRole = 'co-host';
    } else {
      sendError(ws, 'Co-host invite link is invalid or expired', 'CO_HOST_INVITE_INVALID');
      return;
    }
  }

  if (
    effectiveRole === 'guest' &&
    isScheduledGuestAccessBlocked(roomState.room.scheduledFor)
  ) {
    sendError(ws, SCHEDULED_GUEST_ACCESS_MESSAGE, ROOM_NOT_OPEN_ERROR_CODE);
    return;
  }

  if (roomState.room.settings.passwordProtected && effectiveRole === 'guest') {
    if (typeof payload.roomPassword !== 'string' || payload.roomPassword.trim().length === 0) {
      sendError(ws, 'This room requires a password', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    if (!verifyRoomPassword(roomState, payload.roomPassword)) {
      sendError(ws, 'Incorrect room password', 'ROOM_PASSWORD_INVALID');
      return;
    }
  }

  // Transition scheduled rooms to 'waiting' only after the join is authorized.
  if (roomState.room.status === 'scheduled') {
    roomState.room.status = 'waiting';
  }

  const participant: Participant = {
    id: nanoid(8),
    name,
    role: effectiveRole,
    audioEnabled: true,
    videoEnabled: true,
    screenSharing: false,
    joinedAt: new Date().toISOString(),
    status: 'green-room',
  };

  // Host and server-issued co-host invites go directly on-stage.
  if (effectiveRole === 'host') {
    roomState.room.hostId = participant.id;
    participant.status = 'on-stage';
  } else if (effectiveRole === 'co-host') {
    roomState.room.coHostIds.push(participant.id);
    participant.status = 'on-stage';
  } else {
    // Guests: if green room is enabled, they wait; otherwise auto-admit
    if (roomState.room.settings.greenRoomEnabled) {
      participant.status = 'green-room';
    } else {
      participant.status = 'on-stage';
    }
  }

  cancelEmptyRoomDeletion(roomId, roomState);

  // Store participant
  roomState.participants.set(participant.id, { participant, ws, joinSessionId });
  wsToParticipant.set(ws, { roomId, participantId: participant.id });
  roomState.hasBeenJoined = true;

  // Send room-joined to the new participant (include ALL participants for awareness)
  const allParticipants = Array.from(roomState.participants.values())
    .map((p) => p.participant)
    .filter((p) => p.id !== participant.id);
  const chatMessages = getVisibleChatMessages(roomState, participant, participant.id);
  const qaQuestions = Array.from(roomState.qaQuestions.values())
    .filter((q) => effectiveRole === 'host' || effectiveRole === 'co-host' || q.status === 'approved' || q.status === 'answered');
  const polls = Array.from(roomState.polls.values())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const liveStreamState: LiveStreamStatePayload | undefined = roomState.liveStreamStartedAt
    ? {
        live: true,
        startedAt: roomState.liveStreamStartedAt,
        performedBy: roomState.liveStreamStartedBy || roomState.room.hostId,
      }
    : undefined;

  send(ws, {
    type: 'room-joined',
    payload: {
      room: roomState.room,
      participant,
      participants: allParticipants,
      chatMessages,
      qaQuestions,
      polls,
      recordingState: roomState.recordingStartedAt
        ? {
            recording: true,
            startedAt: roomState.recordingStartedAt,
            performedBy: roomState.room.hostId,
          }
        : undefined,
      liveStreamState,
      studioBranding: roomState.studioBranding,
      features: {
        chatTyping: true,
      },
    },
  });

  // Notify existing participants about the new one
  broadcastToRoom(roomId, {
    type: 'participant-joined',
    payload: participant,
  }, participant.id);

  console.log(`${name} (${effectiveRole}) joined room ${roomId} as ${participant.status} [${roomState.participants.size}/7 participants]`);
}

function handleStageAction(ws: WebSocket, payload: StageActionPayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  // Only host and co-hosts can perform stage actions
  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can manage the stage', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before managing the stage', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (
    typeof payload.targetParticipantId !== 'string' ||
    !STAGE_ACTIONS.has(payload.action)
  ) {
    sendError(ws, 'Invalid stage action', 'VALIDATION_ERROR');
    return;
  }

  const authoritativePayload: StageActionPayload = {
    ...payload,
    performedBy: mapping.participantId,
  };

  const target = roomState.participants.get(payload.targetParticipantId);
  if (!target) return;

  // Fix #7: Prevent demoting or removing the host
  if (target.participant.id === roomState.room.hostId) {
    if (
      payload.action === 'demote-to-guest' ||
      payload.action === 'remove' ||
      payload.action === 'ban' ||
      payload.action === 'move-to-backstage' ||
      payload.action === 'move-to-green-room' ||
      payload.action === 'notify-next'
    ) {
      sendError(ws, 'Cannot perform this action on the host', 'HOST_PROTECTED');
      return;
    }
  }

  if (payload.action === 'notify-next') {
    if (target.participant.status !== 'green-room' && target.participant.status !== 'backstage') {
      sendError(ws, 'Only off-stage participants can be notified', 'VALIDATION_ERROR');
      return;
    }

    send(target.ws, {
      type: 'participant-notification',
      payload: {
        id: nanoid(8),
        targetParticipantId: target.participant.id,
        title: target.participant.status === 'backstage' ? "You're on deck" : "You're next",
        message: target.participant.status === 'backstage'
          ? 'The host is getting ready to bring you back to the live stage.'
          : 'The host is getting ready to bring you into the live studio.',
        tone: 'success',
        issuedAt: new Date().toISOString(),
        issuedBy: mapping.participantId,
      },
    });

    broadcastToRoom(mapping.roomId, {
      type: 'stage-action',
      payload: authoritativePayload,
    });
    console.log(`Stage action: notify-next sent to ${target.participant.name} by ${performer.participant.name}`);
    return;
  }

  switch (payload.action) {
    case 'move-to-stage':
      target.participant.status = 'on-stage';
      break;
    case 'move-to-backstage':
      target.participant.status = 'backstage';
      target.participant.screenSharing = false;
      break;
    case 'move-to-green-room':
      target.participant.status = 'green-room';
      target.participant.screenSharing = false;
      break;
    case 'promote-co-host':
      target.participant.role = 'co-host';
      if (!roomState.room.coHostIds.includes(target.participant.id)) {
        roomState.room.coHostIds.push(target.participant.id);
      }
      break;
    case 'demote-to-guest':
      target.participant.role = 'guest';
      roomState.room.coHostIds = roomState.room.coHostIds.filter(
        (id) => id !== target.participant.id
      );
      break;
    case 'mute':
      target.participant.audioEnabled = false;
      send(target.ws, {
        type: 'participant-notification',
        payload: {
          id: nanoid(8),
          targetParticipantId: target.participant.id,
          title: 'Microphone muted',
          message: `${performer.participant.name} muted your microphone.`,
          tone: 'warning',
          issuedAt: new Date().toISOString(),
          issuedBy: mapping.participantId,
        },
      });
      break;
    case 'unmute':
      send(target.ws, {
        type: 'participant-notification',
        payload: {
          id: nanoid(8),
          targetParticipantId: target.participant.id,
          title: 'Unmute requested',
          message: `${performer.participant.name} asked you to turn your microphone on.`,
          tone: 'info',
          issuedAt: new Date().toISOString(),
          issuedBy: mapping.participantId,
        },
      });
      broadcastToRoom(mapping.roomId, {
        type: 'stage-action',
        payload: authoritativePayload,
      });
      console.log(`Stage action: unmute requested for ${target.participant.name} by ${performer.participant.name}`);
      return;
    case 'remove':
      send(target.ws, {
        type: 'participant-removed',
        payload: { reason: 'Removed by host' },
      });
      // Close the target's WebSocket to trigger disconnect
      target.ws.close(1000, 'Removed by host');
      return;
    case 'ban':
      if (target.joinSessionId) {
        roomState.bannedJoinSessionIds.add(target.joinSessionId);
      }
      send(target.ws, {
        type: 'participant-removed',
        payload: { reason: 'Banned by host' },
      });
      // Close the target's WebSocket to trigger disconnect
      target.ws.close(1000, 'Banned by host');
      return;
  }

  // Broadcast the updated participant to everyone
  broadcastToRoom(mapping.roomId, {
    type: 'participant-updated',
    payload: target.participant,
  });

  // Also broadcast the stage action for UI feedback
  broadcastToRoom(mapping.roomId, {
    type: 'stage-action',
    payload: authoritativePayload,
  });

  console.log(`Stage action: ${payload.action} on ${target.participant.name} by ${performer.participant.name}`);
}

function handleStudioBrandingUpdate(ws: WebSocket, payload: StudioBrandingPayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can update studio branding', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before updating studio branding', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  const branding = normalizeStudioBrandingPayload(payload, mapping.participantId);
  roomState.studioBranding = branding;
  broadcastToRoom(mapping.roomId, {
    type: 'studio-branding-updated',
    payload: branding,
  });
}

function handleRecordingStateChange(ws: WebSocket, payload: RecordingStatePayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can change recording state', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before changing recording state', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.recording !== 'boolean') {
    sendError(ws, 'Invalid recording state', 'VALIDATION_ERROR');
    return;
  }

  const now = new Date().toISOString();
  const authoritativePayload: RecordingStatePayload = {
    recording: payload.recording,
    performedBy: mapping.participantId,
    ...(payload.recording ? { startedAt: now } : { stoppedAt: now }),
  };

  if (payload.recording) {
    roomState.recordingStartedAt = now;
  } else {
    roomState.recordingStartedAt = undefined;
  }
  updateRoomActivityStatus(roomState);

  broadcastToRoom(mapping.roomId, {
    type: 'recording-state-changed',
    payload: authoritativePayload,
  });
}

function handleLiveStreamStateChange(ws: WebSocket, payload: LiveStreamStatePayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can change live stream state', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before changing live stream state', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.live !== 'boolean') {
    sendError(ws, 'Invalid live stream state', 'VALIDATION_ERROR');
    return;
  }

  const now = new Date().toISOString();
  const startedAt = payload.live ? roomState.liveStreamStartedAt || now : undefined;
  const authoritativePayload: LiveStreamStatePayload = {
    live: payload.live,
    performedBy: mapping.participantId,
    ...(payload.live ? { startedAt } : { stoppedAt: now }),
  };

  if (payload.live) {
    roomState.liveStreamStartedAt = startedAt;
    roomState.liveStreamStartedBy = mapping.participantId;
  } else {
    roomState.liveStreamStartedAt = undefined;
    roomState.liveStreamStartedBy = undefined;
  }
  updateRoomActivityStatus(roomState);

  broadcastToRoom(mapping.roomId, {
    type: 'live-stream-state-changed',
    payload: authoritativePayload,
  });
}

function handleLiveStreamTokenRequest(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'live-stream-token-request' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  if (!isValidRequestId(payload.requestId)) {
    sendError(ws, 'Invalid live stream token request', 'VALIDATION_ERROR');
    return;
  }

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can start a live stream', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before starting a live stream', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    sendError(ws, 'Live streaming is not configured on this server', 'LIVE_STREAM_NOT_CONFIGURED');
    return;
  }

  const expiresAtMs = Date.now() + LIVE_STREAM_TOKEN_TTL_MS;
  const claims: LiveStreamTokenClaims = {
    v: 1,
    roomId: mapping.roomId,
    participantId: mapping.participantId,
    role: performer.participant.role,
    exp: expiresAtMs,
    nonce: nanoid(16),
  };

  send(ws, {
    type: 'live-stream-token-issued',
    payload: {
      requestId: payload.requestId,
      token: signLiveStreamToken(claims, secret),
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  });
}

function handleCoHostInviteTokenRequest(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'co-host-invite-token-request' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  if (!isValidRequestId(payload.requestId)) {
    sendError(ws, 'Invalid co-host invite request', 'VALIDATION_ERROR');
    return;
  }

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can create co-host invites', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before creating co-host invites', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  const now = Date.now();
  pruneExpiredCoHostInviteTokens(roomState, now);

  while (roomState.coHostInviteTokens.size >= MAX_CO_HOST_INVITE_TOKENS_PER_ROOM) {
    const oldestToken = roomState.coHostInviteTokens.keys().next().value;
    if (!oldestToken) break;
    roomState.coHostInviteTokens.delete(oldestToken);
  }

  const token = nanoid(32);
  const expiresAtMs = now + CO_HOST_INVITE_TOKEN_TTL_MS;
  roomState.coHostInviteTokens.set(token, {
    expiresAt: expiresAtMs,
    issuedBy: mapping.participantId,
    createdAt: now,
  });

  send(ws, {
    type: 'co-host-invite-token-issued',
    payload: {
      requestId: payload.requestId,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  });
}

function isValidSdpPayload(payload: unknown): payload is { to: string; sdp: { type: string; sdp: string } } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.to !== 'string') return false;
  if (!p.sdp || typeof p.sdp !== 'object') return false;
  const sdp = p.sdp as Record<string, unknown>;
  // RTCSessionDescriptionInit requires .type ('offer' | 'answer' | 'pranswer' | 'rollback'); .sdp is optional only for rollback.
  if (typeof sdp.type !== 'string') return false;
  if (!['offer', 'answer', 'pranswer', 'rollback'].includes(sdp.type)) return false;
  if (sdp.sdp !== undefined && typeof sdp.sdp !== 'string') return false;
  return true;
}

function isValidIcePayload(payload: unknown): payload is { to: string; candidate: Record<string, unknown> } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.to !== 'string') return false;
  // candidate may be null (end-of-candidates) or an object with .candidate/.sdpMid/.sdpMLineIndex
  if (p.candidate === null) return true;
  if (!p.candidate || typeof p.candidate !== 'object') return false;
  const c = p.candidate as Record<string, unknown>;
  if (c.candidate !== undefined && typeof c.candidate !== 'string') return false;
  if (c.sdpMid !== undefined && c.sdpMid !== null && typeof c.sdpMid !== 'string') return false;
  if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null && typeof c.sdpMLineIndex !== 'number') return false;
  return true;
}

function canRelayMediaSignal(roomState: RoomState, fromId: string, toId: string): boolean {
  const sender = roomState.participants.get(fromId)?.participant;
  const target = roomState.participants.get(toId)?.participant;
  if (!sender || !target) return false;

  // Green-room participants stay isolated. Backstage media is private to
  // operators and backstage guests; non-operator stage guests cannot receive it.
  return canExchangeStudioMedia(sender, target);
}

function relayToParticipant(ws: WebSocket, message: RelaySignalMessage) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  if (message.type === 'ice-candidate') {
    if (!isValidIcePayload(message.payload)) {
      sendError(ws, 'Invalid ICE payload', 'VALIDATION_ERROR');
      return;
    }
  } else {
    if (!isValidSdpPayload(message.payload)) {
      sendError(ws, 'Invalid SDP payload', 'VALIDATION_ERROR');
      return;
    }
  }

  if (message.payload.to === mapping.participantId) {
    sendError(ws, 'Cannot relay a signal to yourself', 'VALIDATION_ERROR');
    return;
  }

  if (!canRelayMediaSignal(roomState, mapping.participantId, message.payload.to)) {
    // Drop unauthorized media signals silently. A legitimate client may still
    // have in-flight ICE/SDP while a participant is moved off stage.
    return;
  }

  const target = roomState.participants.get(message.payload.to);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    send(target.ws, {
      ...message,
      payload: {
        ...message.payload,
        from: mapping.participantId,
      },
    } as RelaySignalMessage);
  }
}

function handleMediaStateChange(ws: WebSocket, payload: MediaStatePayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  if (
    typeof payload.audioEnabled !== 'boolean' ||
    typeof payload.videoEnabled !== 'boolean' ||
    typeof payload.screenSharing !== 'boolean'
  ) {
    sendError(ws, 'Invalid media state', 'VALIDATION_ERROR');
    return;
  }

  const entry = roomState.participants.get(mapping.participantId);
  const screenSharing = entry?.participant.status === 'on-stage' ? payload.screenSharing : false;
  if (entry) {
    entry.participant.audioEnabled = payload.audioEnabled;
    entry.participant.videoEnabled = payload.videoEnabled;
    entry.participant.screenSharing = screenSharing;
  }

  const authoritativePayload: MediaStatePayload = {
    participantId: mapping.participantId,
    audioEnabled: payload.audioEnabled,
    videoEnabled: payload.videoEnabled,
    screenSharing,
  };

  broadcastToRoom(mapping.roomId, {
    type: 'media-state-changed',
    payload: authoritativePayload,
  }, mapping.participantId);
}

function canSeeChatMessage(message: ChatMessage, participant: Participant, participantId: string): boolean {
  if (message.recipientId) {
    return participantId === message.senderId || participantId === message.recipientId;
  }
  if (!message.isBackstage) return true;
  return (
    participant.role === 'host' ||
    participant.role === 'co-host' ||
    participant.status === 'backstage' ||
    participantId === message.senderId
  );
}

function getVisibleChatMessages(roomState: RoomState, participant: Participant, participantId: string): ChatMessage[] {
  return Array.from(roomState.chatMessages.values())
    .filter((message) => canSeeChatMessage(message, participant, participantId));
}

function getChatReactionCounts(reactions: Map<ChatReactionType, Set<string>> | undefined): ChatMessage['reactions'] {
  if (!reactions) return undefined;
  const counts: ChatMessage['reactions'] = {};
  for (const [reaction, participantIds] of reactions) {
    if (participantIds.size > 0) {
      counts[reaction] = participantIds.size;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function refreshStoredChatReactionCounts(roomState: RoomState, message: ChatMessage): ChatMessage {
  const reactions = getChatReactionCounts(roomState.chatReactions.get(message.id));
  const updated: ChatMessage = { ...message };
  if (reactions) {
    updated.reactions = reactions;
  } else {
    delete updated.reactions;
  }
  roomState.chatMessages.set(updated.id, updated);
  return updated;
}

function storeChatMessage(roomState: RoomState, message: ChatMessage) {
  roomState.chatMessages.set(message.id, message);
  while (roomState.chatMessages.size > MAX_CHAT_HISTORY_PER_ROOM) {
    const oldestId = roomState.chatMessages.keys().next().value;
    if (oldestId === undefined) break;
    roomState.chatMessages.delete(oldestId);
    roomState.chatReactions.delete(oldestId);
  }
}

function sendChatToVisibleParticipants(roomId: string, roomState: RoomState, message: ChatMessage, type: 'chat-message' | 'chat-message-updated') {
  for (const [participantId, { participant, ws }] of roomState.participants) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!canSeeChatMessage(message, participant, participantId)) continue;
    send(ws, { type, payload: message });
  }
}

function sendChatReactionToVisibleParticipants(
  roomId: string,
  roomState: RoomState,
  message: ChatMessage,
  payload: Extract<SignalMessage, { type: 'chat-reaction' }>['payload']
) {
  for (const [participantId, { participant, ws }] of roomState.participants) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!canSeeChatMessage(message, participant, participantId)) continue;
    send(ws, { type: 'chat-reaction', payload });
  }
}

function sendChatTypingToVisibleParticipants(roomState: RoomState, payload: ChatTypingPayload) {
  const visibilityProbe: ChatMessage = {
    id: '__typing__',
    senderId: payload.participantId,
    senderName: payload.participantName,
    content: '',
    timestamp: payload.timestamp,
    isBackstage: payload.isBackstage,
    ...(payload.recipientId
      ? {
          recipientId: payload.recipientId,
          recipientName: payload.recipientName,
        }
      : {}),
  };

  for (const [participantId, { participant, ws }] of roomState.participants) {
    if (participantId === payload.participantId) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!canSeeChatMessage(visibilityProbe, participant, participantId)) continue;
    send(ws, { type: 'chat-typing', payload });
  }
}

function handleChatTyping(ws: WebSocket, payload: ChatTypingPayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  if (typeof payload.typing !== 'boolean') {
    sendError(ws, 'Invalid chat typing state', 'VALIDATION_ERROR');
    return;
  }

  const senderEntry = roomState.participants.get(mapping.participantId);
  if (!senderEntry) return;
  if (senderEntry.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before sending studio chat updates', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  const requestedRecipientId = typeof payload.recipientId === 'string' ? payload.recipientId.trim() : '';
  const recipientEntry = requestedRecipientId ? roomState.participants.get(requestedRecipientId) : undefined;
  if (requestedRecipientId) {
    if (!recipientEntry || requestedRecipientId === mapping.participantId) {
      sendError(ws, 'Invalid private message recipient', 'VALIDATION_ERROR');
      return;
    }

    const senderIsOperator = senderEntry.participant.role === 'host' || senderEntry.participant.role === 'co-host';
    const recipientIsOperator = recipientEntry.participant.role === 'host' || recipientEntry.participant.role === 'co-host';
    if (!senderIsOperator && !recipientIsOperator) {
      sendError(ws, 'Private messages must include a host or co-host', 'UNAUTHORIZED');
      return;
    }
  }

  const isBackstageTyping = requestedRecipientId ? false : payload.isBackstage === true;
  const canSendBackstageTyping = (
    senderEntry.participant.role === 'host' ||
    senderEntry.participant.role === 'co-host' ||
    senderEntry.participant.status === 'backstage'
  );
  if (isBackstageTyping && !canSendBackstageTyping) {
    sendError(ws, 'Only hosts, co-hosts, and backstage participants can send backstage chat updates', 'UNAUTHORIZED');
    return;
  }

  const authoritativePayload: ChatTypingPayload = {
    participantId: mapping.participantId,
    participantName: senderEntry.participant.name,
    typing: payload.typing,
    timestamp: new Date().toISOString(),
    isBackstage: isBackstageTyping,
    ...(recipientEntry
      ? {
          recipientId: recipientEntry.participant.id,
          recipientName: recipientEntry.participant.name,
        }
      : {}),
  };

  sendChatTypingToVisibleParticipants(roomState, authoritativePayload);
}

function handleChatMessage(ws: WebSocket, payload: ChatMessage) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  // Validate chat message content
  if (typeof payload.content !== 'string' || payload.content.trim().length === 0) return;
  if (payload.content.length > MAX_CHAT_MESSAGE_LENGTH) {
    sendError(ws, `Message too long (max ${MAX_CHAT_MESSAGE_LENGTH} characters)`, 'MESSAGE_TOO_LONG');
    return;
  }

  // Fix #8: Override senderId and senderName with server-authoritative values
  const senderEntry = roomState.participants.get(mapping.participantId);
  if (!senderEntry) return;
  if (senderEntry.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before sending studio chat messages', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }
  const isBackstageMessage = payload.isBackstage === true;
  const canSendBackstageMessage = (
    senderEntry.participant.role === 'host' ||
    senderEntry.participant.role === 'co-host' ||
    senderEntry.participant.status === 'backstage'
  );
  if (isBackstageMessage && !canSendBackstageMessage) {
    sendError(ws, 'Only hosts, co-hosts, and backstage participants can send backstage chat messages', 'UNAUTHORIZED');
    return;
  }

  const sanitizedContent = payload.content.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (sanitizedContent.length === 0) return;

  const requestedRecipientId = typeof payload.recipientId === 'string' ? payload.recipientId.trim() : '';
  const recipientEntry = requestedRecipientId ? roomState.participants.get(requestedRecipientId) : undefined;
  if (requestedRecipientId) {
    if (!recipientEntry || requestedRecipientId === mapping.participantId) {
      sendError(ws, 'Invalid private message recipient', 'VALIDATION_ERROR');
      return;
    }

    const senderIsOperator = senderEntry.participant.role === 'host' || senderEntry.participant.role === 'co-host';
    const recipientIsOperator = recipientEntry.participant.role === 'host' || recipientEntry.participant.role === 'co-host';
    if (!senderIsOperator && !recipientIsOperator) {
      sendError(ws, 'Private messages must include a host or co-host', 'UNAUTHORIZED');
      return;
    }
  }

  const sanitizedPayload: ChatMessage = {
    id: nanoid(10),
    clientId: typeof payload.id === 'string' ? payload.id : undefined,
    content: sanitizedContent,
    senderId: mapping.participantId,
    senderName: senderEntry.participant.name,
    timestamp: new Date().toISOString(),
    isBackstage: requestedRecipientId ? false : isBackstageMessage,
    ...(recipientEntry
      ? {
          recipientId: recipientEntry.participant.id,
          recipientName: recipientEntry.participant.name,
        }
      : {}),
  };

  storeChatMessage(roomState, sanitizedPayload);
  sendChatToVisibleParticipants(mapping.roomId, roomState, sanitizedPayload, 'chat-message');

  if (!sanitizedPayload.isBackstage && !sanitizedPayload.recipientId) {
    handleQAQuestionCommand(ws, mapping, roomState, senderEntry.participant, sanitizedContent);
    handlePollVoteCommand(ws, mapping, roomState, sanitizedContent);
  }
}

function parseQAQuestionCommand(content: string): string | null {
  const match = content.trim().match(QA_QUESTION_COMMAND);
  if (!match) return null;
  return match[1].trim();
}

function submitQAQuestion(
  ws: WebSocket,
  mapping: { roomId: string; participantId: string },
  roomState: RoomState,
  author: Participant,
  rawContent: string,
  requestedQuestionId?: string
): QAQuestion | null {
  const content = rawContent.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!content) return null;
  if (content.length > MAX_QA_QUESTION_LENGTH) {
    sendError(ws, `Question too long (max ${MAX_QA_QUESTION_LENGTH} characters)`, 'QUESTION_TOO_LONG');
    return null;
  }

  const requestedId = requestedQuestionId && /^[\w-]{1,80}$/.test(requestedQuestionId)
    ? requestedQuestionId
    : nanoid(10);
  const id = roomState.qaQuestions.has(requestedId) ? nanoid(10) : requestedId;

  const question: QAQuestion = {
    id,
    authorId: mapping.participantId,
    authorName: author.name,
    content,
    timestamp: new Date().toISOString(),
    upvotes: 0,
    status: 'pending',
    highlighted: false,
  };

  roomState.qaQuestions.set(question.id, question);
  roomState.qaVotes.set(question.id, new Set());
  broadcastQAQuestion(mapping.roomId, question);
  return question;
}

function handleQAQuestionCommand(
  ws: WebSocket,
  mapping: { roomId: string; participantId: string },
  roomState: RoomState,
  author: Participant,
  content: string
) {
  const question = parseQAQuestionCommand(content);
  if (!question) return;
  submitQAQuestion(ws, mapping, roomState, author, question);
}

function parsePollVoteCommand(content: string): number | null {
  const match = content.trim().match(POLL_VOTE_COMMAND);
  if (!match) return null;

  const token = match[1].toLowerCase();
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= MAX_POLL_OPTIONS) {
    return numeric - 1;
  }

  const letterIndex = POLL_VOTE_OPTION_LETTERS.indexOf(token);
  return letterIndex >= 0 ? letterIndex : null;
}

function getActivePollForChatVote(roomState: RoomState): LivePoll | undefined {
  const openPolls = Array.from(roomState.polls.values()).filter((poll) => poll.status === 'open');
  if (openPolls.length === 0) return undefined;

  const highlighted = openPolls.find((poll) => poll.highlighted);
  if (highlighted) return highlighted;

  return openPolls.sort((a, b) => {
    const bTime = Date.parse(b.createdAt);
    const aTime = Date.parse(a.createdAt);
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0];
}

function applyPollVote(roomState: RoomState, participantId: string, poll: LivePoll, optionId: string): LivePoll | null {
  if (poll.status !== 'open') return null;
  if (!poll.options.some((option) => option.id === optionId)) return null;

  const votes = roomState.pollVotes.get(poll.id) || new Map<string, string>();
  votes.set(participantId, optionId);
  roomState.pollVotes.set(poll.id, votes);

  const totals = new Map<string, number>();
  for (const selectedOptionId of votes.values()) {
    totals.set(selectedOptionId, (totals.get(selectedOptionId) || 0) + 1);
  }

  const updated: LivePoll = {
    ...poll,
    options: poll.options.map((option) => ({
      ...option,
      votes: totals.get(option.id) || 0,
    })),
    totalVotes: votes.size,
  };

  roomState.polls.set(updated.id, updated);
  return updated;
}

function handlePollVoteCommand(
  ws: WebSocket,
  mapping: { roomId: string; participantId: string },
  roomState: RoomState,
  content: string
) {
  const optionIndex = parsePollVoteCommand(content);
  if (optionIndex === null) return;

  const poll = getActivePollForChatVote(roomState);
  if (!poll) {
    sendError(ws, 'No open poll is accepting chat votes', 'POLL_NOT_OPEN');
    return;
  }

  const option = poll.options[optionIndex];
  if (!option) {
    sendError(ws, 'Poll option is not available', 'VALIDATION_ERROR');
    return;
  }

  const updated = applyPollVote(roomState, mapping.participantId, poll, option.id);
  if (updated) {
    broadcastPoll(mapping.roomId, updated);
  }
}

function handleChatReaction(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'chat-reaction' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const participantEntry = roomState.participants.get(mapping.participantId);
  if (!participantEntry) return;
  if (participantEntry.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before reacting to chat messages', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.messageId !== 'string' || !isChatReactionType(payload.reaction)) {
    sendError(ws, 'Invalid chat reaction', 'VALIDATION_ERROR');
    return;
  }

  const message = roomState.chatMessages.get(payload.messageId);
  if (!message || !canSeeChatMessage(message, participantEntry.participant, mapping.participantId)) return;

  const reactions = roomState.chatReactions.get(message.id) || new Map<ChatReactionType, Set<string>>();
  const participantIds = reactions.get(payload.reaction) || new Set<string>();
  let addedReaction = false;
  if (participantIds.has(mapping.participantId)) {
    participantIds.delete(mapping.participantId);
  } else {
    participantIds.add(mapping.participantId);
    addedReaction = true;
  }

  if (participantIds.size > 0) {
    reactions.set(payload.reaction, participantIds);
  } else {
    reactions.delete(payload.reaction);
  }
  if (reactions.size > 0) {
    roomState.chatReactions.set(message.id, reactions);
  } else {
    roomState.chatReactions.delete(message.id);
  }

  const updated = refreshStoredChatReactionCounts(roomState, message);
  sendChatToVisibleParticipants(mapping.roomId, roomState, updated, 'chat-message-updated');
  if (addedReaction && !message.isBackstage && !message.recipientId) {
    sendChatReactionToVisibleParticipants(mapping.roomId, roomState, updated, {
      messageId: updated.id,
      reaction: payload.reaction,
    });
  }
}

function handleChatStarUpdate(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'chat-star-update' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can star chat messages', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before starring chat messages', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.messageId !== 'string' || typeof payload.starred !== 'boolean') {
    sendError(ws, 'Invalid chat star update', 'VALIDATION_ERROR');
    return;
  }

  const message = roomState.chatMessages.get(payload.messageId);
  if (!message || !canSeeChatMessage(message, performer.participant, mapping.participantId)) return;
  if (message.recipientId) {
    sendError(ws, 'Private messages cannot be starred for broadcast', 'VALIDATION_ERROR');
    return;
  }
  if (message.isBackstage) {
    sendError(ws, 'Backstage messages cannot be starred for broadcast', 'VALIDATION_ERROR');
    return;
  }

  const updated: ChatMessage = {
    ...message,
    starred: payload.starred,
    starredBy: payload.starred ? mapping.participantId : undefined,
    starredAt: payload.starred ? new Date().toISOString() : undefined,
  };
  if (!payload.starred) {
    delete updated.starred;
    delete updated.starredBy;
    delete updated.starredAt;
  }

  roomState.chatMessages.set(updated.id, updated);
  const refreshed = refreshStoredChatReactionCounts(roomState, updated);
  sendChatToVisibleParticipants(mapping.roomId, roomState, refreshed, 'chat-message-updated');
}

function handleChatPinUpdate(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'chat-pin-update' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can pin chat messages', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before pinning chat messages', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.messageId !== 'string' || typeof payload.pinned !== 'boolean') {
    sendError(ws, 'Invalid chat pin update', 'VALIDATION_ERROR');
    return;
  }

  const message = roomState.chatMessages.get(payload.messageId);
  if (!message || !canSeeChatMessage(message, performer.participant, mapping.participantId)) return;
  if (message.recipientId) {
    sendError(ws, 'Private messages cannot be pinned for broadcast', 'VALIDATION_ERROR');
    return;
  }
  if (message.isBackstage) {
    sendError(ws, 'Backstage messages cannot be pinned for broadcast', 'VALIDATION_ERROR');
    return;
  }

  const updated: ChatMessage = {
    ...message,
    pinned: payload.pinned,
    pinnedBy: payload.pinned ? mapping.participantId : undefined,
    pinnedAt: payload.pinned ? new Date().toISOString() : undefined,
  };
  if (!payload.pinned) {
    delete updated.pinned;
    delete updated.pinnedBy;
    delete updated.pinnedAt;
  }

  roomState.chatMessages.set(updated.id, updated);
  const refreshed = refreshStoredChatReactionCounts(roomState, updated);
  sendChatToVisibleParticipants(mapping.roomId, roomState, refreshed, 'chat-message-updated');
}

function handleQAQuestionSubmitted(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'qa-question-submitted' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const senderEntry = roomState.participants.get(mapping.participantId);
  if (!senderEntry) return;
  if (senderEntry.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before submitting Q&A', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.content !== 'string') {
    sendError(ws, 'Question content is required', 'VALIDATION_ERROR');
    return;
  }

  submitQAQuestion(
    ws,
    mapping,
    roomState,
    senderEntry.participant,
    payload.content,
    typeof payload.id === 'string' ? payload.id : undefined
  );
}

function handleQAQuestionUpdate(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'qa-question-update' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can manage Q&A', 'UNAUTHORIZED');
    return;
  }

  if (typeof payload.questionId !== 'string') {
    sendError(ws, 'Invalid question id', 'VALIDATION_ERROR');
    return;
  }

  const existing = roomState.qaQuestions.get(payload.questionId);
  if (!existing) return;

  const updates = payload.updates || {};
  const changedQuestions: QAQuestion[] = [];

  if (updates.highlighted === true) {
    for (const [id, question] of roomState.qaQuestions) {
      if (id !== existing.id && question.highlighted) {
        const unhighlighted = { ...question, highlighted: false };
        roomState.qaQuestions.set(id, unhighlighted);
        changedQuestions.push(unhighlighted);
      }
    }
  }

  const next: QAQuestion = { ...existing };

  if (updates.status) {
    if (!['pending', 'approved', 'answered', 'dismissed'].includes(updates.status)) {
      sendError(ws, 'Invalid Q&A status', 'VALIDATION_ERROR');
      return;
    }
    next.status = updates.status;
    if (updates.status === 'dismissed') next.highlighted = false;
  }

  if (typeof updates.answer === 'string') {
    const answer = updates.answer.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (answer.length > MAX_QA_ANSWER_LENGTH) {
      sendError(ws, `Answer too long (max ${MAX_QA_ANSWER_LENGTH} characters)`, 'ANSWER_TOO_LONG');
      return;
    }
    if (answer) {
      next.answer = answer;
      next.status = 'answered';
    }
  }

  if (typeof updates.highlighted === 'boolean') {
    next.highlighted = updates.highlighted && next.status !== 'dismissed';
  }

  roomState.qaQuestions.set(next.id, next);
  changedQuestions.push(next);

  for (const question of changedQuestions) {
    broadcastQAQuestion(mapping.roomId, question);
  }
}

function handleQAQuestionUpvote(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'qa-question-upvote' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;
  const participant = roomState.participants.get(mapping.participantId)?.participant;
  if (participant?.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before voting in Q&A', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.questionId !== 'string') {
    sendError(ws, 'Invalid question id', 'VALIDATION_ERROR');
    return;
  }

  const question = roomState.qaQuestions.get(payload.questionId);
  if (!question || (question.status !== 'approved' && question.status !== 'answered')) return;

  const votes = roomState.qaVotes.get(question.id) || new Set<string>();
  if (votes.has(mapping.participantId)) {
    votes.delete(mapping.participantId);
  } else {
    votes.add(mapping.participantId);
  }
  roomState.qaVotes.set(question.id, votes);

  const updated: QAQuestion = {
    ...question,
    upvotes: votes.size,
  };
  roomState.qaQuestions.set(updated.id, updated);

  broadcastQAQuestion(mapping.roomId, updated);
}

function handlePollCreate(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'poll-create' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can create polls', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before creating polls', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (roomState.polls.size >= MAX_ACTIVE_POLLS_PER_ROOM) {
    sendError(ws, `Poll limit reached (max ${MAX_ACTIVE_POLLS_PER_ROOM})`, 'POLL_LIMIT_REACHED');
    return;
  }

  if (typeof payload.question !== 'string' || !Array.isArray(payload.options)) {
    sendError(ws, 'Invalid poll payload', 'VALIDATION_ERROR');
    return;
  }

  const question = payload.question.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!question) return;
  if (question.length > MAX_POLL_QUESTION_LENGTH) {
    sendError(ws, `Poll question too long (max ${MAX_POLL_QUESTION_LENGTH} characters)`, 'POLL_TOO_LONG');
    return;
  }

  const options = payload.options
    .map((option) => typeof option === 'string' ? option.replace(/[\x00-\x1F\x7F]/g, '').trim() : '')
    .filter(Boolean)
    .slice(0, MAX_POLL_OPTIONS);
  const uniqueOptions = Array.from(new Set(options));

  if (uniqueOptions.length < 2) {
    sendError(ws, 'Polls require at least two options', 'VALIDATION_ERROR');
    return;
  }
  if (uniqueOptions.some((option) => option.length > MAX_POLL_OPTION_LENGTH)) {
    sendError(ws, `Poll options must be ${MAX_POLL_OPTION_LENGTH} characters or less`, 'POLL_OPTION_TOO_LONG');
    return;
  }

  const requestedId = typeof payload.id === 'string' && /^[\w-]{1,80}$/.test(payload.id)
    ? payload.id
    : nanoid(10);
  const id = roomState.polls.has(requestedId) ? nanoid(10) : requestedId;
  const poll: LivePoll = {
    id,
    question,
    options: uniqueOptions.map((text, index) => ({
      id: `${id}-option-${index + 1}`,
      text,
      votes: 0,
    })),
    status: 'open',
    highlighted: false,
    createdAt: new Date().toISOString(),
    createdBy: mapping.participantId,
    createdByName: performer.participant.name,
    totalVotes: 0,
  };

  roomState.polls.set(poll.id, poll);
  roomState.pollVotes.set(poll.id, new Map());
  broadcastPoll(mapping.roomId, poll);
}

function handlePollVote(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'poll-vote' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const participant = roomState.participants.get(mapping.participantId)?.participant;
  if (participant?.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before voting in polls', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.pollId !== 'string' || typeof payload.optionId !== 'string') {
    sendError(ws, 'Invalid poll vote', 'VALIDATION_ERROR');
    return;
  }

  const poll = roomState.polls.get(payload.pollId);
  if (!poll || poll.status !== 'open') return;
  const updated = applyPollVote(roomState, mapping.participantId, poll, payload.optionId);
  if (!updated) {
    sendError(ws, 'Invalid poll option', 'VALIDATION_ERROR');
    return;
  }

  broadcastPoll(mapping.roomId, updated);
}

function handlePollUpdate(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'poll-update' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can manage polls', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before managing polls', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  if (typeof payload.pollId !== 'string') {
    sendError(ws, 'Invalid poll id', 'VALIDATION_ERROR');
    return;
  }

  const existing = roomState.polls.get(payload.pollId);
  if (!existing) return;

  const updates = payload.updates || {};
  const changedPolls: LivePoll[] = [];

  if (updates.highlighted === true) {
    for (const [id, poll] of roomState.polls) {
      if (id !== existing.id && poll.highlighted) {
        const unhighlighted = { ...poll, highlighted: false };
        roomState.polls.set(id, unhighlighted);
        changedPolls.push(unhighlighted);
      }
    }
  }

  const next: LivePoll = { ...existing };
  if (updates.status) {
    if (updates.status !== 'open' && updates.status !== 'closed') {
      sendError(ws, 'Invalid poll status', 'VALIDATION_ERROR');
      return;
    }
    next.status = updates.status;
  }
  if (typeof updates.highlighted === 'boolean') {
    next.highlighted = updates.highlighted;
  }

  roomState.polls.set(next.id, next);
  changedPolls.push(next);

  for (const poll of changedPolls) {
    broadcastPoll(mapping.roomId, poll);
  }
}

const END_ROOM_GRACE_MS = 10_000;

function endRoomImmediately(roomId: string) {
  const state = rooms.get(roomId);
  if (!state) return;

  broadcastToRoom(roomId, { type: 'room-ended', payload: {} });

  for (const [, { ws: participantWs }] of state.participants) {
    wsToParticipant.delete(participantWs);
    try {
      participantWs.close(1000, 'Room ended');
    } catch {
      // Already closed
    }
  }
  state.participants.clear();
  deleteRoom(roomId);
  console.log(`Room ${roomId} ended and cleaned up`);
}

function handleEndRoom(ws: WebSocket) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  // Only the host can end the room
  const performer = roomState.participants.get(mapping.participantId);
  if (!performer || performer.participant.role !== 'host') {
    sendError(ws, 'Only the host can end the room', 'UNAUTHORIZED');
    return;
  }

  // Prevent duplicate end-room if already ending
  if (endingTimers.has(mapping.roomId)) return;

  const roomId = mapping.roomId;
  const endsAt = new Date(Date.now() + END_ROOM_GRACE_MS).toISOString();

  // Single broadcast — clients tick locally against endsAt rather than relying on
  // per-second server messages.
  broadcastToRoom(roomId, {
    type: 'room-ending',
    payload: { endsAt },
  });

  console.log(`Host is ending room ${roomId} — closing at ${endsAt}`);

  const timer = setTimeout(() => {
    endingTimers.delete(roomId);
    endRoomImmediately(roomId);
  }, END_ROOM_GRACE_MS);
  timer.unref?.();

  endingTimers.set(roomId, timer);
}

function handleDisconnect(ws: WebSocket) {
  // Clean up rate limit tracking
  wsMessageCounts.delete(ws);

  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const { roomId, participantId } = mapping;
  const roomState = rooms.get(roomId);

  if (roomState) {
    const entry = roomState.participants.get(participantId);
    const name = entry?.participant.name || 'Unknown';
    const wasHost = participantId === roomState.room.hostId;

    roomState.participants.delete(participantId);
    wsToParticipant.delete(ws);

    clearLiveStreamStateForParticipant(roomId, roomState, participantId);

    // Remove from co-host list if applicable
    roomState.room.coHostIds = roomState.room.coHostIds.filter((id) => id !== participantId);

    // If the host disconnected, clean up ending timer and attempt co-host handoff.
    if (wasHost) {
      // Clear any active ending timer for this room
      if (clearRoomEndingTimer(roomId)) {
        // Notify remaining participants that the end was cancelled
        broadcastToRoom(roomId, {
          type: 'room-ending-cancelled',
          payload: {},
        });
      }

      // Hand off only to an actual co-host. Promoting a random guest is
      // surprising and gives someone uninvited authority over the room.
      let newHostId: string | null = null;
      for (const coHostId of roomState.room.coHostIds) {
        if (roomState.participants.has(coHostId)) {
          newHostId = coHostId;
          break;
        }
      }

      if (newHostId) {
        const newHost = roomState.participants.get(newHostId);
        if (newHost) {
          newHost.participant.role = 'host';
          roomState.room.hostId = newHostId;
          roomState.room.coHostIds = roomState.room.coHostIds.filter((id) => id !== newHostId);

          console.log(`Host handoff: ${newHost.participant.name} is now host of room ${roomId}`);

          broadcastToRoom(roomId, {
            type: 'participant-updated',
            payload: newHost.participant,
          });
          broadcastToRoom(roomId, {
            type: 'host-changed',
            payload: { newHostId, newHostName: newHost.participant.name },
          });
        }
      } else if (roomState.participants.size > 0) {
        // No co-host to inherit — end the room rather than crowning a random guest.
        console.log(`Host of room ${roomId} disconnected with no co-host. Ending room.`);
        endRoomImmediately(roomId);
        return;
      }
    }

    broadcastToRoom(roomId, {
      type: 'participant-left',
      payload: { participantId },
    });

    console.log(`${name} left room ${roomId} [${roomState.participants.size} participants]`);

    if (roomState.participants.size === 0) {
      scheduleEmptyRoomDeletion(roomId, roomState);
    }
  }
}

function broadcastToRoom(roomId: string, message: SignalMessage, excludeId?: string) {
  const roomState = rooms.get(roomId);
  if (!roomState) return;

  for (const [id, { ws }] of roomState.participants) {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
      // Fix #5: Wrap send in try/catch so one bad socket doesn't break the loop
      try {
        send(ws, message);
      } catch (err) {
        console.error(`Failed to send to participant ${id}:`, (err as Error).message);
      }
    }
  }
}

function broadcastQAQuestion(roomId: string, question: QAQuestion) {
  const roomState = rooms.get(roomId);
  if (!roomState) return;

  for (const [id, { participant, ws }] of roomState.participants) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (
      question.status === 'pending' &&
      participant.role === 'guest' &&
      id !== question.authorId
    ) {
      continue;
    }

    try {
      send(ws, {
        type: 'qa-question-updated',
        payload: question,
      });
    } catch (err) {
      console.error(`Failed to send Q&A update to participant ${id}:`, (err as Error).message);
    }
  }
}

function broadcastPoll(roomId: string, poll: LivePoll) {
  broadcastToRoom(roomId, {
    type: 'poll-updated',
    payload: poll,
  });
}

function send(ws: WebSocket, message: SignalMessage) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  } catch {
    // Socket is closing or closed, nothing to do
  }
}

function sendError(ws: WebSocket, message: string, code: string) {
  // Wrap in try/catch to avoid crashing if the socket is already closed
  try {
    send(ws, { type: 'error', payload: { message, code } });
  } catch {
    // Socket is dead, nothing to do
  }
}
