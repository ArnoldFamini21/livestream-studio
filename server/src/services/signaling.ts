import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { nanoid } from 'nanoid';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type {
  SignalMessage,
  Room,
  Participant,
  ParticipantStatus,
  JoinRoomPayload,
  MediaStatePayload,
  UpdateNamePayload,
  ChatMessage,
  ChatTypingPayload,
  ChatReactionType,
  QAQuestion,
  LivePoll,
  StageActionPayload,
  StageBackground,
  RecordingStatePayload,
  RecordingUploadProgressPayload,
  LiveStreamStatePayload,
  LiveStreamTokenClaims,
  RecordingUploadTokenClaims,
  SfuMembershipControlAction,
  SfuMembershipControlClaims,
  SfuTokenClaims,
  StudioBrandingPayload,
  StageContentPayload,
  StageContentMedia,
  LayoutMode,
  StudioMediaType,
  RoomRegistrant,
  RoomRegistrantListResponse,
  RoomRegistrantResponse,
  ExternalChatPlatform,
  ExternalChatStatusPayload,
} from '@studio/shared';
import {
  RECORDING_UPLOAD_PROGRESS_STATUSES,
  MAX_RECORDING_TRANSFER_SDP_LENGTH,
  ROOM_NOT_OPEN_ERROR_CODE,
  SCHEDULED_GUEST_ACCESS_MESSAGE,
  canExchangeStudioMedia,
  isChatReactionType,
  isScheduledGuestAccessBlocked,
} from '@studio/shared';
import {
  fetchYouTubeLiveChatMessages,
  normalizeYouTubeApiKey,
  normalizeYouTubeLiveChatId,
  type YouTubeLiveChatMessage,
} from './youtubeLiveChat.js';
import {
  fetchFacebookLiveComments,
  normalizeFacebookAccessToken,
  normalizeFacebookLiveVideoId,
  type FacebookLiveComment,
} from './facebookLiveComments.js';
import {
  buildPersistentRoomSnapshot,
  type RoomSessionSnapshot,
  type RoomSnapshot,
  type RoomSnapshotStore,
} from './roomPersistence.js';
import {
  PasswordAttemptLimiter,
  SocketsPerIpLimiter,
  getUpgradeRequestIp,
  verifyPasswordHashAsync,
} from './joinProtection.js';
import {
  MAX_RELAYED_CANDIDATE_LENGTH,
  MAX_RELAYED_SDP_LENGTH,
  WsRateLimiter,
} from './wsRateLimit.js';
import {
  ROOM_RESTORE_TICKET_TTL_MS,
  hashHostToken,
  signRoomRestoreTicket,
  verifyRoomRestoreTicket,
} from './roomRestoreTicket.js';

type RelaySignalMessage = Extract<SignalMessage, { type: 'offer' | 'answer' | 'ice-candidate' }>;

interface ParticipantEntry {
  participant: Participant;
  ws: WebSocket;
  joinSessionId?: string;
  stageUploadToken?: string;
  /** Reads stage pictures; issued once the participant is admitted. */
  stageReadToken?: string;
  /** Network address of the current connection (bans, password lockouts). */
  ip: string;
  /** Secret that lets this seat be resumed after a dropped connection. */
  resumeToken: string;
  /** Set while the connection is gone and the seat is held for a resume. */
  disconnectedAt?: number;
  resumeTimer?: ReturnType<typeof setTimeout>;
}

type RedeemedInviteKind = 'co-host' | 'guest-secure';

// In-memory store, snapshotted to PostgreSQL when DATABASE_URL is set.
interface RoomState {
  room: Room;
  participants: Map<string, ParticipantEntry>;
  /** Private id of the public watch page; the room id is the guest join capability and is never published. */
  watchId: string;
  bannedJoinSessionIds: Set<string>;
  /** Banned network addresses and when the ban lapses; a fresh browser session alone cannot undo a ban. */
  bannedIps: Map<string, number>;
  /** Join sessions the host removed, and when; they always go back through the green room. */
  removedJoinSessionIds: Map<string, number>;
  /** Single-use invite links already redeemed, by the join session that redeemed them, so a reconnect keeps the role. */
  redeemedInvites: Map<string, { kind: RedeemedInviteKind; expiresAt: number }>;
  /** The co-host who inherited the host seat while the host was away; handed back when the host returns. */
  handedOffHostId?: string;
  /** Admitted guests who dropped, by join session, so a quick return skips the green room. */
  recentGuestSessions?: Map<string, { status: ParticipantStatus; leftAtMs: number }>;
  chatMessages: Map<string, ChatMessage>;
  chatReactions: Map<string, Map<ChatReactionType, Set<string>>>;
  qaQuestions: Map<string, QAQuestion>;
  qaVotes: Map<string, Set<string>>;
  polls: Map<string, LivePoll>;
  pollVotes: Map<string, Map<string, string>>;
  registrants: Map<string, RoomRegistrant>;
  externalChatConnections: Map<ExternalChatPlatform, ExternalChatConnectionState>;
  studioBranding?: StudioBrandingPayload;
  stageContent?: StageContentPayload;
  /** Pictures of what is on stage, newest last; served to guests by id. */
  stageImages?: Map<string, StageImage>;
  guestInviteTokens: Map<string, { expiresAt: number; issuedBy: string; createdAt: number }>;
  coHostInviteTokens: Map<string, { expiresAt: number; issuedBy: string; createdAt: number }>;
  recordingStartedAt?: string;
  recordingSessionId?: string;
  recordingPaused?: boolean;
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
  // Set while the host's connection is gone; the room ends if it fires.
  hostReconnectTimer?: ReturnType<typeof setTimeout>;
}

/**
 * How long a studio waits for its host to reconnect before ending. A host's
 * connection drops for ordinary reasons (Wi-Fi blip, laptop sleep, a server
 * restart); ending the studio at once stranded guests in the waiting room
 * and left the reconnected host in a studio that no longer existed.
 */
export const HOST_RECONNECT_GRACE_MS = 2 * 60_000;
/** A guest the host admitted who returns this soon (dropped connection, reload) is not re-screened. */
export const GUEST_REJOIN_GRACE_MS = 2 * 60_000;

/** Where a returning guest goes: their earlier place, if they were admitted and left recently. */
export function getReturningGuestStatus(
  record: { status: ParticipantStatus; leftAtMs: number } | undefined,
  nowMs: number
): ParticipantStatus | undefined {
  if (!record || record.status === 'green-room') return undefined;
  if (nowMs - record.leftAtMs > GUEST_REJOIN_GRACE_MS) return undefined;
  return record.status;
}

function rememberDepartedGuest(roomState: RoomState, joinSessionId: string, status: ParticipantStatus, nowMs: number) {
  const sessions = roomState.recentGuestSessions ?? new Map();
  roomState.recentGuestSessions = sessions;
  for (const [id, record] of sessions) {
    if (nowMs - record.leftAtMs > GUEST_REJOIN_GRACE_MS) sessions.delete(id);
  }
  sessions.set(joinSessionId, { status, leftAtMs: nowMs });
}

export interface StageImage {
  data: Buffer;
  contentType: string;
  createdAt: number;
}

// A 720p JPEG is about 150 KB; these caps bound what one studio can hold.
export const STAGE_IMAGE_MAX_BYTES = 1024 * 1024;
const STAGE_IMAGE_LIMIT_PER_ROOM = 60;
const STAGE_IMAGE_BYTES_PER_ROOM = 20 * 1024 * 1024;
const STAGE_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const STAGE_MEDIA_TYPES = new Set<StudioMediaType>(['video', 'image', 'pdf', 'presentation', 'file']);
const STAGE_LAYOUTS = new Set<LayoutMode>(['grid', 'spotlight', 'side-by-side', 'pip', 'single', 'featured']);

function clearHostReconnectTimer(roomState: RoomState): void {
  if (roomState.hostReconnectTimer) {
    clearTimeout(roomState.hostReconnectTimer);
    roomState.hostReconnectTimer = undefined;
  }
}

interface ExternalChatConnectionState {
  platform: ExternalChatPlatform;
  liveChatId: string;
  status: ExternalChatStatusPayload;
  nextPageToken?: string;
  seenMessageIds: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  polling: boolean;
  stopped: boolean;
}

// Extend WebSocket to track heartbeat state
interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
}

// Known message types for validation (fix #10)
const KNOWN_MESSAGE_TYPES = new Set([
  'heartbeat',
  'stage-content-updated',
  'join-room',
  'offer',
  'answer',
  'ice-candidate',
  'media-state-changed',
  'update-name',
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
  'recording-upload-token-request',
  'recording-upload-progress',
  'recording-upload-control',
  'recording-transfer-signal',
  'sfu-token-request',
  'live-stream-state-changed',
  'live-stream-token-request',
  'external-chat-connect',
  'external-chat-disconnect',
  'guest-invite-token-request',
  'co-host-invite-token-request',
  'end-room',
  'cancel-end-room',
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
const socketIps = new WeakMap<WebSocket, string>();
/** Sockets with a join still being checked (password hashing is asynchronous). */
const pendingJoins = new WeakSet<WebSocket>();
const failedJoinsBySocket = new WeakMap<WebSocket, number>();
const passwordAttempts = new PasswordAttemptLimiter();
const socketsPerIp = new SocketsPerIpLimiter(
  parseBoundedDurationMs(process.env.SIGNALING_MAX_SOCKETS_PER_IP, 20, 2, 500)
);
const endingTimers = new Map<string, NodeJS.Timeout>();
// IP -> Set<roomId> of rooms this IP created and that are still active.
const roomsByCreatorIp = new Map<string, Set<string>>();
let roomSnapshotStore: RoomSnapshotStore | null = null;

// Stale room cleanup: never-joined rooms expire after 30 min, joined rooms after 24h.
const staleRoomCleanupTimer = setInterval(() => {
  const now = Date.now();
  rooms.forEach((roomState, id) => {
    if (roomState.participants.size > 0) return;
    const created = getRoomIdleReferenceMs(roomState);
    const idleLimit = roomState.hasBeenJoined ? ACTIVE_IDLE_MS : NEVER_JOINED_IDLE_MS;
    if (now - created > idleLimit) {
      deleteRoom(id);
      console.log(`Stale room ${id} cleaned up (idle for >${Math.round(idleLimit / 60000)}m)`);
    }
  });
}, 10 * 60 * 1000); // Every 10 minutes
staleRoomCleanupTimer.unref?.();

// WebSocket per-connection rate limiting: negotiation messages get their own, larger budget.
const wsRateLimiter = new WsRateLimiter<WebSocket>();

/**
 * How long a seat is held after its connection drops (Wi-Fi blip, proxy reset,
 * page reload) before the participant counts as gone. Within it, presenting
 * the resume token returns the same participant id, so healthy peer
 * connections are not torn down and nobody's tile flickers away.
 */
const RESUME_GRACE_MS = parseBoundedDurationMs(process.env.SIGNALING_RESUME_GRACE_MS, 30_000, 0, 120_000);
/** Waiting guests have their own small cap; they do not take stage seats. */
export const MAX_GREEN_ROOM_PARTICIPANTS = 5;
const BANNED_IP_TTL_MS = 12 * 60 * 60 * 1000;
const REMOVED_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** A socket that keeps failing to join is closed. */
const MAX_FAILED_JOINS_PER_SOCKET = 3;
const PC_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

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
const MAX_ROOM_REGISTRANTS = 1000;
const MAX_REGISTRANT_NAME_LENGTH = 80;
const MAX_REGISTRANT_EMAIL_LENGTH = 254;
const LIVE_STREAM_TOKEN_TTL_MS = 5 * 60 * 1000;
const RECORDING_UPLOAD_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RECORDING_UPLOAD_REPORT_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_RECORDING_UPLOAD_REPORT_TRACKS = 64;
const MAX_RECORDING_UPLOAD_REPORT_MESSAGE_LENGTH = 160;
const SFU_TOKEN_TTL_MS = 15 * 60 * 1000;
const GUEST_INVITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GUEST_INVITE_TOKENS_PER_ROOM = 40;
const CO_HOST_INVITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CO_HOST_INVITE_TOKENS_PER_ROOM = 20;

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

export function getRooms() {
  return rooms;
}

export function configureRoomSnapshotStore(store: RoomSnapshotStore | null) {
  roomSnapshotStore = store;
}

export interface CreatedRoom {
  room: Room;
  hostToken: string;
}

export type HostAccessRecoveryResult =
  | { status: 'ok'; room: Room; hostToken: string }
  | { status: 'not_found' | 'forbidden' };

export type RoomHostAccessResult =
  | { status: 'ok'; room: Room }
  | { status: 'not_found' | 'forbidden' };

export class RoomQuotaError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'RoomQuotaError';
  }
}

export class RoomRegistrationError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
    this.name = 'RoomRegistrationError';
  }
}

function getRoomIdleReferenceMs(roomState: RoomState): number {
  const createdAtMs = Date.parse(roomState.room.createdAt);
  const created = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  if (roomState.room.status !== 'scheduled') return created;

  const scheduledAtMs = Date.parse(roomState.room.scheduledFor || '');
  return Number.isFinite(scheduledAtMs) ? Math.max(created, scheduledAtMs) : created;
}

function createWatchId(): string {
  return randomBytes(12).toString('base64url');
}

function createRoomStateFromSnapshot(snapshot: RoomSnapshot): RoomState {
  const session = snapshot.sessionState;
  const nowMs = Date.now();
  const recentGuestSessions = new Map<string, { status: ParticipantStatus; leftAtMs: number }>();
  for (const guest of session?.returningGuests || []) {
    // Guests who were in the studio when the snapshot was taken lost their
    // connection to the restart itself: their grace starts now.
    const leftAtMs = guest.present ? nowMs : guest.leftAtMs;
    if (nowMs - leftAtMs <= GUEST_REJOIN_GRACE_MS) recentGuestSessions.set(guest.joinSessionId, { status: guest.status, leftAtMs });
  }
  return {
    room: snapshot.room,
    participants: new Map(),
    watchId: session?.watchId || createWatchId(),
    bannedJoinSessionIds: new Set(session?.bannedJoinSessionIds || []),
    bannedIps: new Map((session?.bannedIps || []).filter((ban) => ban.expiresAt > nowMs).map((ban) => [ban.ip, ban.expiresAt])),
    removedJoinSessionIds: new Map((session?.removedJoinSessionIds || [])
      .filter((entry) => nowMs - entry.removedAt <= REMOVED_SESSION_TTL_MS)
      .map((entry) => [entry.joinSessionId, entry.removedAt])),
    redeemedInvites: new Map((session?.redeemedInvites || [])
      .filter((entry) => entry.expiresAt > nowMs)
      .map((entry) => [entry.joinSessionId, { kind: entry.kind, expiresAt: entry.expiresAt }])),
    ...(recentGuestSessions.size ? { recentGuestSessions } : {}),
    ...(session?.recording ? {
      recordingSessionId: session.recording.sessionId,
      ...(session.recording.startedAt ? { recordingStartedAt: session.recording.startedAt } : {}),
      ...(session.recording.paused ? { recordingPaused: true } : {}),
    } : {}),
    chatMessages: new Map(),
    chatReactions: new Map(),
    qaQuestions: new Map(),
    qaVotes: new Map(),
    polls: new Map(),
    pollVotes: new Map(),
    registrants: new Map((snapshot.registrants || []).map((registrant) => [registrant.email, registrant])),
    externalChatConnections: new Map(),
    guestInviteTokens: new Map(),
    coHostInviteTokens: new Map(),
    hostToken: snapshot.hostToken,
    creatorIp: snapshot.creatorIp,
    hasBeenJoined: snapshot.hasBeenJoined,
    ...(snapshot.studioBranding ? { studioBranding: snapshot.studioBranding } : {}),
    ...(snapshot.passwordHash ? { passwordHash: snapshot.passwordHash } : {}),
    ...(snapshot.passwordSalt ? { passwordSalt: snapshot.passwordSalt } : {}),
  };
}

function buildRoomSessionSnapshot(roomState: RoomState): RoomSessionSnapshot {
  const nowMs = Date.now();
  const returningGuests: NonNullable<RoomSessionSnapshot['returningGuests']> = [];
  for (const [joinSessionId, record] of roomState.recentGuestSessions || []) {
    if (record.status === 'green-room' || nowMs - record.leftAtMs > GUEST_REJOIN_GRACE_MS) continue;
    returningGuests.push({ joinSessionId, status: record.status, leftAtMs: record.leftAtMs });
  }
  for (const entry of roomState.participants.values()) {
    if (entry.participant.role !== 'guest' || !entry.joinSessionId || entry.participant.status === 'green-room') continue;
    returningGuests.push({ joinSessionId: entry.joinSessionId, status: entry.participant.status, leftAtMs: nowMs, present: true });
  }
  return {
    watchId: roomState.watchId,
    ...(roomState.recordingSessionId ? {
      recording: {
        sessionId: roomState.recordingSessionId,
        ...(roomState.recordingStartedAt ? { startedAt: roomState.recordingStartedAt } : {}),
        ...(roomState.recordingPaused ? { paused: true } : {}),
      },
    } : {}),
    bannedJoinSessionIds: Array.from(roomState.bannedJoinSessionIds).slice(-200),
    bannedIps: Array.from(roomState.bannedIps, ([ip, expiresAt]) => ({ ip, expiresAt })).filter((ban) => ban.expiresAt > nowMs).slice(-200),
    returningGuests: returningGuests.slice(-200),
    removedJoinSessionIds: Array.from(roomState.removedJoinSessionIds, ([joinSessionId, removedAt]) => ({ joinSessionId, removedAt }))
      .filter((entry) => nowMs - entry.removedAt <= REMOVED_SESSION_TTL_MS).slice(-200),
    redeemedInvites: Array.from(roomState.redeemedInvites, ([joinSessionId, invite]) => ({ joinSessionId, ...invite }))
      .filter((entry) => entry.expiresAt > nowMs).slice(-200),
  };
}

function buildRoomStateSnapshot(roomState: RoomState): RoomSnapshot {
  return buildPersistentRoomSnapshot({
    sessionState: buildRoomSessionSnapshot(roomState),
    room: roomState.room,
    hostToken: roomState.hostToken,
    creatorIp: roomState.creatorIp,
    hasBeenJoined: roomState.hasBeenJoined,
    registrants: Array.from(roomState.registrants.values()),
    ...(roomState.studioBranding ? { studioBranding: roomState.studioBranding } : {}),
    ...(roomState.passwordHash ? { passwordHash: roomState.passwordHash } : {}),
    ...(roomState.passwordSalt ? { passwordSalt: roomState.passwordSalt } : {}),
  });
}

function indexRoomCreator(roomId: string, creatorIp: string) {
  let ipSet = roomsByCreatorIp.get(creatorIp);
  if (!ipSet) {
    ipSet = new Set();
    roomsByCreatorIp.set(creatorIp, ipSet);
  }
  ipSet.add(roomId);
}

function persistRoomSnapshot(roomId: string) {
  if (!roomSnapshotStore) return;
  const roomState = rooms.get(roomId);
  if (!roomState) return;

  let snapshot: RoomSnapshot;
  try {
    snapshot = buildRoomStateSnapshot(roomState);
  } catch (err) {
    console.warn(`Room ${roomId} snapshot was not persisted:`, err instanceof Error ? err.message : err);
    return;
  }

  void roomSnapshotStore.saveRoomSnapshot(snapshot).catch((err) => {
    console.warn(`Room ${roomId} snapshot persistence failed:`, err instanceof Error ? err.message : err);
  });
}

function deleteRoomSnapshot(roomId: string) {
  if (!roomSnapshotStore) return;
  void roomSnapshotStore.deleteRoomSnapshot(roomId).catch((err) => {
    console.warn(`Room ${roomId} snapshot delete failed:`, err instanceof Error ? err.message : err);
  });
}

export function restoreRoomSnapshots(snapshots: RoomSnapshot[]): number {
  let restored = 0;
  for (const snapshot of snapshots) {
    let normalized: RoomSnapshot;
    try {
      normalized = buildPersistentRoomSnapshot(snapshot);
    } catch {
      continue;
    }

    if (normalized.room.status === 'ended') continue;
    if (rooms.has(normalized.room.id) || rooms.size >= MAX_ROOMS) continue;
    const ipSet = roomsByCreatorIp.get(normalized.creatorIp);
    if (ipSet && ipSet.size >= MAX_ROOMS_PER_IP) continue;

    rooms.set(normalized.room.id, createRoomStateFromSnapshot(normalized));
    indexRoomCreator(normalized.room.id, normalized.creatorIp);
    restored++;
  }
  return restored;
}

export function recoverHostAccess(roomId: string, hostToken: unknown): HostAccessRecoveryResult {
  const roomState = rooms.get(roomId);
  if (!roomState) return { status: 'not_found' };
  // A shared or forwarded IP address is not proof of room ownership. Keep this
  // compatibility route available only to a holder of the private credential.
  if (typeof hostToken !== 'string' || !safeEqual(hostToken, roomState.hostToken)) return { status: 'forbidden' };

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
  clearHostReconnectTimer(state);
  for (const entry of state.participants.values()) clearResumeTimer(entry);
  passwordAttempts.forgetRoom(roomId);
  const endingTimer = endingTimers.get(roomId);
  if (endingTimer) {
    clearTimeout(endingTimer);
    endingTimers.delete(roomId);
  }
  stopAllExternalChatConnections(roomId, state, false);
  const ipSet = roomsByCreatorIp.get(state.creatorIp);
  if (ipSet) {
    ipSet.delete(roomId);
    if (ipSet.size === 0) roomsByCreatorIp.delete(state.creatorIp);
  }
  rooms.delete(roomId);
  deleteRoomSnapshot(roomId);
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
  persistRoomSnapshot(roomId);

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

function clearResumeTimer(entry: ParticipantEntry): void {
  if (entry.resumeTimer) clearTimeout(entry.resumeTimer);
  entry.resumeTimer = undefined;
}

function replaceGuestSession(roomId: string, roomState: RoomState, existingId: string) {
  const existing = roomState.participants.get(existingId);
  if (!existing) return;
  clearResumeTimer(existing);
  // Seen only if the old connection is still alive, i.e. another tab.
  send(existing.ws, {
    type: 'participant-removed',
    payload: { reason: 'You joined this studio again from another tab or window.' },
  });
  roomState.participants.delete(existingId);
  wsToParticipant.delete(existing.ws);
  roomState.room.coHostIds = roomState.room.coHostIds.filter((id) => id !== existingId);
  notifyMediaServerSfuMembership('revoke-participant', roomId, existingId, 'Guest session replaced');
  broadcastToRoom(roomId, {
    type: 'participant-left',
    payload: { participantId: existingId },
  });
  existing.ws.close(4000, 'Guest session replaced');
}

function replaceExistingHostSession(roomId: string, roomState: RoomState, existingHostId: string) {
  const existingHost = roomState.participants.get(existingHostId);
  if (!existingHost) return;
  clearResumeTimer(existingHost);

  send(existingHost.ws, {
    type: 'participant-removed',
    payload: { reason: 'Your host session was replaced by a newer host login.' },
  });

  roomState.participants.delete(existingHostId);
  wsToParticipant.delete(existingHost.ws);
  notifyMediaServerSfuMembership('revoke-participant', roomId, existingHostId, 'Host session replaced');
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
  options: {
    status?: 'waiting' | 'scheduled';
    scheduledFor?: string;
    creatorIp: string;
    password?: string;
    registrationEnabled?: boolean;
  }
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
    registration: {
      enabled: Boolean(options.registrationEnabled),
      fields: ['name', 'email'],
    },
  };

  const hostToken = nanoid(32);
  const passwordVerifier = options.password ? createPasswordVerifier(options.password) : {};

  rooms.set(room.id, createRoomStateFromSnapshot({
    room,
    hostToken,
    creatorIp: options.creatorIp,
    hasBeenJoined: false,
    ...passwordVerifier,
    sessionState: { watchId: createWatchId() },
  }));

  indexRoomCreator(room.id, options.creatorIp);
  persistRoomSnapshot(room.id);

  return { room, hostToken };
}

function sanitizeRegistrantText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLength);
}

function normalizeRegistrantEmail(value: unknown): string {
  const email = sanitizeRegistrantText(value, MAX_REGISTRANT_EMAIL_LENGTH).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

export function assertRegistrationHostAccess(roomState: RoomState, hostToken: unknown) {
  if (typeof hostToken !== 'string' || !safeEqual(hostToken, roomState.hostToken)) {
    throw new RoomRegistrationError(403, 'HOST_TOKEN_INVALID', 'Host access is required to view registrants.');
  }
}

export function getRoomHostAccess(roomId: string, hostToken: unknown): RoomHostAccessResult {
  const roomState = rooms.get(roomId);
  if (!roomState) return { status: 'not_found' };
  if (typeof hostToken !== 'string' || !safeEqual(hostToken, roomState.hostToken)) {
    return { status: 'forbidden' };
  }
  return { status: 'ok', room: roomState.room };
}

export function registerRoomGuest(
  roomId: string,
  input: { name?: unknown; email?: unknown },
  now = new Date()
): RoomRegistrantResponse {
  const roomState = rooms.get(roomId);
  if (!roomState) {
    throw new RoomRegistrationError(404, 'ROOM_NOT_FOUND', 'Room not found');
  }
  if (!roomState.room.registration?.enabled) {
    throw new RoomRegistrationError(409, 'REGISTRATION_DISABLED', 'Registration is not enabled for this studio.');
  }

  const name = sanitizeRegistrantText(input.name, MAX_REGISTRANT_NAME_LENGTH);
  const email = normalizeRegistrantEmail(input.email);
  if (!name) {
    throw new RoomRegistrationError(400, 'REGISTRANT_NAME_REQUIRED', 'Registrant name is required.');
  }
  if (!email) {
    throw new RoomRegistrationError(400, 'REGISTRANT_EMAIL_INVALID', 'Enter a valid email address.');
  }

  const existing = roomState.registrants.get(email);
  const registeredAt = now.toISOString();
  const registrant: RoomRegistrant = {
    id: existing?.id || nanoid(10),
    roomId,
    name,
    email,
    registeredAt: existing?.registeredAt || registeredAt,
  };

  if (!existing && roomState.registrants.size >= MAX_ROOM_REGISTRANTS) {
    throw new RoomRegistrationError(429, 'REGISTRATION_LIMIT_REACHED', 'This studio registration list is full.');
  }

  roomState.registrants.set(email, registrant);
  persistRoomSnapshot(roomId);

  return {
    registrant,
    total: roomState.registrants.size,
  };
}

export function getRoomRegistrantList(
  roomId: string,
  hostToken: unknown,
  now = new Date()
): RoomRegistrantListResponse {
  const roomState = rooms.get(roomId);
  if (!roomState) {
    throw new RoomRegistrationError(404, 'ROOM_NOT_FOUND', 'Room not found');
  }

  assertRegistrationHostAccess(roomState, hostToken);

  return {
    roomId,
    exportedAt: now.toISOString(),
    registrants: Array.from(roomState.registrants.values())
      .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt)),
  };
}

function createPasswordVerifier(password: string): { passwordHash: string; passwordSalt: string } {
  const passwordSalt = randomBytes(16).toString('base64url');
  const passwordHash = scryptSync(password, passwordSalt, 32).toString('base64url');
  return { passwordHash, passwordSalt };
}

/** Checked off the event loop and one at a time (see joinProtection.ts). */
async function verifyRoomPassword(roomState: RoomState, password: unknown): Promise<boolean> {
  if (!roomState.passwordHash || !roomState.passwordSalt) return true;
  if (typeof password !== 'string') return false;
  const sanitized = password.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (!sanitized || sanitized.length > MAX_ROOM_PASSWORD_LENGTH) return false;
  return verifyPasswordHashAsync(sanitized, roomState.passwordSalt, roomState.passwordHash);
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

function signMediaToken(
  claims: LiveStreamTokenClaims | RecordingUploadTokenClaims | SfuTokenClaims | SfuMembershipControlClaims,
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export interface SfuMembershipNotification {
  action: SfuMembershipControlAction;
  roomId: string;
  participantId?: string;
  reason?: string;
  token: string;
}

type SfuMembershipNotifier = (notification: SfuMembershipNotification) => void | Promise<void>;

let customSfuMembershipNotifier: SfuMembershipNotifier | null = null;

export function setSfuMembershipNotifier(notifier: SfuMembershipNotifier | null): void {
  customSfuMembershipNotifier = notifier;
}

function notifyMediaServerSfuMembership(
  action: SfuMembershipControlAction,
  roomId: string,
  participantId?: string,
  reason?: string
): void {
  const secret = getLiveStreamTokenSecret();
  if (!secret) return;
  const now = Date.now();
  const claims: SfuMembershipControlClaims = {
    v: 1,
    purpose: 'sfu-control',
    action,
    roomId,
    ...(participantId ? { participantId } : {}),
    ...(reason ? { reason } : {}),
    iat: now,
    exp: now + 60_000,
    nonce: nanoid(16),
  };
  const token = signMediaToken(claims, secret);

  if (customSfuMembershipNotifier) {
    void Promise.resolve(
      customSfuMembershipNotifier({ action, roomId, participantId, reason, token })
    ).catch(() => undefined);
    return;
  }

  const mediaServerUrl = process.env.MEDIA_SERVER_URL?.trim().replace(/\/+$/, '');
  if (!mediaServerUrl) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  timeout.unref?.();
  void fetch(`${mediaServerUrl}/sfu/membership`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ token }),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timeout));
}

function pruneExpiredCoHostInviteTokens(roomState: RoomState, now = Date.now()) {
  for (const [token, invite] of roomState.coHostInviteTokens) {
    if (invite.expiresAt <= now) {
      roomState.coHostInviteTokens.delete(token);
    }
  }
}

function pruneExpiredGuestInviteTokens(roomState: RoomState, now = Date.now()) {
  for (const [token, invite] of roomState.guestInviteTokens) {
    if (invite.expiresAt <= now) {
      roomState.guestInviteTokens.delete(token);
    }
  }
}

function consumeCoHostInviteToken(roomState: RoomState, token: unknown): { expiresAt: number } | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 120) return null;
  pruneExpiredCoHostInviteTokens(roomState);

  for (const [candidateToken, invite] of roomState.coHostInviteTokens) {
    if (safeEqual(candidateToken, token)) {
      roomState.coHostInviteTokens.delete(candidateToken);
      return { expiresAt: invite.expiresAt };
    }
  }
  return null;
}

function consumeGuestInviteToken(roomState: RoomState, token: unknown): { expiresAt: number } | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 120) return null;
  pruneExpiredGuestInviteTokens(roomState);

  for (const [candidateToken, invite] of roomState.guestInviteTokens) {
    if (safeEqual(candidateToken, token)) {
      roomState.guestInviteTokens.delete(candidateToken);
      return { expiresAt: invite.expiresAt };
    }
  }
  return null;
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function isValidRecordingSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,120}$/.test(value);
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

  wss.on('connection', (ws: WebSocket, req?: IncomingMessage) => {
    const ip = getUpgradeRequestIp(req);
    if (!socketsPerIp.tryAcquire(ip)) {
      console.warn(`Too many studio connections from ${ip}; refusing another`);
      ws.close(1013, 'Too many connections from this network');
      return;
    }
    socketIps.set(ws, ip);
    console.log('New WebSocket connection');

    // Fix #3: Mark connection as alive on connect and on pong
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;

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
        const parsed = JSON.parse(data.toString());

        // Rate limit per socket. Offers, answers and ICE candidates have their
        // own larger budget so a burst of negotiation is never dropped by chat
        // traffic (or vice versa); the client is told once per window.
        const rate = wsRateLimiter.check(ws, (parsed as { type?: unknown } | null)?.type);
        if (!rate.allowed) {
          if (rate.notify) {
            sendError(
              ws,
              rate.bucket === 'relay'
                ? 'Too many connection messages. Some media negotiation was dropped; it will retry.'
                : 'Too many messages. Please slow down.',
              'RATE_LIMITED'
            );
          }
          return;
        }

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

    ws.on('close', (code: number) => {
      socketsPerIp.release(ip);
      handleDisconnect(ws, code);
    });
  });
}

function handleMessage(ws: WebSocket, message: SignalMessage) {
  switch (message.type) {
    case 'heartbeat': {
      // Lets the browser notice a dead connection (a server restart or a
      // sleeping laptop can leave it looking open) and reconnect quickly.
      const sentAt = Number(message.payload?.sentAt);
      send(ws, { type: 'heartbeat-ack', payload: { sentAt: Number.isFinite(sentAt) ? sentAt : 0, receivedAt: Date.now() } });
      break;
    }
    case 'join-room':
      void handleJoinRoom(ws, message.payload).catch((err) => {
        pendingJoins.delete(ws);
        console.error('Join failed:', err instanceof Error ? err.message : err);
        sendError(ws, 'Could not join the studio. Please try again.', 'JOIN_FAILED');
      });
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      relayToParticipant(ws, message);
      break;
    case 'media-state-changed':
      handleMediaStateChange(ws, message.payload);
      break;
    case 'update-name':
      handleUpdateName(ws, message.payload);
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
    case 'stage-content-updated':
      handleStageContentUpdate(ws, message.payload);
      break;
    case 'recording-state-changed':
      handleRecordingStateChange(ws, message.payload);
      break;
    case 'recording-upload-token-request':
      handleRecordingUploadTokenRequest(ws, message.payload);
      break;
    case 'recording-upload-progress':
      handleRecordingUploadProgress(ws, message.payload);
      break;
    case 'recording-upload-control':
      handleRecordingUploadControl(ws, message.payload);
      break;
    case 'recording-transfer-signal':
      handleRecordingTransferSignal(ws, message.payload);
      break;
    case 'sfu-token-request':
      handleSfuTokenRequest(ws, message.payload);
      break;
    case 'live-stream-state-changed':
      handleLiveStreamStateChange(ws, message.payload);
      break;
    case 'live-stream-token-request':
      handleLiveStreamTokenRequest(ws, message.payload);
      break;
    case 'external-chat-connect':
      handleExternalChatConnect(ws, message.payload);
      break;
    case 'external-chat-disconnect':
      handleExternalChatDisconnect(ws, message.payload);
      break;
    case 'guest-invite-token-request':
      handleGuestInviteTokenRequest(ws, message.payload);
      break;
    case 'co-host-invite-token-request':
      handleCoHostInviteTokenRequest(ws, message.payload);
      break;
    case 'end-room':
      handleEndRoom(ws);
      break;
    case 'cancel-end-room':
      handleCancelEndRoom(ws);
      break;
    default:
      sendError(ws, 'Unknown message type', 'UNKNOWN_TYPE');
  }
}

function isOperatorRole(role: Participant['role'] | undefined): boolean {
  return role === 'host' || role === 'co-host';
}

/** Seats on stage and backstage. Waiting guests do not take one. */
function countAdmittedSeats(roomState: RoomState): number {
  let count = 0;
  for (const entry of roomState.participants.values()) {
    if (entry.participant.status !== 'green-room') count++;
  }
  return count;
}

function countGreenRoom(roomState: RoomState): number {
  let count = 0;
  for (const entry of roomState.participants.values()) {
    if (entry.participant.status === 'green-room') count++;
  }
  return count;
}

function newSecret(): string {
  return randomBytes(24).toString('base64url');
}

function isBannedFromRoom(roomState: RoomState, joinSessionId: string | undefined, ip: string, nowMs: number): boolean {
  if (joinSessionId && roomState.bannedJoinSessionIds.has(joinSessionId)) return true;
  const bannedUntil = roomState.bannedIps.get(ip);
  if (bannedUntil === undefined) return false;
  if (bannedUntil > nowMs) return true;
  roomState.bannedIps.delete(ip);
  return false;
}

function wasRecentlyRemoved(roomState: RoomState, joinSessionId: string | undefined, nowMs: number): boolean {
  if (!joinSessionId) return false;
  const removedAt = roomState.removedJoinSessionIds.get(joinSessionId);
  if (removedAt === undefined) return false;
  if (nowMs - removedAt <= REMOVED_SESSION_TTL_MS) return true;
  roomState.removedJoinSessionIds.delete(joinSessionId);
  return false;
}

function hasRedeemedInvite(roomState: RoomState, joinSessionId: string | undefined, kind: RedeemedInviteKind, nowMs: number): boolean {
  if (!joinSessionId) return false;
  const redeemed = roomState.redeemedInvites.get(joinSessionId);
  if (!redeemed) return false;
  if (redeemed.expiresAt <= nowMs) {
    roomState.redeemedInvites.delete(joinSessionId);
    return false;
  }
  return redeemed.kind === kind;
}

/** Forget the invite links someone created once they lose the right to hand them out. */
function revokeInvitesIssuedBy(roomState: RoomState, participantId: string): void {
  for (const [token, invite] of roomState.coHostInviteTokens) {
    if (invite.issuedBy === participantId) roomState.coHostInviteTokens.delete(token);
  }
  for (const [token, invite] of roomState.guestInviteTokens) {
    if (invite.issuedBy === participantId) roomState.guestInviteTokens.delete(token);
  }
}

/** Count a join attempt that guessed wrong; a socket that keeps guessing is closed. */
function rejectJoinAttempt(ws: WebSocket, message: string, code: string): void {
  sendError(ws, message, code);
  const failures = (failedJoinsBySocket.get(ws) || 0) + 1;
  failedJoinsBySocket.set(ws, failures);
  if (failures >= MAX_FAILED_JOINS_PER_SOCKET) {
    const timer = setTimeout(() => {
      if (!wsToParticipant.has(ws)) ws.close(1008, 'Too many failed join attempts');
    }, 50);
    timer.unref?.();
  }
}

function findResumableEntry(roomState: RoomState, token: unknown): ParticipantEntry | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return undefined;
  for (const entry of roomState.participants.values()) {
    if (safeEqual(entry.resumeToken, token)) return entry;
  }
  return undefined;
}

function issueRestoreTicket(roomState: RoomState): string | undefined {
  const secret = getLiveStreamTokenSecret();
  if (!secret) return undefined;
  const nowMs = Date.now();
  const { room } = roomState;
  try {
    return signRoomRestoreTicket({
      v: 1,
      purpose: 'room-restore',
      room: {
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        settings: room.settings,
        ...(room.hostName ? { hostName: room.hostName } : {}),
        ...(room.scheduledFor ? { scheduledFor: room.scheduledFor } : {}),
        ...(room.registration ? { registration: room.registration } : {}),
      },
      hostTokenHash: hashHostToken(roomState.hostToken),
      watchId: roomState.watchId,
      creatorIp: roomState.creatorIp,
      ...(roomState.passwordHash && roomState.passwordSalt
        ? { passwordHash: roomState.passwordHash, passwordSalt: roomState.passwordSalt }
        : {}),
      iat: nowMs,
      exp: nowMs + ROOM_RESTORE_TICKET_TTL_MS,
    }, secret);
  } catch {
    return undefined;
  }
}

/**
 * The server restarted without a database and forgot this studio. Its host
 * reconnects with the signed ticket it was given: rebuild the studio with the
 * same id, settings, password and watch link, so guests reconnecting a moment
 * later find it again.
 */
function restoreRoomFromTicket(roomId: string, payload: JoinRoomPayload): RoomState | undefined {
  if (payload.role !== 'host' || typeof payload.hostToken !== 'string' || !payload.restoreTicket) return undefined;
  const secret = getLiveStreamTokenSecret();
  if (!secret || rooms.size >= MAX_ROOMS) return undefined;
  const claims = verifyRoomRestoreTicket(payload.restoreTicket, secret, { roomId, hostToken: payload.hostToken });
  if (!claims) return undefined;
  let snapshot: RoomSnapshot;
  try {
    const scheduledAtMs = Date.parse(claims.room.scheduledFor || '');
    snapshot = buildPersistentRoomSnapshot({
      room: {
        id: claims.room.id,
        name: claims.room.name,
        hostId: '',
        coHostIds: [],
        createdAt: claims.room.createdAt,
        status: Number.isFinite(scheduledAtMs) && scheduledAtMs > Date.now() ? 'scheduled' : 'waiting',
        settings: claims.room.settings,
        ...(claims.room.hostName ? { hostName: claims.room.hostName } : {}),
        ...(claims.room.scheduledFor ? { scheduledFor: claims.room.scheduledFor } : {}),
        registration: claims.room.registration || { enabled: false, fields: ['name', 'email'] },
      },
      hostToken: payload.hostToken,
      creatorIp: claims.creatorIp,
      hasBeenJoined: true,
      ...(claims.passwordHash && claims.passwordSalt ? { passwordHash: claims.passwordHash, passwordSalt: claims.passwordSalt } : {}),
      sessionState: { watchId: claims.watchId },
    });
  } catch {
    return undefined;
  }
  const roomState = createRoomStateFromSnapshot(snapshot);
  rooms.set(roomId, roomState);
  indexRoomCreator(roomId, snapshot.creatorIp);
  persistRoomSnapshot(roomId);
  console.log(`Room ${roomId} was rebuilt from its host's restore ticket after a server restart`);
  return roomState;
}

/** Everything a participant needs to (re)build their view of the studio. Waiting guests see only the hosts. */
function sendRoomJoined(ws: WebSocket, roomId: string, roomState: RoomState, entry: ParticipantEntry, resumed = false) {
  const { participant } = entry;
  const admitted = participant.status !== 'green-room';
  const operator = isOperatorRole(participant.role);
  const otherParticipants = Array.from(roomState.participants.values())
    .map((p) => p.participant)
    .filter((p) => p.id !== participant.id && (admitted || isOperatorRole(p.role)));
  const qaQuestions = admitted
    ? Array.from(roomState.qaQuestions.values())
      .filter((q) => operator || q.status === 'approved' || q.status === 'answered')
    : [];
  const polls = admitted
    ? Array.from(roomState.polls.values()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    : [];
  const liveStreamState: LiveStreamStatePayload | undefined = roomState.liveStreamStartedAt
    ? {
        live: true,
        startedAt: roomState.liveStreamStartedAt,
        performedBy: roomState.liveStreamStartedBy || roomState.room.hostId,
      }
    : undefined;
  const restoreTicket = participant.role === 'host' ? issueRestoreTicket(roomState) : undefined;

  send(ws, {
    type: 'room-joined',
    payload: {
      room: roomState.room,
      participant,
      participants: otherParticipants,
      chatMessages: getVisibleChatMessages(roomState, participant, participant.id),
      qaQuestions,
      polls,
      recordingState: roomState.recordingStartedAt
        ? {
            recording: true,
            sessionId: roomState.recordingSessionId,
            paused: Boolean(roomState.recordingPaused),
            startedAt: roomState.recordingStartedAt,
            performedBy: roomState.room.hostId,
          }
        : undefined,
      liveStreamState,
      studioBranding: roomState.studioBranding,
      stageContent: admitted ? roomState.stageContent : undefined,
      stageUploadToken: entry.stageUploadToken,
      ...(admitted && entry.stageReadToken ? { stageReadToken: entry.stageReadToken } : {}),
      resumeToken: entry.resumeToken,
      ...(resumed ? { resumed: true } : {}),
      ...(operator && admitted ? { watchId: roomState.watchId } : {}),
      ...(restoreTicket ? { restoreTicket } : {}),
      features: {
        chatTyping: true,
      },
    },
  });
  if (admitted) sendExternalChatStatuses(ws, roomState);
}

/** Bind a held (or still lingering) seat to a new connection, keeping its participant id, role and place. */
function resumeSeat(ws: WebSocket, roomId: string, roomState: RoomState, entry: ParticipantEntry, ip: string) {
  const oldWs = entry.ws;
  clearResumeTimer(entry);
  if (oldWs !== ws) {
    wsToParticipant.delete(oldWs);
    if (oldWs.readyState === WebSocket.OPEN) {
      // Seen only if the old connection is still alive, i.e. another tab.
      send(oldWs, {
        type: 'participant-removed',
        payload: { reason: 'You joined this studio again from another tab or window.' },
      });
      oldWs.close(4000, 'Seat resumed elsewhere');
    }
  }
  entry.ws = ws;
  entry.ip = ip;
  entry.disconnectedAt = undefined;
  entry.resumeToken = newSecret();
  wsToParticipant.set(ws, { roomId, participantId: entry.participant.id });
  cancelEmptyRoomDeletion(roomId, roomState);
  if (entry.participant.id === roomState.room.hostId) clearHostReconnectTimer(roomState);
  sendRoomJoined(ws, roomId, roomState, entry, true);
  broadcastToRoom(roomId, { type: 'participant-updated', payload: entry.participant }, entry.participant.id);
  console.log(`${entry.participant.name} (${entry.participant.role}) resumed their seat in room ${roomId}`);
}

/** The co-host who stood in for the host goes back to being a co-host. */
function handHostSeatBack(roomId: string, roomState: RoomState, standIn: ParticipantEntry) {
  standIn.participant.role = 'co-host';
  if (!roomState.room.coHostIds.includes(standIn.participant.id)) roomState.room.coHostIds.push(standIn.participant.id);
  roomState.handedOffHostId = undefined;
  broadcastToRoom(roomId, { type: 'participant-updated', payload: standIn.participant });
  console.log(`Host returned to room ${roomId}; ${standIn.participant.name} is a co-host again`);
}

async function handleJoinRoom(ws: WebSocket, payload: JoinRoomPayload) {
  // Duplicate join guard: prevent same WebSocket from joining twice
  if (wsToParticipant.has(ws) || pendingJoins.has(ws)) {
    sendError(ws, 'Already in a room', 'ALREADY_JOINED');
    return;
  }

  // Validate payload field types
  if (!payload || typeof payload.roomId !== 'string' || typeof payload.name !== 'string') {
    sendError(ws, 'Invalid payload types', 'VALIDATION_ERROR');
    return;
  }

  const { roomId } = payload;
  const ip = socketIps.get(ws) || 'unknown';
  const requestedRole: Participant['role'] =
    payload.role === 'host' || payload.role === 'co-host' ? payload.role : 'guest';
  const joinSessionId = normalizeJoinSessionId(payload.joinSessionId);
  // Sanitize and validate participant name
  const name = (typeof payload.name === 'string' ? payload.name : '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, MAX_PARTICIPANT_NAME_LENGTH) || 'Anonymous';
  const roomState = rooms.get(roomId) ?? restoreRoomFromTicket(roomId, payload);

  if (!roomState) {
    sendError(ws, 'Room not found', 'ROOM_NOT_FOUND');
    return;
  }

  // A dropped connection coming back within the grace window keeps its seat:
  // same participant id, role and place, so healthy media stays connected.
  const resumable = findResumableEntry(roomState, payload.resumeToken);
  if (resumable) {
    resumeSeat(ws, roomId, roomState, resumable, ip);
    return;
  }

  const nowMs = Date.now();
  // Bans are checked before any single-use invite is spent.
  if (requestedRole !== 'host' && isBannedFromRoom(roomState, joinSessionId, ip, nowMs)) {
    sendError(ws, 'You have been banned from this studio.', 'PARTICIPANT_BANNED');
    return;
  }

  // Host role requires the secret token returned at room creation.
  let effectiveRole: Participant['role'] = 'guest';
  if (requestedRole === 'host') {
    const presented = typeof payload.hostToken === 'string' ? payload.hostToken : '';
    if (!presented || !safeEqual(presented, roomState.hostToken)) {
      rejectJoinAttempt(ws, 'Host access is missing or expired. Reopen this studio from the creator browser or saved host entry.', 'HOST_TOKEN_INVALID');
      return;
    }
    effectiveRole = 'host';
  }

  // Single-use co-host links. Once redeemed, the same browser keeps the role
  // on later joins (a refresh or reconnect) without the spent token.
  if (requestedRole === 'co-host') {
    const invite = consumeCoHostInviteToken(roomState, payload.coHostInviteToken);
    if (invite) {
      effectiveRole = 'co-host';
      if (joinSessionId) roomState.redeemedInvites.set(joinSessionId, { kind: 'co-host', expiresAt: invite.expiresAt });
    } else if (hasRedeemedInvite(roomState, joinSessionId, 'co-host', nowMs)) {
      effectiveRole = 'co-host';
    } else {
      rejectJoinAttempt(ws, 'Co-host invite link is invalid or expired', 'CO_HOST_INVITE_INVALID');
      return;
    }
  } else if (requestedRole === 'guest' && hasRedeemedInvite(roomState, joinSessionId, 'co-host', nowMs)) {
    // A guest promoted to co-host whose browser still says "guest".
    effectiveRole = 'co-host';
  }

  if (
    effectiveRole === 'guest' &&
    isScheduledGuestAccessBlocked(roomState.room.scheduledFor)
  ) {
    sendError(ws, SCHEDULED_GUEST_ACCESS_MESSAGE, ROOM_NOT_OPEN_ERROR_CODE);
    return;
  }

  let hasSecureGuestAccess = false;
  if (effectiveRole === 'guest') {
    if (payload.guestInviteToken) {
      const invite = consumeGuestInviteToken(roomState, payload.guestInviteToken);
      if (invite) {
        hasSecureGuestAccess = true;
        if (joinSessionId) roomState.redeemedInvites.set(joinSessionId, { kind: 'guest-secure', expiresAt: invite.expiresAt });
      } else if (hasRedeemedInvite(roomState, joinSessionId, 'guest-secure', nowMs)) {
        hasSecureGuestAccess = true;
      } else {
        rejectJoinAttempt(ws, 'Guest invite link is invalid or expired', 'GUEST_INVITE_INVALID');
        return;
      }
    } else {
      hasSecureGuestAccess = hasRedeemedInvite(roomState, joinSessionId, 'guest-secure', nowMs);
    }
  }

  if (roomState.room.settings.passwordProtected && effectiveRole === 'guest' && !hasSecureGuestAccess) {
    // Host-issued secure guest links bypass only the room password. Guests still
    // enter the green room and must be admitted by an operator.
    if (typeof payload.roomPassword !== 'string' || payload.roomPassword.trim().length === 0) {
      sendError(ws, 'This room requires a password', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    const lockedForMs = passwordAttempts.lockedForMs(roomId, ip, nowMs);
    if (lockedForMs > 0) {
      sendError(ws, `Too many incorrect passwords. Try again in ${Math.ceil(lockedForMs / 1000)} seconds.`, 'ROOM_PASSWORD_LOCKED');
      return;
    }
    pendingJoins.add(ws);
    let passwordOk = false;
    try {
      passwordOk = await verifyRoomPassword(roomState, payload.roomPassword);
    } finally {
      pendingJoins.delete(ws);
    }
    // The studio or the connection may have gone while the password was checked.
    if (rooms.get(roomId) !== roomState || ws.readyState !== WebSocket.OPEN || wsToParticipant.has(ws)) return;
    if (!passwordOk) {
      const lockoutMs = passwordAttempts.recordFailure(roomId, ip);
      rejectJoinAttempt(
        ws,
        lockoutMs > 0
          ? `Incorrect room password. Too many attempts: try again in ${Math.ceil(lockoutMs / 1000)} seconds.`
          : 'Incorrect room password',
        lockoutMs > 0 ? 'ROOM_PASSWORD_LOCKED' : 'ROOM_PASSWORD_INVALID'
      );
      return;
    }
    passwordAttempts.recordSuccess(roomId, ip);
  }

  // Everything is authorized from here on.
  let hostHandedBack = false;
  if (effectiveRole === 'host') {
    const existingHostId = roomState.room.hostId;
    const existingHost = existingHostId ? roomState.participants.get(existingHostId) : undefined;
    if (existingHost) {
      if (roomState.handedOffHostId === existingHostId) {
        // A co-host stood in while the host was away; they become a co-host again.
        handHostSeatBack(roomId, roomState, existingHost);
        hostHandedBack = true;
      } else if (existingHost.disconnectedAt !== undefined) {
        // The host's own seat, held after a dropped connection: take it back as is.
        resumeSeat(ws, roomId, roomState, existingHost, ip);
        return;
      } else {
        replaceExistingHostSession(roomId, roomState, existingHostId);
      }
    }
  }

  // The same browser joining again while its old connection lingers (a
  // connection that died without closing, or a reload) replaces it and keeps
  // its place. Someone the host removed always goes back to the green room.
  const removed = wasRecentlyRemoved(roomState, joinSessionId, nowMs);
  let returningStatus: ParticipantStatus | undefined;
  if (effectiveRole !== 'host' && joinSessionId) {
    for (const [existingId, existing] of roomState.participants) {
      if (existing.joinSessionId !== joinSessionId || existing.participant.role === 'host') continue;
      returningStatus = existing.participant.status === 'green-room' ? undefined : existing.participant.status;
      replaceGuestSession(roomId, roomState, existingId);
      break;
    }
    if (effectiveRole === 'guest') {
      returningStatus ??= getReturningGuestStatus(roomState.recentGuestSessions?.get(joinSessionId), nowMs);
    }
    roomState.recentGuestSessions?.delete(joinSessionId);
    if (removed) returningStatus = undefined;
  }

  let status: ParticipantStatus;
  if (effectiveRole === 'host') {
    status = 'on-stage';
  } else if (effectiveRole === 'co-host') {
    status = returningStatus ?? (roomState.room.settings.coHostsJoinOnStage ? 'on-stage' : 'backstage');
  } else if (removed) {
    status = 'green-room';
  } else if (returningStatus) {
    status = returningStatus;
  } else {
    status = roomState.room.settings.greenRoomEnabled ? 'green-room' : 'on-stage';
  }

  // The host always gets a seat. Everyone else needs a free stage/backstage
  // seat, or waits in the green room, which has its own small cap.
  if (effectiveRole !== 'host') {
    const maxSeats = roomState.room.settings.maxParticipants;
    if (status !== 'green-room' && countAdmittedSeats(roomState) >= maxSeats) {
      if (effectiveRole !== 'guest') {
        sendError(ws, `Room is full (max ${maxSeats} participants)`, 'ROOM_FULL');
        return;
      }
      status = 'green-room';
    }
    if (status === 'green-room' && countGreenRoom(roomState) >= MAX_GREEN_ROOM_PARTICIPANTS) {
      sendError(ws, 'The waiting room is full right now. Please try again in a few minutes.', 'ROOM_FULL');
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
    status,
  };

  if (effectiveRole === 'host') {
    if (roomState.hostReconnectTimer) console.log(`Host returned to room ${roomId}; keeping it open.`);
    clearHostReconnectTimer(roomState);
    roomState.room.hostId = participant.id;
  } else if (effectiveRole === 'co-host') {
    roomState.room.coHostIds.push(participant.id);
  }

  cancelEmptyRoomDeletion(roomId, roomState);

  const entry: ParticipantEntry = {
    participant,
    ws,
    joinSessionId,
    stageUploadToken: isOperatorRole(effectiveRole) ? newSecret() : undefined,
    stageReadToken: status !== 'green-room' ? newSecret() : undefined,
    ip,
    resumeToken: newSecret(),
  };
  roomState.participants.set(participant.id, entry);
  wsToParticipant.set(ws, { roomId, participantId: participant.id });
  failedJoinsBySocket.delete(ws);
  roomState.hasBeenJoined = true;
  persistRoomSnapshot(roomId);

  sendRoomJoined(ws, roomId, roomState, entry);

  // Notify existing participants about the new one
  broadcastToRoom(roomId, {
    type: 'participant-joined',
    payload: participant,
  }, participant.id);
  if (hostHandedBack) {
    broadcastToRoom(roomId, {
      type: 'host-changed',
      payload: { newHostId: participant.id, newHostName: participant.name },
    });
  }

  console.log(`${name} (${effectiveRole}) joined room ${roomId} as ${participant.status} [${roomState.participants.size} participants]`);
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

  // Admitting someone from the green room, or making them a co-host, gives
  // them a view of the studio they did not have: send them a fresh snapshot.
  let resyncTarget = false;
  switch (payload.action) {
    case 'move-to-stage':
    case 'move-to-backstage': {
      const admitting = target.participant.status === 'green-room';
      const maxSeats = roomState.room.settings.maxParticipants;
      if (admitting && countAdmittedSeats(roomState) >= maxSeats) {
        sendError(ws, `The studio is full (${maxSeats} people on stage and backstage). Move someone out first.`, 'ROOM_FULL');
        return;
      }
      if (payload.action === 'move-to-stage') {
        target.participant.status = 'on-stage';
        notifyMediaServerSfuMembership('allow-participant', mapping.roomId, target.participant.id);
      } else {
        target.participant.status = 'backstage';
        target.participant.screenSharing = false;
        notifyMediaServerSfuMembership('revoke-participant', mapping.roomId, target.participant.id, 'Moved to backstage');
      }
      if (admitting) {
        target.stageReadToken ??= newSecret();
        resyncTarget = true;
      }
      break;
    }
    case 'move-to-green-room':
      target.participant.status = 'green-room';
      target.participant.screenSharing = false;
      target.stageReadToken = undefined;
      notifyMediaServerSfuMembership('revoke-participant', mapping.roomId, target.participant.id, 'Moved to green room');
      break;
    case 'promote-co-host':
      target.participant.role = 'co-host';
      if (!roomState.room.coHostIds.includes(target.participant.id)) {
        roomState.room.coHostIds.push(target.participant.id);
      }
      // Kept for this browser, so a reconnect or refresh stays a co-host.
      if (target.joinSessionId) {
        roomState.redeemedInvites.set(target.joinSessionId, { kind: 'co-host', expiresAt: Date.now() + CO_HOST_INVITE_TOKEN_TTL_MS });
      }
      target.stageUploadToken ??= newSecret();
      resyncTarget = target.participant.status !== 'green-room';
      break;
    case 'demote-to-guest':
      target.participant.role = 'guest';
      roomState.room.coHostIds = roomState.room.coHostIds.filter(
        (id) => id !== target.participant.id
      );
      target.stageUploadToken = undefined;
      if (target.joinSessionId && roomState.redeemedInvites.get(target.joinSessionId)?.kind === 'co-host') {
        roomState.redeemedInvites.delete(target.joinSessionId);
      }
      // Invite links they created stop working with their authority.
      revokeInvitesIssuedBy(roomState, target.participant.id);
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
    case 'ban': {
      const banned = payload.action === 'ban';
      const reason = banned ? 'Banned by host' : 'Removed by host';
      const nowMs = Date.now();
      // A removed person does not get their old seat back through the
      // returning-guest path, nor keep a redeemed invite; a banned one is
      // also refused by browser session and by network address.
      if (target.joinSessionId) {
        roomState.recentGuestSessions?.delete(target.joinSessionId);
        roomState.removedJoinSessionIds.set(target.joinSessionId, nowMs);
        roomState.redeemedInvites.delete(target.joinSessionId);
        if (banned) roomState.bannedJoinSessionIds.add(target.joinSessionId);
      }
      if (banned && target.ip && target.ip !== 'unknown') {
        roomState.bannedIps.set(target.ip, nowMs + BANNED_IP_TTL_MS);
      }
      revokeInvitesIssuedBy(roomState, target.participant.id);
      notifyMediaServerSfuMembership('revoke-recording-upload', mapping.roomId, target.participant.id, reason);
      send(target.ws, {
        type: 'participant-removed',
        payload: { reason },
      });
      const targetWs = target.ws;
      // Leave now, without the reconnect grace a dropped connection gets.
      finalizeDeparture(mapping.roomId, roomState, target.participant.id, reason);
      targetWs.close(1000, reason);
      console.log(`Stage action: ${payload.action} on ${target.participant.name} by ${performer.participant.name}`);
      return;
    }
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

  if (resyncTarget) sendRoomJoined(target.ws, mapping.roomId, roomState, target);
  persistRoomSnapshot(mapping.roomId);

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
  persistRoomSnapshot(mapping.roomId);

  broadcastToRoom(mapping.roomId, {
    type: 'studio-branding-updated',
    payload: branding,
  });
}

function normalizeStageContent(payload: unknown, roomState: RoomState): StageContentPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { media?: unknown; layout?: unknown; contentHidden?: unknown };
  const layout = typeof raw.layout === 'string' && STAGE_LAYOUTS.has(raw.layout as LayoutMode)
    ? raw.layout as LayoutMode
    : undefined;
  const hidden = raw.contentHidden === true ? { contentHidden: true } : {};
  if (raw.media === null || raw.media === undefined) return { media: null, ...(layout ? { layout } : {}), ...hidden };
  if (typeof raw.media !== 'object') return null;
  const media = raw.media as Record<string, unknown>;
  const id = typeof media.id === 'string' ? media.id.slice(0, 128) : '';
  const type = media.type as StudioMediaType;
  const name = typeof media.name === 'string' ? media.name.slice(0, 200) : '';
  if (!id || !STAGE_MEDIA_TYPES.has(type)) return null;
  const imageId = typeof media.imageId === 'string' && roomState.stageImages?.has(media.imageId) ? media.imageId : undefined;
  const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000 ? value : undefined);
  const normalized: StageContentMedia = {
    id,
    type,
    name,
    ...(imageId ? { imageId } : {}),
    ...(count(media.slideIndex) !== undefined ? { slideIndex: count(media.slideIndex) } : {}),
    ...(count(media.slideCount) !== undefined ? { slideCount: count(media.slideCount) } : {}),
  };
  return { media: normalized, ...(layout ? { layout } : {}), ...hidden };
}

function handleStageContentUpdate(ws: WebSocket, payload: StageContentPayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;
  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;
  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can change what is on stage', 'UNAUTHORIZED');
    return;
  }
  const content = normalizeStageContent(payload, roomState);
  if (!content) {
    sendError(ws, 'Invalid stage content', 'INVALID_PAYLOAD');
    return;
  }
  roomState.stageContent = content;
  broadcastToRoom(mapping.roomId, { type: 'stage-content-updated', payload: content }, mapping.participantId);
}

export type StoreStageImageResult =
  | { ok: true; imageId: string }
  | { ok: false; status: number; error: string };

/** Keep a picture of what a host or co-host has on stage, for guests to load. */
export function storeStageImage(input: {
  roomId: string;
  participantId: string;
  token: string;
  contentType: string;
  data: Buffer;
}): StoreStageImageResult {
  const roomState = rooms.get(input.roomId);
  if (!roomState) return { ok: false, status: 404, error: 'Studio not found' };
  const entry = roomState.participants.get(input.participantId);
  const expected = entry?.stageUploadToken;
  const matches = Boolean(expected)
    && expected!.length === input.token.length
    && timingSafeEqual(Buffer.from(expected!), Buffer.from(input.token));
  if (!matches) return { ok: false, status: 403, error: 'Not allowed to update the stage' };
  const contentType = input.contentType.split(';')[0].trim().toLowerCase();
  if (!STAGE_IMAGE_CONTENT_TYPES.has(contentType)) return { ok: false, status: 415, error: 'Stage images must be JPEG, PNG, or WebP' };
  if (input.data.length === 0 || input.data.length > STAGE_IMAGE_MAX_BYTES) {
    return { ok: false, status: 413, error: 'Stage image is too large' };
  }
  const images = roomState.stageImages ?? (roomState.stageImages = new Map());
  const imageId = randomBytes(16).toString('base64url');
  images.set(imageId, { data: input.data, contentType, createdAt: Date.now() });
  // Evict the oldest pictures, never the one on stage or the one just added.
  const onStage = roomState.stageContent?.media?.imageId;
  let totalBytes = 0;
  for (const image of images.values()) totalBytes += image.data.length;
  for (const [id, image] of images) {
    if (images.size <= STAGE_IMAGE_LIMIT_PER_ROOM && totalBytes <= STAGE_IMAGE_BYTES_PER_ROOM) break;
    if (id === onStage || id === imageId) continue;
    images.delete(id);
    totalBytes -= image.data.length;
  }
  return { ok: true, imageId };
}

export function getStageImage(roomId: string, imageId: string): StageImage | undefined {
  return rooms.get(roomId)?.stageImages?.get(imageId);
}

function tokenMatches(expected: string | undefined, presented: string): boolean {
  if (!expected || expected.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

export type ReadStageImageResult =
  | { ok: true; image: StageImage }
  | { ok: false; status: 403 | 404 };

/**
 * A stage picture for an admitted participant of the studio. Waiting guests
 * (and anyone holding only the room id) cannot read what is on stage.
 */
export function readStageImage(roomId: string, imageId: string, token: string): ReadStageImageResult {
  const roomState = rooms.get(roomId);
  if (!roomState) return { ok: false, status: 404 };
  const authorized = Boolean(token) && Array.from(roomState.participants.values()).some((entry) => (
    entry.participant.status !== 'green-room'
    && (tokenMatches(entry.stageReadToken, token) || tokenMatches(entry.stageUploadToken, token))
  ));
  if (!authorized) return { ok: false, status: 403 };
  const image = roomState.stageImages?.get(imageId);
  return image ? { ok: true, image } : { ok: false, status: 404 };
}

/** Public facts about the studio behind a watch-page id, for the watch page. Never the participant list. */
export function findRoomByWatchId(watchId: string): Room | undefined {
  if (typeof watchId !== 'string' || !/^[A-Za-z0-9_-]{12,64}$/.test(watchId)) return undefined;
  for (const roomState of rooms.values()) {
    if (roomState.watchId.length === watchId.length && safeEqual(roomState.watchId, watchId)) return roomState.room;
  }
  return undefined;
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
  if (payload.recording) {
    const requestedSessionId = isValidRecordingSessionId(payload.sessionId) ? payload.sessionId : undefined;
    if (roomState.recordingStartedAt && requestedSessionId && requestedSessionId !== roomState.recordingSessionId) {
      sendError(ws, 'A different recording session is already active', 'RECORDING_ALREADY_ACTIVE');
      return;
    }
    roomState.recordingSessionId = roomState.recordingSessionId && roomState.recordingStartedAt
      ? roomState.recordingSessionId
      : requestedSessionId || `recording-${nanoid(20)}`;
    roomState.recordingStartedAt = roomState.recordingStartedAt || now;
    roomState.recordingPaused = Boolean(payload.paused);
  } else {
    // After a restart the server may not know the session; the operator's
    // stop names it, so guests still finalize and upload their takes.
    const requestedSessionId = isValidRecordingSessionId(payload.sessionId) ? payload.sessionId : undefined;
    roomState.recordingSessionId ??= requestedSessionId;
    roomState.recordingStartedAt = undefined;
    roomState.recordingPaused = false;
  }

  const authoritativePayload: RecordingStatePayload = {
    recording: payload.recording,
    sessionId: roomState.recordingSessionId,
    paused: payload.recording ? Boolean(roomState.recordingPaused) : false,
    performedBy: mapping.participantId,
    ...(payload.recording ? { startedAt: roomState.recordingStartedAt } : { stoppedAt: now }),
  };
  updateRoomActivityStatus(roomState);
  persistRoomSnapshot(mapping.roomId);

  broadcastToRoom(mapping.roomId, {
    type: 'recording-state-changed',
    payload: authoritativePayload,
  });
}

function handleRecordingUploadTokenRequest(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'recording-upload-token-request' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  if (!isValidRequestId(payload.requestId) || !isValidRecordingSessionId(payload.sessionId)) {
    sendError(ws, 'Invalid recording upload token request', 'VALIDATION_ERROR');
    return;
  }

  const roomState = rooms.get(mapping.roomId);
  const participantEntry = roomState?.participants.get(mapping.participantId);
  if (!roomState || !participantEntry) return;
  if (participantEntry.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before recording', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }
  if (roomState.recordingSessionId !== payload.sessionId) {
    sendError(ws, 'Recording upload session does not match this studio', 'RECORDING_SESSION_MISMATCH');
    return;
  }

  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    sendError(ws, 'Recording uploads are not configured on this server', 'LIVE_STREAM_NOT_CONFIGURED');
    return;
  }

  const expiresAtMs = Date.now() + RECORDING_UPLOAD_TOKEN_TTL_MS;
  const claims: RecordingUploadTokenClaims = {
    v: 1,
    purpose: 'recording-upload',
    roomId: mapping.roomId,
    participantId: mapping.participantId,
    participantName: participantEntry.participant.name,
    role: participantEntry.participant.role,
    sessionId: payload.sessionId,
    iat: Date.now(),
    exp: expiresAtMs,
    nonce: nanoid(16),
  };

  send(ws, {
    type: 'recording-upload-token-issued',
    payload: {
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      token: signMediaToken(claims, secret),
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  });
}

function isRoomOperator(participant: Participant): boolean {
  return (participant.role === 'host' || participant.role === 'co-host') && participant.status !== 'green-room';
}

function normalizeUploadByteCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_RECORDING_UPLOAD_REPORT_BYTES) {
    return null;
  }
  return value;
}

function normalizeUploadTrackCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_RECORDING_UPLOAD_REPORT_TRACKS) {
    return null;
  }
  return value;
}

/** Relay a participant's background upload progress to hosts and co-hosts only. */
function handleRecordingUploadProgress(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'recording-upload-progress' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  const sender = roomState?.participants.get(mapping.participantId);
  if (!roomState || !sender) return;
  if (sender.participant.status === 'green-room') return;

  if (!isRecord(payload) || !isValidRecordingSessionId(payload.sessionId)) {
    sendError(ws, 'Invalid recording upload progress', 'VALIDATION_ERROR');
    return;
  }
  // Reports for an older take are ignored rather than rejected: a participant
  // can still be finishing a previous upload when the host starts a new take.
  if (roomState.recordingSessionId !== payload.sessionId) return;

  const recordedBytes = normalizeUploadByteCount(payload.recordedBytes);
  const uploadedBytes = normalizeUploadByteCount(payload.uploadedBytes);
  const trackCount = normalizeUploadTrackCount(payload.trackCount);
  const completedTrackCount = normalizeUploadTrackCount(payload.completedTrackCount);
  if (
    recordedBytes === null ||
    uploadedBytes === null ||
    trackCount === null ||
    completedTrackCount === null ||
    completedTrackCount > trackCount ||
    !RECORDING_UPLOAD_PROGRESS_STATUSES.includes(payload.status)
  ) {
    sendError(ws, 'Invalid recording upload progress', 'VALIDATION_ERROR');
    return;
  }

  const message = typeof payload.message === 'string'
    ? payload.message.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, MAX_RECORDING_UPLOAD_REPORT_MESSAGE_LENGTH)
    : '';
  const authoritativePayload: RecordingUploadProgressPayload = {
    sessionId: payload.sessionId,
    participantId: mapping.participantId,
    participantName: sender.participant.name,
    status: payload.status,
    recordedBytes,
    uploadedBytes: Math.min(uploadedBytes, recordedBytes),
    trackCount,
    completedTrackCount,
    ...(message ? { message } : {}),
    updatedAt: new Date().toISOString(),
  };

  for (const [id, entry] of roomState.participants) {
    if (id === mapping.participantId || !isRoomOperator(entry.participant)) continue;
    send(entry.ws, { type: 'recording-upload-progress', payload: authoritativePayload });
  }
}

/** Let hosts and co-hosts pause a participant's background upload to free their bandwidth. */
function handleRecordingUploadControl(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'recording-upload-control' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  const performer = roomState?.participants.get(mapping.participantId);
  if (!roomState || !performer) return;
  if (!isRoomOperator(performer.participant)) {
    sendError(ws, 'Only hosts and co-hosts can control recording uploads', 'UNAUTHORIZED');
    return;
  }
  if (
    !isRecord(payload) ||
    typeof payload.targetParticipantId !== 'string' ||
    (payload.action !== 'pause' && payload.action !== 'resume')
  ) {
    sendError(ws, 'Invalid recording upload control', 'VALIDATION_ERROR');
    return;
  }

  const target = roomState.participants.get(payload.targetParticipantId);
  if (!target) return;
  send(target.ws, {
    type: 'recording-upload-control',
    payload: {
      targetParticipantId: target.participant.id,
      action: payload.action,
      performedBy: mapping.participantId,
    },
  });
}

const RECORDING_TRANSFER_SIGNAL_KINDS = new Set(['invite', 'offer', 'answer', 'hangup']);
const RECORDING_TRANSFER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Relay peer-to-peer recording transfer signaling between one participant and
 * the room's operators only. Guests can never reach each other this way, only
 * operators may invite, and the sender is stamped by the server.
 */
function handleRecordingTransferSignal(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'recording-transfer-signal' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;
  const roomState = rooms.get(mapping.roomId);
  const sender = roomState?.participants.get(mapping.participantId);
  if (!roomState || !sender) return;

  if (
    !isRecord(payload) ||
    typeof payload.targetParticipantId !== 'string' ||
    typeof payload.transferId !== 'string' ||
    !RECORDING_TRANSFER_ID_PATTERN.test(payload.transferId) ||
    !RECORDING_TRANSFER_SIGNAL_KINDS.has(payload.kind) ||
    (payload.sessionId !== undefined && !isValidRecordingSessionId(payload.sessionId)) ||
    (payload.sdp !== undefined && (typeof payload.sdp !== 'string' || payload.sdp.length > MAX_RECORDING_TRANSFER_SDP_LENGTH)) ||
    ((payload.kind === 'offer' || payload.kind === 'answer') && typeof payload.sdp !== 'string')
  ) {
    sendError(ws, 'Invalid recording transfer signal', 'VALIDATION_ERROR');
    return;
  }

  const target = roomState.participants.get(payload.targetParticipantId);
  if (!target || target === sender) return;
  const senderIsOperator = isRoomOperator(sender.participant);
  const targetIsOperator = isRoomOperator(target.participant);
  // Exactly one side must be an operator: participant <-> host/co-host only.
  if (senderIsOperator === targetIsOperator || (payload.kind === 'invite' && !senderIsOperator)) {
    sendError(ws, 'Recording transfers connect participants with hosts only', 'UNAUTHORIZED');
    return;
  }

  const options = isRecord(payload.options)
    ? {
        ...(typeof payload.options.losslessAudio === 'boolean' ? { losslessAudio: payload.options.losslessAudio } : {}),
        ...(typeof payload.options.cloudUpload === 'boolean' ? { cloudUpload: payload.options.cloudUpload } : {}),
      }
    : undefined;
  send(target.ws, {
    type: 'recording-transfer-signal',
    payload: {
      targetParticipantId: target.participant.id,
      fromParticipantId: mapping.participantId,
      transferId: payload.transferId,
      kind: payload.kind,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(typeof payload.sdp === 'string' ? { sdp: payload.sdp } : {}),
      ...(options && senderIsOperator ? { options } : {}),
    },
  });
}

function handleSfuTokenRequest(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'sfu-token-request' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;
  if (!isValidRequestId(payload.requestId)) {
    sendError(ws, 'Invalid SFU token request', 'VALIDATION_ERROR');
    return;
  }

  const roomState = rooms.get(mapping.roomId);
  const participantEntry = roomState?.participants.get(mapping.participantId);
  if (!roomState || !participantEntry) return;
  if (participantEntry.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before connecting to studio media', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }
  if (participantEntry.participant.status !== 'on-stage') {
    sendError(ws, 'Move to the live stage before connecting to SFU media', 'PARTICIPANT_OFF_STAGE');
    return;
  }

  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    sendError(ws, 'SFU media is not configured on this server', 'SFU_NOT_CONFIGURED');
    return;
  }

  const nowMs = Date.now();
  const expiresAtMs = nowMs + SFU_TOKEN_TTL_MS;
  const claims: SfuTokenClaims = {
    v: 1,
    purpose: 'sfu',
    roomId: mapping.roomId,
    participantId: mapping.participantId,
    role: participantEntry.participant.role,
    iat: nowMs,
    exp: expiresAtMs,
    nonce: nanoid(16),
  };
  notifyMediaServerSfuMembership('allow-participant', mapping.roomId, mapping.participantId);
  send(ws, {
    type: 'sfu-token-issued',
    payload: {
      requestId: payload.requestId,
      token: signMediaToken(claims, secret),
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  });
}

const MAX_RESUMED_BROADCAST_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A host whose studio connection dropped mid-broadcast rejoins still live;
 * the server forgot the broadcast when they disconnected. Keep its original
 * start time so everyone's live timer carries on instead of restarting.
 */
export function getResumedLiveStartedAt(value: unknown, nowMs: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const startedAtMs = Date.parse(value);
  if (!Number.isFinite(startedAtMs)) return undefined;
  if (startedAtMs > nowMs || nowMs - startedAtMs > MAX_RESUMED_BROADCAST_AGE_MS) return undefined;
  return new Date(startedAtMs).toISOString();
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
  const startedAt = payload.live
    ? roomState.liveStreamStartedAt || getResumedLiveStartedAt(payload.startedAt, Date.now()) || now
    : undefined;
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
  persistRoomSnapshot(mapping.roomId);

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
    watchId: roomState.watchId,
    iat: Date.now(),
    exp: expiresAtMs,
    nonce: nanoid(16),
  };

  send(ws, {
    type: 'live-stream-token-issued',
    payload: {
      requestId: payload.requestId,
      token: signMediaToken(claims, secret),
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

function handleGuestInviteTokenRequest(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'guest-invite-token-request' }>['payload']
) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  if (!isValidRequestId(payload.requestId)) {
    sendError(ws, 'Invalid guest invite request', 'VALIDATION_ERROR');
    return;
  }

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can create guest invites', 'UNAUTHORIZED');
    return;
  }
  if (performer.participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before creating guest invites', 'PARTICIPANT_NOT_ADMITTED');
    return;
  }

  const now = Date.now();
  pruneExpiredGuestInviteTokens(roomState, now);

  while (roomState.guestInviteTokens.size >= MAX_GUEST_INVITE_TOKENS_PER_ROOM) {
    const oldestToken = roomState.guestInviteTokens.keys().next().value;
    if (!oldestToken) break;
    roomState.guestInviteTokens.delete(oldestToken);
  }

  const token = nanoid(32);
  const expiresAtMs = now + GUEST_INVITE_TOKEN_TTL_MS;
  roomState.guestInviteTokens.set(token, {
    expiresAt: expiresAtMs,
    issuedBy: mapping.participantId,
    createdAt: now,
  });

  send(ws, {
    type: 'guest-invite-token-issued',
    payload: {
      requestId: payload.requestId,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  });
}

function hasValidPeerConnectionRef(p: Record<string, unknown>): boolean {
  if (p.pcId !== undefined && (typeof p.pcId !== 'string' || !PC_ID_PATTERN.test(p.pcId))) return false;
  if (p.toPcId !== undefined && (typeof p.toPcId !== 'string' || !PC_ID_PATTERN.test(p.toPcId))) return false;
  return true;
}

function isValidSdpPayload(payload: unknown): payload is { to: string; sdp: { type: string; sdp: string } } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.to !== 'string') return false;
  if (!hasValidPeerConnectionRef(p)) return false;
  if (!p.sdp || typeof p.sdp !== 'object') return false;
  const sdp = p.sdp as Record<string, unknown>;
  // RTCSessionDescriptionInit requires .type ('offer' | 'answer' | 'pranswer' | 'rollback'); .sdp is optional only for rollback.
  if (typeof sdp.type !== 'string') return false;
  if (!['offer', 'answer', 'pranswer', 'rollback'].includes(sdp.type)) return false;
  if (sdp.sdp !== undefined && (typeof sdp.sdp !== 'string' || sdp.sdp.length > MAX_RELAYED_SDP_LENGTH)) return false;
  return true;
}

function isValidIcePayload(payload: unknown): payload is { to: string; candidate: Record<string, unknown> } {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.to !== 'string') return false;
  if (!hasValidPeerConnectionRef(p)) return false;
  // candidate may be null (end-of-candidates) or an object with .candidate/.sdpMid/.sdpMLineIndex
  if (p.candidate === null) return true;
  if (!p.candidate || typeof p.candidate !== 'object') return false;
  const c = p.candidate as Record<string, unknown>;
  if (c.candidate !== undefined && (typeof c.candidate !== 'string' || c.candidate.length > MAX_RELAYED_CANDIDATE_LENGTH)) return false;
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

  const screenStreamId = screenSharing && typeof payload.screenStreamId === 'string' && /^[\w-]{1,80}$/.test(payload.screenStreamId)
    ? payload.screenStreamId
    : undefined;
  const authoritativePayload: MediaStatePayload = {
    participantId: mapping.participantId,
    audioEnabled: payload.audioEnabled,
    videoEnabled: payload.videoEnabled,
    screenSharing,
    ...(screenStreamId ? { screenStreamId } : {}),
  };

  broadcastToRoom(mapping.roomId, {
    type: 'media-state-changed',
    payload: authoritativePayload,
  }, mapping.participantId);
}

/** A participant changes their own display name; everyone gets the updated participant. */
function handleUpdateName(ws: WebSocket, payload: UpdateNamePayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;
  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;
  const entry = roomState.participants.get(mapping.participantId);
  if (!entry) return;

  const name = sanitizeParticipantName(payload?.name);
  if (!name) {
    sendError(ws, 'Enter a name to use in the studio', 'VALIDATION_ERROR');
    return;
  }
  if (name === entry.participant.name) return;
  entry.participant.name = name;
  broadcastToRoom(mapping.roomId, { type: 'participant-updated', payload: entry.participant });
}

/** Trim, strip control characters, and cap the length; empty when nothing usable remains. */
export function sanitizeParticipantName(value: unknown): string {
  return (typeof value === 'string' ? value : '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, MAX_PARTICIPANT_NAME_LENGTH);
}

/** Whether `participantId` names a host or co-host in the room. */
function isOperatorParticipant(roomState: RoomState, participantId: unknown): boolean {
  if (typeof participantId !== 'string' || !participantId.trim()) return false;
  const role = roomState.participants.get(participantId.trim())?.participant.role;
  return role === 'host' || role === 'co-host';
}

function canSeeChatMessage(message: ChatMessage, participant: Participant, participantId: string): boolean {
  // Waiting guests see only their own private conversation with the hosts.
  if (participant.status === 'green-room') {
    return participantId === message.senderId || participantId === message.recipientId;
  }
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

function normalizeExternalChatPlatform(value: unknown): ExternalChatPlatform | null {
  return value === 'youtube' || value === 'facebook' ? value : null;
}

function getYouTubeLiveChatApiKey(): string {
  return normalizeYouTubeApiKey(
    process.env.YOUTUBE_API_KEY ||
    process.env.YOUTUBE_LIVE_CHAT_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  );
}

function getFacebookLiveCommentsAccessToken(): string {
  return normalizeFacebookAccessToken(
    process.env.FACEBOOK_ACCESS_TOKEN ||
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    process.env.FACEBOOK_LIVE_COMMENTS_ACCESS_TOKEN ||
    ''
  );
}

function getFacebookCommentsPollIntervalMs(): number | undefined {
  const parsed = Number.parseInt(String(process.env.FACEBOOK_COMMENTS_POLL_INTERVAL_MS || ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getExternalChatPlatformLabel(platform: ExternalChatPlatform): string {
  return platform === 'youtube' ? 'YouTube' : 'Facebook';
}

function getExternalChatOperator(
  ws: WebSocket,
  unauthorizedMessage: string
): { roomId: string; roomState: RoomState; participantId: string; participant: Participant } | null {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return null;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return null;

  const participant = roomState.participants.get(mapping.participantId)?.participant;
  if (!participant) return null;

  if (participant.role !== 'host' && participant.role !== 'co-host') {
    sendError(ws, unauthorizedMessage, 'UNAUTHORIZED');
    return null;
  }
  if (participant.status === 'green-room') {
    sendError(ws, 'Wait until you are admitted before managing external chat', 'PARTICIPANT_NOT_ADMITTED');
    return null;
  }

  return {
    roomId: mapping.roomId,
    roomState,
    participantId: mapping.participantId,
    participant,
  };
}

function setExternalChatStatus(
  roomId: string,
  roomState: RoomState,
  connection: ExternalChatConnectionState,
  update: Omit<ExternalChatStatusPayload, 'platform'>
) {
  connection.status = {
    platform: connection.platform,
    liveChatId: connection.liveChatId,
    ...update,
  };
  broadcastToRoom(roomId, {
    type: 'external-chat-status',
    payload: connection.status,
  });
}

function sendExternalChatStatuses(ws: WebSocket, roomState: RoomState) {
  for (const connection of roomState.externalChatConnections.values()) {
    send(ws, {
      type: 'external-chat-status',
      payload: connection.status,
    });
  }
}

function stopExternalChatConnection(
  roomId: string,
  roomState: RoomState,
  platform: ExternalChatPlatform,
  broadcastStatus = true
) {
  const connection = roomState.externalChatConnections.get(platform);
  if (!connection) return;
  connection.stopped = true;
  if (connection.timer) {
    clearTimeout(connection.timer);
    connection.timer = undefined;
  }
  roomState.externalChatConnections.delete(platform);
  if (broadcastStatus) {
    broadcastToRoom(roomId, {
      type: 'external-chat-status',
      payload: {
        platform,
        status: 'idle',
        message: `${getExternalChatPlatformLabel(platform)} chat disconnected.`,
      },
    });
  }
}

function stopAllExternalChatConnections(roomId: string, roomState: RoomState, broadcastStatus = true) {
  for (const platform of Array.from(roomState.externalChatConnections.keys())) {
    stopExternalChatConnection(roomId, roomState, platform, broadcastStatus);
  }
}

function toExternalChatMessage(message: YouTubeLiveChatMessage | FacebookLiveComment): ChatMessage {
  const platform = message.source.platform;
  return {
    id: `${platform}-${nanoid(10)}`,
    senderId: `external:${platform}:${message.source.externalId}`,
    senderName: message.authorName,
    content: message.content,
    timestamp: message.publishedAt,
    isBackstage: false,
    source: message.source,
  };
}

async function pollYouTubeLiveChat(
  roomId: string,
  roomState: RoomState,
  connection: ExternalChatConnectionState,
  apiKey: string
) {
  if (connection.polling || connection.stopped) return;
  connection.polling = true;

  try {
    const result = await fetchYouTubeLiveChatMessages({
      apiKey,
      liveChatId: connection.liveChatId,
      pageToken: connection.nextPageToken,
    });
    if (connection.stopped || roomState.externalChatConnections.get('youtube') !== connection) return;

    connection.nextPageToken = result.nextPageToken || connection.nextPageToken;
    let imported = 0;

    for (const externalMessage of result.messages) {
      if (connection.seenMessageIds.has(externalMessage.id)) continue;
      connection.seenMessageIds.add(externalMessage.id);
      const chatMessage = toExternalChatMessage(externalMessage);
      storeChatMessage(roomState, chatMessage);
      sendChatToVisibleParticipants(roomId, roomState, chatMessage, 'chat-message');
      imported++;
    }

    const nextPollAt = new Date(Date.now() + result.pollingIntervalMillis).toISOString();
    setExternalChatStatus(roomId, roomState, connection, {
      status: 'connected',
      message: imported > 0
        ? `Imported ${imported} YouTube chat message${imported === 1 ? '' : 's'}.`
        : 'YouTube chat connected.',
      nextPollAt,
    });

    connection.timer = setTimeout(() => {
      pollYouTubeLiveChat(roomId, roomState, connection, apiKey).catch((err) => {
        console.warn(`YouTube live chat poll failed for room ${roomId}:`, err);
      });
    }, result.pollingIntervalMillis);
    connection.timer.unref?.();
  } catch (err) {
    if (connection.stopped || roomState.externalChatConnections.get('youtube') !== connection) return;
    const message = err instanceof Error ? err.message : 'YouTube chat polling failed.';
    setExternalChatStatus(roomId, roomState, connection, {
      status: 'error',
      message,
      nextPollAt: new Date(Date.now() + 30_000).toISOString(),
    });
    connection.timer = setTimeout(() => {
      pollYouTubeLiveChat(roomId, roomState, connection, apiKey).catch((retryErr) => {
        console.warn(`YouTube live chat retry failed for room ${roomId}:`, retryErr);
      });
    }, 30_000);
    connection.timer.unref?.();
  } finally {
    connection.polling = false;
  }
}

async function pollFacebookLiveComments(
  roomId: string,
  roomState: RoomState,
  connection: ExternalChatConnectionState,
  accessToken: string
) {
  if (connection.polling || connection.stopped) return;
  connection.polling = true;

  try {
    const result = await fetchFacebookLiveComments({
      accessToken,
      liveVideoId: connection.liveChatId,
      pageToken: connection.nextPageToken,
      pollIntervalMs: getFacebookCommentsPollIntervalMs(),
    });
    if (connection.stopped || roomState.externalChatConnections.get('facebook') !== connection) return;

    connection.nextPageToken = result.nextPageToken || connection.nextPageToken;
    let imported = 0;

    for (const externalMessage of result.comments) {
      if (connection.seenMessageIds.has(externalMessage.id)) continue;
      connection.seenMessageIds.add(externalMessage.id);
      const chatMessage = toExternalChatMessage(externalMessage);
      storeChatMessage(roomState, chatMessage);
      sendChatToVisibleParticipants(roomId, roomState, chatMessage, 'chat-message');
      imported++;
    }

    const nextPollAt = new Date(Date.now() + result.pollingIntervalMillis).toISOString();
    setExternalChatStatus(roomId, roomState, connection, {
      status: 'connected',
      message: imported > 0
        ? `Imported ${imported} Facebook comment${imported === 1 ? '' : 's'}.`
        : 'Facebook comments connected.',
      nextPollAt,
    });

    connection.timer = setTimeout(() => {
      pollFacebookLiveComments(roomId, roomState, connection, accessToken).catch((err) => {
        console.warn(`Facebook live comments poll failed for room ${roomId}:`, err);
      });
    }, result.pollingIntervalMillis);
    connection.timer.unref?.();
  } catch (err) {
    if (connection.stopped || roomState.externalChatConnections.get('facebook') !== connection) return;
    const message = err instanceof Error ? err.message : 'Facebook comments polling failed.';
    setExternalChatStatus(roomId, roomState, connection, {
      status: 'error',
      message,
      nextPollAt: new Date(Date.now() + 30_000).toISOString(),
    });
    connection.timer = setTimeout(() => {
      pollFacebookLiveComments(roomId, roomState, connection, accessToken).catch((retryErr) => {
        console.warn(`Facebook live comments retry failed for room ${roomId}:`, retryErr);
      });
    }, 30_000);
    connection.timer.unref?.();
  } finally {
    connection.polling = false;
  }
}

function handleExternalChatConnect(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'external-chat-connect' }>['payload']
) {
  const operator = getExternalChatOperator(ws, 'Only hosts and co-hosts can connect external chat');
  if (!operator) return;

  const platform = normalizeExternalChatPlatform(payload.platform);
  if (!platform) {
    sendError(ws, 'External chat platform is not supported', 'VALIDATION_ERROR');
    return;
  }
  const liveChatId = platform === 'youtube'
    ? normalizeYouTubeLiveChatId(payload.liveChatId)
    : normalizeFacebookLiveVideoId(payload.liveChatId);
  if (!liveChatId) {
    sendError(
      ws,
      platform === 'youtube'
        ? 'A valid YouTube live chat id is required'
        : 'A valid Facebook live video id is required',
      'VALIDATION_ERROR'
    );
    return;
  }

  const secret = platform === 'youtube'
    ? getYouTubeLiveChatApiKey()
    : getFacebookLiveCommentsAccessToken();
  if (!secret) {
    send(ws, {
      type: 'external-chat-status',
      payload: {
        platform,
        status: 'error',
        liveChatId,
        message: platform === 'youtube'
          ? 'YouTube Live Chat requires YOUTUBE_API_KEY on the signaling server.'
          : 'Facebook comments require FACEBOOK_ACCESS_TOKEN on the signaling server.',
      },
    });
    return;
  }

  stopExternalChatConnection(operator.roomId, operator.roomState, platform, false);
  const connection: ExternalChatConnectionState = {
    platform,
    liveChatId,
    status: {
      platform,
      status: 'connecting',
      liveChatId,
      message: `Connecting to ${getExternalChatPlatformLabel(platform)} chat...`,
    },
    seenMessageIds: new Set(),
    polling: false,
    stopped: false,
  };
  operator.roomState.externalChatConnections.set(platform, connection);
  setExternalChatStatus(operator.roomId, operator.roomState, connection, {
    status: 'connecting',
    message: `Connecting to ${getExternalChatPlatformLabel(platform)} chat...`,
  });
  if (platform === 'youtube') {
    pollYouTubeLiveChat(operator.roomId, operator.roomState, connection, secret).catch((err) => {
      console.warn(`YouTube live chat connect failed for room ${operator.roomId}:`, err);
    });
  } else {
    pollFacebookLiveComments(operator.roomId, operator.roomState, connection, secret).catch((err) => {
      console.warn(`Facebook live comments connect failed for room ${operator.roomId}:`, err);
    });
  }
}

function handleExternalChatDisconnect(
  ws: WebSocket,
  payload: Extract<SignalMessage, { type: 'external-chat-disconnect' }>['payload']
) {
  const operator = getExternalChatOperator(ws, 'Only hosts and co-hosts can disconnect external chat');
  if (!operator) return;

  const platform = normalizeExternalChatPlatform(payload.platform);
  if (!platform) {
    sendError(ws, 'External chat platform is not supported', 'VALIDATION_ERROR');
    return;
  }
  stopExternalChatConnection(operator.roomId, operator.roomState, platform, true);
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
  if (senderEntry.participant.status === 'green-room' && !isOperatorParticipant(roomState, payload.recipientId)) {
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
  if (senderEntry.participant.status === 'green-room' && !isOperatorParticipant(roomState, payload.recipientId)) {
    // A waiting guest can message the host privately, but not the whole studio.
    sendError(ws, 'Message the host directly while you wait in the green room', 'PARTICIPANT_NOT_ADMITTED');
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
  clearHostReconnectTimer(state);

  broadcastToRoom(roomId, { type: 'room-ended', payload: {} });

  for (const entry of state.participants.values()) {
    const participantWs = entry.ws;
    clearResumeTimer(entry);
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

/** The host changed their mind during the end countdown: the studio stays open. */
function handleCancelEndRoom(ws: WebSocket) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const performer = roomState.participants.get(mapping.participantId);
  if (!performer || performer.participant.role !== 'host') {
    sendError(ws, 'Only the host can keep the room open', 'UNAUTHORIZED');
    return;
  }

  if (!clearRoomEndingTimer(mapping.roomId)) return;
  console.log(`Host kept room ${mapping.roomId} open`);
  broadcastToRoom(mapping.roomId, {
    type: 'room-ending-cancelled',
    payload: {},
  });
}

/**
 * Close codes that mean the participant chose to leave: the studio's own Leave
 * (1000) or a close() without a code (1005). Anything else (a dropped network,
 * a proxy reset, a reload, a missed heartbeat) holds the seat for a resume.
 */
const DELIBERATE_CLOSE_CODES = new Set([1000, 1005]);

function handleDisconnect(ws: WebSocket, code?: number) {
  wsRateLimiter.forget(ws);
  pendingJoins.delete(ws);

  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;
  wsToParticipant.delete(ws);

  const { roomId, participantId } = mapping;
  const roomState = rooms.get(roomId);
  if (!roomState) return;
  const entry = roomState.participants.get(participantId);
  if (!entry || entry.ws !== ws) return;

  const deliberate = code !== undefined && DELIBERATE_CLOSE_CODES.has(code);
  if (!deliberate && RESUME_GRACE_MS > 0 && !endingTimers.has(roomId)) {
    // Hold the seat: others keep the tile and their peer connection, which
    // may well still be carrying media. Nothing is announced unless the
    // participant does not come back in time.
    entry.disconnectedAt = Date.now();
    clearResumeTimer(entry);
    entry.resumeTimer = setTimeout(() => {
      entry.resumeTimer = undefined;
      if (rooms.get(roomId) !== roomState) return;
      if (roomState.participants.get(participantId) !== entry || entry.disconnectedAt === undefined) return;
      finalizeDeparture(roomId, roomState, participantId, 'Disconnected from signaling');
    }, RESUME_GRACE_MS);
    entry.resumeTimer.unref?.();
    console.log(`${entry.participant.name} lost their connection to room ${roomId}; holding their seat for ${Math.round(RESUME_GRACE_MS / 1000)}s`);
    return;
  }

  finalizeDeparture(roomId, roomState, participantId, 'Disconnected from signaling');
}

/** The participant is gone for good: free the seat and tell everyone. */
function finalizeDeparture(roomId: string, roomState: RoomState, participantId: string, reason: string) {
  const entry = roomState.participants.get(participantId);
  if (!entry) return;
  clearResumeTimer(entry);
  const name = entry.participant.name || 'Unknown';
  const wasHost = participantId === roomState.room.hostId;
  if (roomState.handedOffHostId === participantId) roomState.handedOffHostId = undefined;

  roomState.participants.delete(participantId);
  if (wsToParticipant.get(entry.ws)?.participantId === participantId) wsToParticipant.delete(entry.ws);
  notifyMediaServerSfuMembership('revoke-participant', roomId, participantId, reason);

  if (
    entry.participant.role === 'guest'
    && entry.joinSessionId
    && entry.participant.status !== 'green-room'
    && !roomState.bannedJoinSessionIds.has(entry.joinSessionId)
    && !roomState.removedJoinSessionIds.has(entry.joinSessionId)
  ) {
    rememberDepartedGuest(roomState, entry.joinSessionId, entry.participant.status, Date.now());
  }

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
    // A co-host who is connected right now is preferred over one whose seat is only being held.
    const coHostCandidates = roomState.room.coHostIds.filter((id) => roomState.participants.has(id));
    const newHostId: string | null = coHostCandidates.find((id) => roomState.participants.get(id)?.disconnectedAt === undefined)
      ?? coHostCandidates[0]
      ?? null;

    if (newHostId) {
      const newHost = roomState.participants.get(newHostId);
      if (newHost) {
        newHost.participant.role = 'host';
        roomState.room.hostId = newHostId;
        // Remember the stand-in: when the host comes back, they hand the seat back.
        roomState.handedOffHostId = newHostId;
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
      // No co-host to inherit. Never crown a random guest; hold the room
      // for the host to come back, and end it only if they do not.
      clearHostReconnectTimer(roomState);
      roomState.hostReconnectTimer = setTimeout(() => {
        const current = rooms.get(roomId);
        if (current !== roomState) return;
        roomState.hostReconnectTimer = undefined;
        if (roomState.participants.has(roomState.room.hostId)) return;
        console.log(`Host of room ${roomId} did not return within ${HOST_RECONNECT_GRACE_MS / 1000}s. Ending room.`);
        endRoomImmediately(roomId);
      }, HOST_RECONNECT_GRACE_MS);
      roomState.hostReconnectTimer.unref?.();
      console.log(`Host of room ${roomId} disconnected with no co-host; holding the room for ${HOST_RECONNECT_GRACE_MS / 1000}s.`);
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
  persistRoomSnapshot(roomId);
}

/**
 * Waiting guests get only what the waiting room needs: their own updates, who
 * the hosts are, branding and the studio's state. Not other guests' details,
 * what is on stage, polls or Q&A.
 */
function isVisibleInGreenRoom(message: SignalMessage, recipientId: string, roomState: RoomState): boolean {
  switch (message.type) {
    case 'participant-joined':
    case 'participant-updated':
      return message.payload.id === recipientId || isOperatorRole(message.payload.role);
    case 'media-state-changed':
      return isOperatorParticipant(roomState, message.payload.participantId);
    case 'stage-action':
      return message.payload.targetParticipantId === recipientId;
    case 'stage-content-updated':
    case 'poll-updated':
    case 'qa-question-updated':
    case 'external-chat-status':
      return false;
    default:
      return true;
  }
}

function broadcastToRoom(roomId: string, message: SignalMessage, excludeId?: string) {
  const roomState = rooms.get(roomId);
  if (!roomState) return;

  for (const [id, { ws, participant }] of roomState.participants) {
    if (participant.status === 'green-room' && !isVisibleInGreenRoom(message, id, roomState)) continue;
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
    if (participant.status === 'green-room' && id !== question.authorId) continue;

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
