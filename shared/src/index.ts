export * from './clientErrors.js';

// ============ Room & Session Types ============

export interface Room {
  id: string;
  name: string;
  hostId: string;
  coHostIds: string[];
  createdAt: string;
  status: RoomStatus;
  settings: RoomSettings;
  scheduledFor?: string;
  hostName?: string;
  registration?: RoomRegistrationSettings;
}

export type RoomStatus = 'waiting' | 'scheduled' | 'live' | 'recording' | 'ended';

export const SCHEDULED_GUEST_EARLY_JOIN_MS = 15 * 60 * 1000;
export const ROOM_NOT_OPEN_ERROR_CODE = 'ROOM_NOT_OPEN';
export const SCHEDULED_GUEST_ACCESS_MESSAGE = 'This studio is scheduled. Guest access opens 15 minutes before the start time.';

export interface ServiceHealthPayload {
  status: 'ok';
  service: string;
  version?: string;
  commit?: string;
  environment?: string;
  capabilities?: Record<string, ServiceHealthCapability>;
}

export interface ServiceHealthCapability {
  ready: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// ============ Account Types ============

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSessionInfo {
  expiresAt: string;
}

export interface AccountAuthSession extends AccountSessionInfo {
  token: string;
}

export interface AccountAuthResponse {
  user: AccountUser;
  session: AccountAuthSession;
}

export interface AccountSessionResponse {
  user: AccountUser | null;
  session?: AccountSessionInfo;
}

export interface AccountLogoutResponse {
  ok: true;
}

export interface AccountRegisterRequest {
  email: string;
  name: string;
  password: string;
}

export interface AccountLoginRequest {
  email: string;
  password: string;
}

export interface AccountChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface AccountChangePasswordResponse {
  ok: true;
  /** Other devices signed out because the password changed. */
  signedOutSessions: number;
}

/** One place the account is signed in. Never carries the session token. */
export interface AccountSessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string;
  current: boolean;
}

export interface AccountSessionsResponse {
  sessions: AccountSessionSummary[];
}

export interface AccountRevokeSessionsResponse {
  ok: true;
  revoked: number;
}

export interface AccountPasswordResetRequest {
  email: string;
}

export interface AccountPasswordResetRequestResponse {
  /** Always true: the response never reveals whether the email has an account. */
  ok: true;
}

export interface AccountPasswordResetConfirmRequest {
  token: string;
  newPassword: string;
}

export interface AccountCapabilitiesResponse {
  /** Whether this server can email password reset links. */
  passwordReset: boolean;
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeCommit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[a-f0-9]{7,40}$/i.test(value) ? value : undefined;
}

export function buildServiceHealthPayload(
  service: string,
  env: Record<string, string | undefined> = {}
): ServiceHealthPayload {
  const version = firstNonEmptyEnv(env, ['npm_package_version', 'APP_VERSION']);
  const commit = normalizeCommit(firstNonEmptyEnv(env, ['RENDER_GIT_COMMIT', 'GIT_COMMIT', 'SOURCE_VERSION', 'GITHUB_SHA']));
  const environment = firstNonEmptyEnv(env, ['NODE_ENV']);
  return {
    status: 'ok',
    service,
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    ...(environment ? { environment } : {}),
  };
}

export function getScheduledGuestOpenAtMs(scheduledFor: string | null | undefined): number | null {
  if (!scheduledFor) return null;
  const scheduledAt = Date.parse(scheduledFor);
  if (!Number.isFinite(scheduledAt)) return null;
  return scheduledAt - SCHEDULED_GUEST_EARLY_JOIN_MS;
}

export function isScheduledGuestAccessBlocked(
  scheduledFor: string | null | undefined,
  nowMs = Date.now()
): boolean {
  const guestOpenAt = getScheduledGuestOpenAtMs(scheduledFor);
  return guestOpenAt !== null && nowMs < guestOpenAt;
}

export interface StudioCalendarInviteInput {
  roomName: string;
  inviteUrl: string;
  scheduledFor: string | null | undefined;
  hostName?: string | null;
  durationMinutes?: number;
  createdAt?: string;
  uid?: string;
  passwordProtected?: boolean;
}

function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function foldIcsLine(line: string): string {
  const maxLineLength = 74;
  if (line.length <= maxLineLength) return line;
  const parts: string[] = [];
  let current = line;
  while (current.length > maxLineLength) {
    parts.push(current.slice(0, maxLineLength));
    current = ` ${current.slice(maxLineLength)}`;
  }
  parts.push(current);
  return parts.join('\r\n');
}

export function buildStudioCalendarInvite(input: StudioCalendarInviteInput): string | null {
  const startMs = input.scheduledFor ? Date.parse(input.scheduledFor) : NaN;
  if (!Number.isFinite(startMs)) return null;

  const durationMinutes = Number.isFinite(input.durationMinutes)
    ? Math.max(15, Math.min(24 * 60, Math.floor(input.durationMinutes || 60)))
    : 60;
  const start = new Date(startMs);
  const end = new Date(startMs + durationMinutes * 60_000);
  const createdMs = input.createdAt ? Date.parse(input.createdAt) : NaN;
  const stamp = Number.isFinite(createdMs) ? new Date(createdMs) : new Date();
  const uid = input.uid || `${startMs}-${input.inviteUrl}`;
  const details = [
    input.hostName ? `Host: ${input.hostName}` : null,
    `Join: ${input.inviteUrl}`,
    input.passwordProtected ? 'Password protected. Ask the host for the password.' : null,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LiveStream Studio//Scheduled Studio//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${formatIcsDate(stamp)}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${escapeIcsText(input.roomName || 'LiveStream Studio')}`,
    `DESCRIPTION:${escapeIcsText(details)}`,
    `LOCATION:${escapeIcsText(input.inviteUrl)}`,
    `URL:${escapeIcsText(input.inviteUrl)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

export interface RoomSettings {
  maxParticipants: number;
  resolution: VideoResolution;
  frameRate: number;
  enableRecording: boolean;
  enableStreaming: boolean;
  greenRoomEnabled: boolean;
  passwordProtected: boolean;
  /** Co-hosts arriving from an invite link go straight on stage; by default they arrive backstage. */
  coHostsJoinOnStage?: boolean;
}

export type RoomRegistrationField = 'name' | 'email';

export interface RoomRegistrationSettings {
  enabled: boolean;
  fields: RoomRegistrationField[];
}

export interface RoomRegistrant {
  id: string;
  roomId: string;
  name: string;
  email: string;
  registeredAt: string;
}

export interface RoomRegistrantResponse {
  registrant: RoomRegistrant;
  total: number;
}

export interface RoomRegistrantListResponse {
  roomId: string;
  exportedAt: string;
  registrants: RoomRegistrant[];
}

export type VideoResolution = '720p' | '1080p' | '4k';
export type BroadcastOrientation = 'landscape' | 'portrait';

export const RESOLUTION_MAP: Record<VideoResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

// ============ Participant Types ============

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  joinedAt: string;
  status: ParticipantStatus;
  /** Optional name-tag subtitle a host set, e.g. "Author, The Long Game". */
  title?: string;
  /**
   * Studio features this participant's client understands (sent in join-room,
   * kept by the server). Absent for clients and servers older than the flag,
   * so a feature that needs the other side's help is used only when present.
   */
  capabilities?: StudioCapability[];
}

/**
 * Client features that change what peers send each other:
 * - 'program-return': recognises the program-return stream (announced with
 *   program-return-announce) instead of taking it for a screen share.
 * - 'talkback': silences other operators' talkback-state in its program mix.
 */
export const STUDIO_CAPABILITIES = ['program-return', 'talkback'] as const;
export type StudioCapability = typeof STUDIO_CAPABILITIES[number];

const STUDIO_CAPABILITY_SET: ReadonlySet<string> = new Set(STUDIO_CAPABILITIES);

/** The known, de-duplicated capabilities from a client's claim; anything unknown is dropped. */
export function sanitizeStudioCapabilities(raw: unknown): StudioCapability[] {
  if (!Array.isArray(raw)) return [];
  const result: StudioCapability[] = [];
  for (const value of raw.slice(0, 16)) {
    if (typeof value !== 'string' || !STUDIO_CAPABILITY_SET.has(value)) continue;
    const capability = value as StudioCapability;
    if (!result.includes(capability)) result.push(capability);
  }
  return result;
}

export function hasStudioCapability(
  participant: Pick<Participant, 'capabilities'> | null | undefined,
  capability: StudioCapability
): boolean {
  return Boolean(participant?.capabilities?.includes(capability));
}

/** Longest participant name-tag title (subtitle) the server keeps. */
export const MAX_PARTICIPANT_TITLE_LENGTH = 80;

export type ParticipantRole = 'host' | 'co-host' | 'guest';
export type ParticipantStatus = 'green-room' | 'on-stage' | 'backstage';

type MediaAccessParticipant = Pick<Participant, 'role' | 'status'> | null | undefined;

export function canExchangeStudioMedia(
  sender: MediaAccessParticipant,
  target: MediaAccessParticipant
): boolean {
  if (!sender || !target) return false;
  if (sender.status === 'green-room' || target.status === 'green-room') return false;

  const senderIsOperator = sender.role === 'host' || sender.role === 'co-host';
  const targetIsOperator = target.role === 'host' || target.role === 'co-host';
  const senderBackstage = sender.status === 'backstage';
  const targetBackstage = target.status === 'backstage';

  if (sender.status === 'on-stage' && target.status === 'on-stage') return true;
  if (senderBackstage && targetBackstage) return true;
  if (senderBackstage && targetIsOperator) return true;
  if (targetBackstage && senderIsOperator) return true;

  return false;
}

type StageOwnerCandidate = Pick<Participant, 'id' | 'role' | 'status'> & { joinedAt?: string };

/**
 * Whose stage guests mirror and whose compositor feeds the program return:
 * the host while they are in the studio, otherwise the co-host who joined
 * first. Only that client mirrors stage content, so a co-host joining or
 * reconnecting never replaces what the host presents.
 */
export function getStageOwnerId(participants: Iterable<StageOwnerCandidate>): string | null {
  let coHost: StageOwnerCandidate | null = null;
  for (const participant of participants) {
    if (participant.status === 'green-room') continue;
    if (participant.role === 'host') return participant.id;
    if (participant.role !== 'co-host') continue;
    if (!coHost) {
      coHost = participant;
      continue;
    }
    const a = participant.joinedAt || '';
    const b = coHost.joinedAt || '';
    if (a < b || (a === b && participant.id < coHost.id)) coHost = participant;
  }
  return coHost?.id ?? null;
}

/** MediaStream ids are UUIDs (Firefox wraps them in braces). */
export const PROGRAM_RETURN_STREAM_ID_PATTERN = /^[\w{}-]{1,80}$/;

export function isValidProgramReturnStreamId(value: unknown): value is string {
  return typeof value === 'string' && PROGRAM_RETURN_STREAM_ID_PATTERN.test(value);
}

export const STAGE_CONTROL_ACTIONS = ['next', 'previous', 'goto', 'clear'] as const;
export type StageControlAction = typeof STAGE_CONTROL_ACTIONS[number];

// ============ Signaling Types ============

export type SignalMessage =
  /** Client liveness check; the server answers with `heartbeat-ack`. */
  | { type: 'heartbeat'; payload: { sentAt: number } }
  | { type: 'heartbeat-ack'; payload: { sentAt: number; receivedAt: number } }
  | { type: 'join-room'; payload: JoinRoomPayload }
  | { type: 'room-joined'; payload: RoomJoinedPayload }
  | { type: 'participant-joined'; payload: Participant }
  | { type: 'participant-left'; payload: { participantId: string } }
  | { type: 'offer'; payload: SDPPayload }
  | { type: 'answer'; payload: SDPPayload }
  | { type: 'ice-candidate'; payload: ICEPayload }
  | { type: 'media-state-changed'; payload: MediaStatePayload }
  /** A participant renames themself; the server answers everyone with `participant-updated`. */
  | { type: 'update-name'; payload: UpdateNamePayload }
  | { type: 'chat-message'; payload: ChatMessage }
  | { type: 'chat-message-updated'; payload: ChatMessage }
  | { type: 'chat-typing'; payload: ChatTypingPayload }
  | { type: 'chat-reaction'; payload: ChatReactionPayload }
  | { type: 'chat-star-update'; payload: ChatStarUpdatePayload }
  | { type: 'chat-pin-update'; payload: ChatPinUpdatePayload }
  | { type: 'qa-question-submitted'; payload: { id?: string; content: string } }
  | { type: 'qa-question-updated'; payload: QAQuestion }
  | { type: 'qa-question-update'; payload: { questionId: string; updates: Partial<Pick<QAQuestion, 'status' | 'answer' | 'highlighted'>> } }
  | { type: 'qa-question-upvote'; payload: { questionId: string } }
  | { type: 'poll-create'; payload: PollCreatePayload }
  | { type: 'poll-vote'; payload: PollVotePayload }
  | { type: 'poll-update'; payload: PollUpdatePayload }
  | { type: 'poll-updated'; payload: LivePoll }
  | { type: 'stage-action'; payload: StageActionPayload }
  | { type: 'participant-notification'; payload: ParticipantNotificationPayload }
  | { type: 'studio-branding-updated'; payload: StudioBrandingPayload }
  | { type: 'stage-content-updated'; payload: StageContentPayload }
  /** Co-host (or host) remote for the stage owner's deck: next/previous/goto/clear. Relayed to the stage owner only. */
  | { type: 'stage-control'; payload: StageControlPayload }
  /**
   * An on-stage participant's own live caption (browser speech recognition on
   * their mic). Relayed by the server, rate-limited, to hosts and co-hosts only.
   */
  | { type: 'caption-segment'; payload: CaptionSegmentPayload }
  /** Host/co-host: live captions are on or off, so on-stage guests can opt in to caption themselves. */
  | { type: 'captions-state'; payload: CaptionsStatePayload }
  /** Stage owner to one admitted peer: which of its incoming streams is the program return feed. */
  | { type: 'program-return-announce'; payload: ProgramReturnAnnouncePayload }
  /**
   * Host/co-host: their mic is off the program right now (talk backstage).
   * Relayed to admitted operators, who silence that person in any program
   * mix they build, and echoed back to the sender as confirmation.
   */
  | { type: 'talkback-state'; payload: TalkbackStatePayload }
  | { type: 'recording-state-changed'; payload: RecordingStatePayload }
  /** Host/co-host only: the 3-2-1 before recording, so guests see it too. */
  | { type: 'recording-countdown'; payload: RecordingCountdownPayload }
  /** Host/co-host only: fix a participant's display name or set their name-tag title. */
  | { type: 'update-participant-profile'; payload: UpdateParticipantProfilePayload }
  | { type: 'recording-upload-token-request'; payload: RecordingUploadTokenRequestPayload }
  | { type: 'recording-upload-token-issued'; payload: RecordingUploadTokenIssuedPayload }
  | { type: 'recording-upload-progress'; payload: RecordingUploadProgressPayload }
  | { type: 'recording-upload-control'; payload: RecordingUploadControlPayload }
  | { type: 'recording-transfer-signal'; payload: RecordingTransferSignalPayload }
  | { type: 'sfu-token-request'; payload: SfuTokenRequestPayload }
  | { type: 'sfu-token-issued'; payload: SfuTokenIssuedPayload }
  | { type: 'live-stream-state-changed'; payload: LiveStreamStatePayload }
  | { type: 'live-stream-token-request'; payload: LiveStreamTokenRequestPayload }
  | { type: 'live-stream-token-issued'; payload: LiveStreamTokenIssuedPayload }
  | { type: 'external-chat-connect'; payload: ExternalChatConnectPayload }
  | { type: 'external-chat-disconnect'; payload: ExternalChatDisconnectPayload }
  | { type: 'external-chat-status'; payload: ExternalChatStatusPayload }
  | { type: 'guest-invite-token-request'; payload: GuestInviteTokenRequestPayload }
  | { type: 'guest-invite-token-issued'; payload: GuestInviteTokenIssuedPayload }
  | { type: 'co-host-invite-token-request'; payload: CoHostInviteTokenRequestPayload }
  | { type: 'co-host-invite-token-issued'; payload: CoHostInviteTokenIssuedPayload }
  | { type: 'participant-updated'; payload: Participant }
  | { type: 'participant-removed'; payload: { reason: string } }
  | { type: 'end-room'; payload: Record<string, never> }
  /** Host: keep the studio open after all, during the end countdown. */
  | { type: 'cancel-end-room'; payload: Record<string, never> }
  | { type: 'room-ending'; payload: { endsAt: string } }
  | { type: 'room-ended'; payload: Record<string, never> }
  | { type: 'room-ending-cancelled'; payload: Record<string, never> }
  | { type: 'host-changed'; payload: { newHostId: string; newHostName: string } }
  | { type: 'error'; payload: { message: string; code: string } };

export interface JoinRoomPayload {
  roomId: string;
  name: string;
  role: ParticipantRole;
  hostToken?: string;
  coHostInviteToken?: string;
  guestInviteToken?: string;
  roomPassword?: string;
  joinSessionId?: string;
  /**
   * Proof of an earlier seat in this studio (from room-joined). Within a short
   * grace window after a dropped connection, presenting it returns the same
   * participant id, role and place, so media connections that are still healthy
   * stay up. Single-use invite tokens are not sent alongside it.
   */
  resumeToken?: string;
  /** Host only: the signed studio description from room-joined, used to rebuild the studio after a server restart. */
  restoreTicket?: string;
  /**
   * Host only: the owner's studio access key (STUDIO_CREATE_SECRET), when this
   * browser has it. Marks a studio made before the owner gate as the owner's.
   */
  studioAccessKey?: string;
  /** Features this client understands (see STUDIO_CAPABILITIES). */
  capabilities?: StudioCapability[];
}

export interface RoomJoinedPayload {
  room: Room;
  participant: Participant;
  participants: Participant[];
  chatMessages?: ChatMessage[];
  qaQuestions?: QAQuestion[];
  polls?: LivePoll[];
  recordingState?: RecordingStatePayload;
  liveStreamState?: LiveStreamStatePayload;
  studioBranding?: StudioBrandingPayload;
  /** What the host has on stage (a slide, an image), mirrored to everyone. */
  stageContent?: StageContentPayload;
  /** Hosts and co-hosts only: authorizes uploads to `/api/rooms/:id/stage-images`. */
  stageUploadToken?: string;
  /** Admitted participants only: authorizes reading `/api/rooms/:id/stage-images/:imageId` (header `x-stage-token`). */
  stageReadToken?: string;
  /** Present again on the next join-room to keep this seat through a dropped connection. */
  resumeToken?: string;
  /** True when this join resumed an earlier seat (same participant id); peers were kept. */
  resumed?: boolean;
  /** Hosts and co-hosts only: the private id of the public watch page (`/watch/:watchId`). */
  watchId?: string;
  /** Host only: signed studio description to keep with the host token (see JoinRoomPayload.restoreTicket). */
  restoreTicket?: string;
  features?: {
    chatTyping?: boolean;
  };
  /**
   * Admitted hosts and co-hosts only: the other operators talking backstage
   * right now, so a newcomer (or a reconnect that missed talkback-state)
   * keeps them off its program mix.
   */
  talkbackParticipantIds?: string[];
}

/**
 * The media on stage, so guests see what the host presents. Pictures are too
 * large for signaling, so the host uploads each one over HTTP and this names it.
 */
export interface StageContentPayload {
  media: StageContentMedia | null;
  /** The presenting layout the host chose. */
  layout?: LayoutMode;
  /** The host chose the "Me" view: shared content (including a screen share) is off stage. */
  contentHidden?: boolean;
}

/** Longest caption text one segment may carry. */
export const MAX_CAPTION_SEGMENT_TEXT_LENGTH = 500;
/** Longest stretch of speech one segment may claim. */
export const MAX_CAPTION_SEGMENT_DURATION_MS = 30_000;
/** Caption segments one participant may send per window (interim updates are throttled client-side). */
export const CAPTION_SEGMENT_RATE_LIMIT_MAX = 40;
export const CAPTION_SEGMENT_RATE_LIMIT_WINDOW_MS = 10_000;

export interface CaptionSegmentPayload {
  /** Set by the server to the sender's id; whatever a client claims is replaced. */
  participantId: string;
  /** Set by the server to the sender's display name. */
  speakerName?: string;
  /** Stable per utterance, so interim updates replace each other and the final replaces them. */
  segmentId: string;
  text: string;
  /** Sender clock (ms since epoch). Receivers keep the duration and re-anchor to their own clock. */
  startMs: number;
  endMs: number;
  final: boolean;
}

export interface CaptionsStatePayload {
  enabled: boolean;
  /** BCP-47 recognition language, e.g. 'en-US'. */
  language: string;
  /** Set by the server: which operator sent it. */
  from?: string;
}

const CAPTION_SEGMENT_ID_PATTERN = /^[\w-]{1,64}$/;
const CAPTION_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * Validates a caption segment from a client. Returns the clean fields (text
 * trimmed, whitespace collapsed and capped, times ordered and bounded) or
 * null. participantId and speakerName are never taken from the client.
 */
export function sanitizeCaptionSegment(raw: unknown): Omit<CaptionSegmentPayload, 'participantId' | 'speakerName'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.segmentId !== 'string' || !CAPTION_SEGMENT_ID_PATTERN.test(value.segmentId)) return null;
  if (typeof value.text !== 'string') return null;
  const text = value.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION_SEGMENT_TEXT_LENGTH);
  if (!text) return null;
  const startMs = Number(value.startMs);
  const endMs = Number(value.endMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs <= 0 || endMs < startMs) return null;
  return {
    segmentId: value.segmentId,
    text,
    startMs: Math.round(startMs),
    endMs: Math.round(Math.min(endMs, startMs + MAX_CAPTION_SEGMENT_DURATION_MS)),
    final: value.final === true,
  };
}

export function sanitizeCaptionsState(raw: unknown): Omit<CaptionsStatePayload, 'from'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return null;
  const language = typeof value.language === 'string' && CAPTION_LANGUAGE_PATTERN.test(value.language) ? value.language : 'en-US';
  return { enabled: value.enabled, language };
}

export interface TalkbackStatePayload {
  active: boolean;
  /** Set by the server: which operator is talking backstage. */
  from?: string;
}

export interface StageControlPayload {
  action: StageControlAction;
  /** For 'goto': the zero-based slide to show. */
  slideIndex?: number;
  /** The StageContentMedia id the sender saw; a stale command for other media is ignored. */
  mediaId?: string;
  /** Set by the server: who sent it. */
  from?: string;
}

/**
 * The program return is a low-bitrate copy of the program (compositor video,
 * and for backstage guests the program audio) on its own MediaStream. Peers
 * are told its stream id before the track arrives so it is never taken for a
 * camera or a screen share.
 */
export interface ProgramReturnAnnouncePayload {
  to: string;
  streamId: string | null;
  /** Set by the server. */
  from?: string;
}

export interface StageContentMedia {
  id: string;
  type: StudioMediaType;
  name: string;
  /** Uploaded picture of the current slide or image; absent for videos and documents. */
  imageId?: string;
  slideIndex?: number;
  slideCount?: number;
}

/**
 * Peer-connection identity carried with every offer, answer and candidate.
 * `pcId` names the sender's RTCPeerConnection, `toPcId` the receiver's
 * connection the sender is talking to. A new `pcId` on an offer means the
 * other side rebuilt its connection (a reload that kept its participant id, or
 * recovery after repeated ICE failures), so the receiver rebuilds too; messages
 * aimed at a connection the receiver already replaced are ignored.
 */
export interface PeerConnectionRef {
  pcId?: string;
  toPcId?: string;
}

export interface SDPPayload extends PeerConnectionRef {
  from: string;
  to: string;
  sdp: RTCSessionDescriptionInit;
}

export interface ICEPayload extends PeerConnectionRef {
  from: string;
  to: string;
  candidate: RTCIceCandidateInit;
}

export interface MediaStatePayload {
  participantId: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  /** Id of the separate screen MediaStream when the screen is sent beside the camera. */
  screenStreamId?: string;
}

export interface UpdateNamePayload {
  name: string;
}

export interface UpdateNamePayload {
  name: string;
}

export interface StageActionPayload {
  action: 'move-to-stage' | 'move-to-backstage' | 'move-to-green-room' | 'notify-next' | 'promote-co-host' | 'demote-to-guest' | 'mute' | 'unmute' | 'remove' | 'ban';
  targetParticipantId: string;
  performedBy: string;
}

export interface ParticipantNotificationPayload {
  id: string;
  targetParticipantId: string;
  title: string;
  message: string;
  tone: 'info' | 'success' | 'warning';
  issuedAt: string;
  issuedBy: string;
}

export type WaitingRoomBackgroundMode = 'brand' | 'studio';

export interface WaitingRoomBranding {
  headline: string;
  message: string;
  backgroundMode: WaitingRoomBackgroundMode;
  showLogo: boolean;
}

export interface StudioBrandingPayload {
  brandColor: string;
  logoUrl: string | null;
  stageBackground: StageBackground;
  waitingRoom: WaitingRoomBranding;
  updatedAt?: string;
  updatedBy?: string;
}

export interface RecordingCountdownPayload {
  /** Seconds until recording starts (1-10); 0 with `cancelled` ends it. */
  seconds: number;
  cancelled?: boolean;
  /** Set by the server. */
  performedBy?: string;
}

export interface UpdateParticipantProfilePayload {
  targetParticipantId: string;
  /** New display name; omitted keeps the current one. */
  name?: string;
  /** Name-tag subtitle; an empty string clears it, omitted keeps it. */
  title?: string;
}

export interface RecordingStatePayload {
  recording: boolean;
  sessionId?: string;
  paused?: boolean;
  startedAt?: string;
  stoppedAt?: string;
  performedBy: string;
}

export interface RecordingUploadTokenRequestPayload {
  requestId: string;
  sessionId: string;
}

export interface RecordingUploadTokenIssuedPayload {
  requestId: string;
  sessionId: string;
  token: string;
  expiresAt: string;
}

export type RecordingUploadProgressStatus =
  | 'uploading'
  | 'paused'
  | 'finishing'
  | 'complete'
  | 'error';

/**
 * Progressive upload report. Participants send it to the server; the server
 * stamps the sender's identity and relays it to hosts and co-hosts only.
 */
export interface RecordingUploadProgressPayload {
  sessionId: string;
  participantId?: string;
  participantName?: string;
  status: RecordingUploadProgressStatus;
  recordedBytes: number;
  uploadedBytes: number;
  trackCount: number;
  completedTrackCount: number;
  message?: string;
  updatedAt?: string;
}

/** Host/co-host request to pause or resume a participant's background upload. */
export interface RecordingUploadControlPayload {
  targetParticipantId: string;
  action: 'pause' | 'resume';
  performedBy?: string;
}

/**
 * Peer-to-peer recording transfer signaling. A host or co-host invites a
 * participant to send their local tracks straight to the host's recording
 * folder over a dedicated RTCPeerConnection; the participant then offers and
 * the operator answers. The server relays these only between an admitted
 * (non-green-room) participant and the room's operators, and stamps the
 * sender. A participant whose seat was resumed sends 'ready' to ask the
 * operators for a fresh invite.
 */
export type RecordingTransferSignalKind = 'invite' | 'offer' | 'answer' | 'hangup' | 'ready';

export interface RecordingTransferSignalOptions {
  /** Ask participants to also capture a lossless 48 kHz WAV of their microphone. */
  losslessAudio?: boolean;
  /** Keep the media-server upload running beside the peer-to-peer transfer. */
  cloudUpload?: boolean;
}

export interface RecordingTransferSignalPayload {
  targetParticipantId: string;
  /** Set by the server to the authenticated sender. */
  fromParticipantId?: string;
  /** Identifies one transfer connection; a new offer replaces older ones. */
  transferId: string;
  kind: RecordingTransferSignalKind;
  /** Recording session the invite belongs to, when a take is running. */
  sessionId?: string;
  /** Complete (non-trickle) SDP for offers and answers. */
  sdp?: string;
  options?: RecordingTransferSignalOptions;
}

export const MAX_RECORDING_TRANSFER_SDP_LENGTH = 32_000;

export const RECORDING_UPLOAD_PROGRESS_STATUSES: readonly RecordingUploadProgressStatus[] = [
  'uploading',
  'paused',
  'finishing',
  'complete',
  'error',
];

/** Request a short-lived token for the media-server SFU socket. */
export interface SfuTokenRequestPayload {
  requestId: string;
}

export interface SfuTokenIssuedPayload {
  requestId: string;
  token: string;
  expiresAt: string;
}

export interface LiveStreamStatePayload {
  live: boolean;
  startedAt?: string;
  stoppedAt?: string;
  performedBy: string;
}

export interface LiveStreamTokenRequestPayload {
  requestId: string;
  /**
   * Omitted for a live-stream (relay) token. 'presentation-render' asks for a
   * short-lived token that only authorizes the media server's deck renderer.
   */
  purpose?: 'presentation-render';
}

export interface LiveStreamTokenIssuedPayload {
  requestId: string;
  token: string;
  expiresAt: string;
}

export type ExternalChatPlatform = 'youtube' | 'facebook';
export type ExternalChatConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ExternalChatSource {
  platform: ExternalChatPlatform;
  externalId: string;
  authorChannelId?: string;
  authorUrl?: string;
  avatarUrl?: string;
  publishedAt?: string;
  isModerator?: boolean;
  isOwner?: boolean;
  isSponsor?: boolean;
}

export interface ExternalChatConnectPayload {
  platform: ExternalChatPlatform;
  liveChatId: string;
}

export interface ExternalChatDisconnectPayload {
  platform: ExternalChatPlatform;
}

export interface ExternalChatStatusPayload {
  platform: ExternalChatPlatform;
  status: ExternalChatConnectionStatus;
  message?: string;
  liveChatId?: string;
  nextPollAt?: string;
}

export interface CoHostInviteTokenRequestPayload {
  requestId: string;
}

export interface CoHostInviteTokenIssuedPayload {
  requestId: string;
  token: string;
  expiresAt: string;
}

export interface GuestInviteTokenRequestPayload {
  requestId: string;
}

export interface GuestInviteTokenIssuedPayload {
  requestId: string;
  token: string;
  expiresAt: string;
}

export interface ChatMessage {
  id: string;
  clientId?: string;
  senderId: string;
  senderName: string;
  recipientId?: string;
  recipientName?: string;
  content: string;
  timestamp: string;
  isBackstage: boolean;
  starred?: boolean;
  starredBy?: string;
  starredAt?: string;
  pinned?: boolean;
  pinnedBy?: string;
  pinnedAt?: string;
  reactions?: Partial<Record<ChatReactionType, number>>;
  source?: ExternalChatSource;
}

export interface ChatTypingPayload {
  participantId: string;
  participantName: string;
  typing: boolean;
  timestamp: string;
  isBackstage: boolean;
  recipientId?: string;
  recipientName?: string;
}

export const CHAT_REACTION_TYPES = ['like', 'love', 'clap', 'laugh', 'wow'] as const;
export type ChatReactionType = typeof CHAT_REACTION_TYPES[number];

export const CHAT_REACTION_LABELS: Record<ChatReactionType, string> = {
  like: 'Like',
  love: 'Love',
  clap: 'Clap',
  laugh: 'Laugh',
  wow: 'Wow',
};

export const CHAT_REACTION_EMOJIS: Record<ChatReactionType, string> = {
  like: '👍',
  love: '❤️',
  clap: '👏',
  laugh: '😂',
  wow: '😮',
};

export function isChatReactionType(value: unknown): value is ChatReactionType {
  return typeof value === 'string' && (CHAT_REACTION_TYPES as readonly string[]).includes(value);
}

export interface ChatReactionPayload {
  messageId: string;
  reaction: ChatReactionType;
}

export interface ChatStarUpdatePayload {
  messageId: string;
  starred: boolean;
}

export interface ChatPinUpdatePayload {
  messageId: string;
  pinned: boolean;
}

export interface QAQuestion {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  upvotes: number;
  status: 'pending' | 'approved' | 'answered' | 'dismissed';
  answer?: string;
  highlighted: boolean;
}

export interface LivePollOption {
  id: string;
  text: string;
  votes: number;
}

export interface LivePoll {
  id: string;
  question: string;
  options: LivePollOption[];
  status: 'open' | 'closed';
  highlighted: boolean;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  totalVotes: number;
}

export interface PollCreatePayload {
  id?: string;
  question: string;
  options: string[];
}

export interface PollVotePayload {
  pollId: string;
  optionId: string;
}

export interface PollUpdatePayload {
  pollId: string;
  updates: Partial<Pick<LivePoll, 'status' | 'highlighted'>>;
}

// ============ Layout Types ============

/** "custom" draws the stage from a CustomLayout (Scene.customLayoutId or the studio's active one). */
export type LayoutMode = 'grid' | 'spotlight' | 'side-by-side' | 'pip' | 'single' | 'featured' | 'custom';

export interface LayoutConfig {
  mode: LayoutMode;
  spotlightParticipantId?: string;
}

// ============ Overlay Types ============

export interface Overlay {
  id: string;
  type: OverlayType;
  content: OverlayContent;
  position: { x: number; y: number };
  size: { width: number; height: number };
  visible: boolean;
}

export type OverlayType = 'lower-third' | 'logo' | 'banner' | 'background' | 'ticker' | 'widget';

export interface OverlayContent {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  text?: string;
  backgroundColor?: string;
  textColor?: string;
}

// ============ Stage Background Types ============

export interface StageBackground {
  type: 'color' | 'image' | 'video' | 'gradient' | 'none';
  value: string;
}

// ============ Advanced Participant Visual Types ============

export type CameraShape = 'rectangle' | 'rounded' | 'square' | 'circle';
export type NameTagStyle = 'classic' | 'minimal' | 'block';
export type LogoPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type LogoSize = 'small' | 'medium' | 'large';

export interface LogoPosition {
  x: number;
  y: number;
}

export type BrandKitCatalogStudioTheme = 'dark' | 'light' | 'colorful';

export interface BrandKitCatalogEntry {
  id: string;
  roomId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  studioTheme: BrandKitCatalogStudioTheme;
  brandColor: string;
  stageBackground: StageBackground;
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
  logoPosition: LogoPosition | null;
  logoSize: LogoSize;
  logoOpacity: number;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  customLayouts?: CustomLayout[];
  brandFont?: BrandFont | null;
}

export interface BrandKitCatalogUpsertRequest {
  id: string;
  name: string;
  createdAt: string;
  studioTheme: BrandKitCatalogStudioTheme;
  brandColor: string;
  stageBackground: StageBackground;
  logoUrl?: string | null;
  logoPlacement?: LogoPlacement;
  logoPosition?: LogoPosition | null;
  logoSize?: LogoSize;
  logoOpacity?: number;
  cameraShape?: CameraShape;
  nameTagStyle?: NameTagStyle;
  customLayouts?: CustomLayout[];
  brandFont?: BrandFont | null;
}

export interface BrandKitCatalogListResponse {
  roomId: string;
  exportedAt: string;
  brandKits: BrandKitCatalogEntry[];
}

// ============ Workspace Team Catalog Types ============

export type WorkspaceTeamCatalogRole = 'owner' | 'producer' | 'editor' | 'guest-manager';

export interface WorkspaceTeamCatalogMember {
  id: string;
  roomId: string;
  name: string;
  email: string;
  role: WorkspaceTeamCatalogRole;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTeamCatalogUpsertRequest {
  id: string;
  name: string;
  email?: string;
  role: WorkspaceTeamCatalogRole;
  createdAt: string;
}

export interface WorkspaceTeamCatalogListResponse {
  roomId: string;
  exportedAt: string;
  members: WorkspaceTeamCatalogMember[];
}

// ============ Workspace Studio Catalog Types ============

export interface WorkspaceStudioCatalogEntry {
  id: string;
  name: string;
  hostName: string;
  hostToken: string;
  createdAt: string;
  scheduledFor?: string;
  passwordProtected: boolean;
  registrationEnabled?: boolean;
  status?: RoomStatus;
  updatedAt: string;
}

export interface WorkspaceStudioCatalogUpsertRequest {
  id: string;
  name: string;
  hostName: string;
  hostToken: string;
  createdAt: string;
  scheduledFor?: string;
  passwordProtected?: boolean;
  registrationEnabled?: boolean;
  status?: RoomStatus;
}

export interface WorkspaceStudioCatalogListResponse {
  roomId: string;
  exportedAt: string;
  studios: WorkspaceStudioCatalogEntry[];
}

// ============ Studio Media Types ============

export type StudioMediaType = 'video' | 'image' | 'pdf' | 'presentation' | 'file';

export interface PresentationSlidePreview {
  id: string;
  title: string;
  lines: string[];
  imageUrl?: string;
  rendered?: boolean;
  notes?: string[];
}

export interface StudioMediaAssetPreview {
  kind: 'presentation-slides';
  sourceFormat: 'pptx' | 'pdf';
  slides: PresentationSlidePreview[];
}

export interface StudioMediaAsset {
  id: string;
  name: string;
  url: string;
  type: StudioMediaType;
  mimeType: string;
  sizeBytes?: number;
  createdAt: string;
  source: 'upload' | 'url';
  preview?: StudioMediaAssetPreview;
  processingStatus?: 'processing' | 'ready' | 'error';
  processingMessage?: string;
}

export interface ActiveMedia {
  assetId?: string;
  type: StudioMediaType;
  url: string;
  name: string;
  preview?: StudioMediaAssetPreview;
}

// ============ Stream Destination Types ============

export interface StreamDestination {
  id: string;
  platform: 'youtube' | 'facebook' | 'twitch' | 'linkedin' | 'instagram' | 'custom';
  name: string;
  rtmpUrl: string;
  streamKey: string;
  enabled: boolean;
  status: 'idle' | 'connecting' | 'live' | 'error';
  statusMessage?: string;
  /** Keep the stream key when this destination is remembered on the device. */
  rememberStreamKey?: boolean;
  /** Present when the studio created the broadcast through a connected account. */
  connection?: StreamDestinationConnection;
}

export interface StreamDestinationConnection {
  provider: 'youtube';
  broadcastId: string;
  watchUrl: string;
  studioUrl: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  liveChatId?: string;
}

// ============ RTMP Relay Protocol Types ============

export interface LiveStreamTokenClaims {
  v: 1;
  roomId: string;
  participantId: string;
  role: Extract<ParticipantRole, 'host' | 'co-host'>;
  /** The studio's private watch-page id; the HLS watch page is published under it, never under the room id. */
  watchId?: string;
  iat?: number;
  exp: number;
  nonce: string;
}

/**
 * Signed identity used exclusively by the SFU control/media socket. Unlike a
 * live-stream token it is valid for admitted guests as well as operators.
 */
export interface SfuTokenClaims {
  v: 1;
  purpose: 'sfu';
  roomId: string;
  participantId: string;
  role: ParticipantRole;
  iat?: number;
  exp: number;
  nonce: string;
}

/**
 * Authorizes POST /presentation-preview and /presentation-pdf on the media
 * server for an admitted host or co-host, and nothing else.
 */
export interface PresentationRenderTokenClaims {
  v: 1;
  purpose: 'presentation-render';
  roomId: string;
  participantId: string;
  role: Extract<ParticipantRole, 'host' | 'co-host'>;
  iat: number;
  exp: number;
  nonce: string;
}

export type SfuMembershipControlAction = 'revoke-participant' | 'allow-participant' | 'revoke-room' | 'revoke-recording-upload';

export interface SfuMembershipControlClaims {
  v: 1;
  purpose: 'sfu-control';
  action: SfuMembershipControlAction;
  roomId: string;
  participantId?: string;
  reason?: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface RecordingUploadTokenClaims {
  v: 1;
  purpose: 'recording-upload';
  roomId: string;
  participantId: string;
  participantName: string;
  role: ParticipantRole;
  sessionId: string;
  iat?: number;
  exp: number;
  nonce: string;
}

export interface RtmpRelayDestination {
  id: string;
  name: string;
  rtmpUrl: string;
  streamKey: string;
}

export interface RtmpRelayVideoConfig {
  width: number;
  height: number;
  frameRate: number;
  videoBitsPerSecond: number;
}

export interface RtmpRelayAudioConfig {
  sampleRate: number;
  channelCount: number;
  audioBitsPerSecond: number;
}

/** Codecs the browser's MediaRecorder produces for the relay upload. */
export type RtmpRelayVideoCodec = 'h264' | 'vp8' | 'vp9' | 'unknown';
export type RtmpRelayAudioCodec = 'opus' | 'aac' | 'unknown';

/**
 * What the studio uploads. H.264 with a known keyframe interval lets the
 * media server copy the video instead of re-encoding it (the free tier's
 * CPU cannot run a real-time x264 encode).
 */
export interface RtmpRelayEncoding {
  container: 'webm' | 'matroska';
  videoCodec: RtmpRelayVideoCodec;
  audioCodec: RtmpRelayAudioCodec;
  /** Keyframe interval the browser was asked for, or null when it cannot be controlled. */
  keyframeIntervalMs: number | null;
}

/**
 * copy: the browser's H.264 goes to the destinations untouched (audio to AAC).
 * transcode: the server re-encodes with libx264 (slow on the free tier).
 */
export type RtmpRelayVideoMode = 'copy' | 'transcode';

export interface RtmpRelayStartPayload {
  token: string;
  destinations: RtmpRelayDestination[];
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
  /** Missing on older studios: treated as VP8 WebM. */
  encoding?: RtmpRelayEncoding;
}

/** The server's live encoder, from FFmpeg's progress report (every ~2 s). */
export interface RtmpRelayEncoderStats {
  videoMode: RtmpRelayVideoMode;
  /** Processing speed against real time; below 1 the output falls behind. */
  speed: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  /** Frames FFmpeg dropped or duplicated to keep the output rate. */
  droppedFrames: number;
  duplicatedFrames: number;
  at: number;
}

/** One destination's uploader: what actually leaves the server for that platform. */
export interface RtmpRelayDestinationStats {
  destinationId: string;
  bitrateKbps: number | null;
  speed: number | null;
  at: number;
}

export interface RtmpRelayPingPayload {
  sentAt: number;
  sequence: number;
}

export type RtmpRelayClientMessage =
  | { type: 'start'; payload: RtmpRelayStartPayload }
  | { type: 'stop'; payload?: Record<string, never> }
  | { type: 'ping'; payload: RtmpRelayPingPayload };

export type RtmpRelayDestinationStatus = 'connecting' | 'live' | 'error' | 'idle';
export type RtmpRelayBackupRecordingStatus = 'recording' | 'finalizing' | 'ready' | 'error' | 'disabled';

export interface RtmpRelayBackupRecordingPayload {
  backupId: string;
  roomId: string;
  fileName: string;
  startedAt: string;
  stoppedAt?: string;
  status: RtmpRelayBackupRecordingStatus;
  sizeBytes?: number;
  downloadPath?: string;
  error?: string;
  /** Copy to object storage (R2/S3), when it is configured. */
  storageStatus?: 'uploading' | 'stored' | 'failed';
}

export type RtmpRelayServerMessage =
  | { type: 'session-started'; payload: { roomId: string; destinationIds: string[]; videoMode?: RtmpRelayVideoMode } }
  | { type: 'encoder-stats'; payload: RtmpRelayEncoderStats }
  | { type: 'destination-stats'; payload: RtmpRelayDestinationStats }
  | { type: 'session-stopped'; payload: { reason?: string } }
  | { type: 'pong'; payload: RtmpRelayPingPayload & { receivedAt: number } }
  | { type: 'destination-status'; payload: { destinationId: string; status: RtmpRelayDestinationStatus; message?: string } }
  | { type: 'backup-recording-status'; payload: RtmpRelayBackupRecordingPayload }
  | { type: 'error'; payload: { code: string; message: string; destinationId?: string } };

// ============ Recording Upload Protocol Types ============

export type RecordingUploadTrackKind = 'audio' | 'video' | 'screen' | 'program' | 'iso';

export interface RecordingUploadTrackManifest {
  id: string;
  label: string;
  kind: RecordingUploadTrackKind;
  mimeType: string;
  expectedBytes?: number;
  durationMs?: number;
  capture?: Record<string, unknown>;
}

export interface RecordingUploadSessionRequest {
  token?: string;
  roomId: string;
  sessionId?: string;
  participantId?: string;
  participantName?: string;
  tracks: RecordingUploadTrackManifest[];
  maxBytes?: number;
}

export interface RecordingUploadTrackStatus {
  id: string;
  label: string;
  kind: RecordingUploadTrackKind;
  mimeType: string;
  bytesReceived: number;
  chunksReceived: number;
  complete: boolean;
}

export interface RecordingUploadSessionResponse {
  uploadId: string;
  roomId: string;
  sessionId?: string;
  participantId?: string;
  participantName?: string;
  createdAt: string;
  expiresAt: string;
  maxBytes: number;
  bytesReceived: number;
  tracks: RecordingUploadTrackStatus[];
}

export interface DistributedRecordingSessionResponse {
  roomId: string;
  sessionId: string;
  uploadCount: number;
  completedUploadCount: number;
  trackCount: number;
  bytesReceived: number;
  uploads: RecordingUploadSessionResponse[];
}

export interface RecordingUploadChunkResponse {
  uploadId: string;
  track: RecordingUploadTrackStatus;
  bytesReceived: number;
}

export type RecordingExportVideoCodec = 'h264' | 'h265';

export interface RecordingExportVideoSettings {
  width?: number;
  height?: number;
  frameRate?: number;
  videoBitsPerSecond?: number;
  codec?: RecordingExportVideoCodec;
}

export interface RecordingExportAudioSettings {
  sampleRate?: number;
  channelCount?: number;
  audioBitsPerSecond?: number;
}

export type RecordingExportClipAspect = 'source' | 'vertical' | 'square';

export interface RecordingExportClipSettings {
  startSeconds?: number;
  endSeconds?: number;
  aspect?: RecordingExportClipAspect;
}

/** Keep only these ranges of the recording, joined in order (transcript cleanup). */
export interface RecordingExportEditSettings {
  keepRanges: Array<{ startSeconds: number; endSeconds: number }>;
}

export interface RecordingExportSessionRequest {
  token?: string;
  basename?: string;
  includeAudioStems?: boolean;
  normalizeAudio?: boolean;
  video?: RecordingExportVideoSettings;
  audio?: RecordingExportAudioSettings;
  clip?: RecordingExportClipSettings;
  edit?: RecordingExportEditSettings;
}

export type RecordingExportJobStatusValue = 'queued' | 'running' | 'ready' | 'error';
export type RecordingExportArtifactFormat = 'mp4' | 'wav' | 'mp3' | 'json';

export interface RecordingExportArtifactStorage {
  provider: 's3';
  bucket: string;
  key: string;
  url?: string;
  uploadedAt?: string;
}

export interface RecordingExportArtifactStatus {
  id: string;
  label: string;
  format: RecordingExportArtifactFormat;
  status: RecordingExportJobStatusValue;
  bytes?: number;
  storage?: RecordingExportArtifactStorage;
  error?: string;
}

export interface RecordingExportJobResponse {
  exportId: string;
  uploadId: string;
  roomId: string;
  sessionId?: string;
  status: RecordingExportJobStatusValue;
  createdAt: string;
  updatedAt: string;
  artifacts: RecordingExportArtifactStatus[];
  error?: string;
}

// ============ Recording Catalog Protocol Types ============

export interface RecordingCatalogCloudSummary {
  provider: 'google-drive';
  fileCount: number;
  totalBytes: number;
  uploadedAt: string;
  expiresAt: string | null;
  permanent: boolean;
}

export interface RecordingCatalogMediaExportSummary {
  status: RecordingExportJobStatusValue;
  uploadId: string;
  exportId: string;
  updatedAt: string;
  readyMp4: boolean;
  mp4ShareUrl?: string;
  artifactCount: number;
  readyArtifactCount: number;
}

export interface RecordingCatalogEntry {
  id: string;
  roomId: string;
  roomName: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number | null;
  trackCount: number;
  totalBytes: number;
  markerCount: number;
  cloud?: RecordingCatalogCloudSummary;
  mediaExport?: RecordingCatalogMediaExportSummary;
}

export interface RecordingCatalogUpsertRequest {
  id: string;
  roomName?: string;
  createdAt: string;
  durationSeconds?: number | null;
  trackCount?: number;
  totalBytes?: number;
  markerCount?: number;
  cloud?: RecordingCatalogCloudSummary;
  mediaExport?: RecordingCatalogMediaExportSummary;
}

export interface RecordingCatalogListResponse {
  roomId: string;
  exportedAt: string;
  recordings: RecordingCatalogEntry[];
}

// ============ Scene Types ============

export interface Scene {
  id: string;
  name: string;
  layout: LayoutMode;
  background: StageBackground;
  brandColor: string;
  logoUrl: string | null;
  cameraShape?: CameraShape;
  nameTagStyle?: NameTagStyle;
  logoPlacement?: LogoPlacement;
  logoPosition?: LogoPosition | null;
  logoSize?: LogoSize;
  logoOpacity?: number;
  pipCorner?: 'TL' | 'TR' | 'BL' | 'BR';
  /** With layout 'custom': the CustomLayout this scene shows. */
  customLayoutId?: string | null;
  focusedVideoItemId?: string | null;
  stageItemOrder?: string[];
  activeMedia?: SceneActiveMedia | null;
  // Which overlay IDs should be visible when this scene is active
  visibleOverlayIds: string[];
}

export interface SceneActiveMedia {
  assetId: string;
  slideIndex?: number;
}

// ============ Custom Layout Types ============

export type CustomLayoutSlotShape = 'rect' | 'rounded' | 'circle';
export type CustomLayoutSlotKind = 'camera' | 'content';

/**
 * One box of a custom layout. x, y, w and h are fractions (0..1) of the
 * program canvas, so a layout fits any output size of its orientation.
 */
export interface CustomLayoutSlot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order; higher slots draw above lower ones. */
  z: number;
  shape: CustomLayoutSlotShape;
  kind: CustomLayoutSlotKind;
  /** A camera slot pinned to one stage item; unpinned slots fill in stage order. */
  participantId?: string | null;
}

export interface CustomLayout {
  id: string;
  name: string;
  /** The canvas the layout was drawn on: 16:9 landscape or 9:16 portrait. */
  orientation: BroadcastOrientation;
  slots: CustomLayoutSlot[];
}

export const MAX_CUSTOM_LAYOUTS = 12;
export const MAX_CUSTOM_LAYOUT_SLOTS = 9;
export const MAX_CUSTOM_LAYOUT_NAME_LENGTH = 40;
/** The smallest slot edge, as a fraction of the canvas. */
export const MIN_CUSTOM_LAYOUT_SLOT_SIZE = 0.04;

const CUSTOM_LAYOUT_SLOT_SHAPES: readonly CustomLayoutSlotShape[] = ['rect', 'rounded', 'circle'];
const CUSTOM_LAYOUT_SLOT_KINDS: readonly CustomLayoutSlotKind[] = ['camera', 'content'];
const CUSTOM_LAYOUT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function customLayoutRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function customLayoutFraction(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function customLayoutText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, maxLength);
}

/** A slot kept inside the canvas and at least the minimum size; null when unusable. */
export function normalizeCustomLayoutSlot(value: unknown, index = 0): CustomLayoutSlot | null {
  const raw = customLayoutRecord(value);
  if (!raw) return null;
  const id = typeof raw.id === 'string' && CUSTOM_LAYOUT_ID_PATTERN.test(raw.id) ? raw.id : `slot-${index + 1}`;
  const w = Math.max(MIN_CUSTOM_LAYOUT_SLOT_SIZE, customLayoutFraction(raw.w, 0.5));
  const h = Math.max(MIN_CUSTOM_LAYOUT_SLOT_SIZE, customLayoutFraction(raw.h, 0.5));
  const x = Math.min(1 - w, customLayoutFraction(raw.x, 0));
  const y = Math.min(1 - h, customLayoutFraction(raw.y, 0));
  const zNumber = Number(raw.z);
  const z = Number.isFinite(zNumber) ? Math.min(99, Math.max(0, Math.round(zNumber))) : index;
  const shape = CUSTOM_LAYOUT_SLOT_SHAPES.includes(raw.shape as CustomLayoutSlotShape)
    ? raw.shape as CustomLayoutSlotShape
    : 'rect';
  const kind = CUSTOM_LAYOUT_SLOT_KINDS.includes(raw.kind as CustomLayoutSlotKind)
    ? raw.kind as CustomLayoutSlotKind
    : 'camera';
  const participantId = kind === 'camera' ? customLayoutText(raw.participantId, 128) : '';
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    id,
    x: round(x),
    y: round(y),
    w: round(w),
    h: round(h),
    z,
    shape,
    kind,
    ...(participantId ? { participantId } : {}),
  };
}

/** A layout with unique slot ids, at most one content slot and at most MAX_CUSTOM_LAYOUT_SLOTS slots. */
export function normalizeCustomLayout(value: unknown): CustomLayout | null {
  const raw = customLayoutRecord(value);
  if (!raw) return null;
  const id = typeof raw.id === 'string' && CUSTOM_LAYOUT_ID_PATTERN.test(raw.id) ? raw.id : '';
  const name = customLayoutText(raw.name, MAX_CUSTOM_LAYOUT_NAME_LENGTH);
  if (!id || !name) return null;
  const orientation: BroadcastOrientation = raw.orientation === 'portrait' ? 'portrait' : 'landscape';
  const slots: CustomLayoutSlot[] = [];
  const ids = new Set<string>();
  let hasContent = false;
  const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
  for (let index = 0; index < rawSlots.length && slots.length < MAX_CUSTOM_LAYOUT_SLOTS; index += 1) {
    const slot = normalizeCustomLayoutSlot(rawSlots[index], index);
    if (!slot) continue;
    if (slot.kind === 'content') {
      if (hasContent) continue;
      hasContent = true;
    }
    let slotId = slot.id;
    for (let suffix = 2; ids.has(slotId); suffix += 1) slotId = `${slot.id}-${suffix}`.slice(0, 64);
    ids.add(slotId);
    slots.push({ ...slot, id: slotId });
  }
  if (slots.length === 0) return null;
  return { id, name, orientation, slots };
}

export function normalizeCustomLayouts(value: unknown): CustomLayout[] {
  if (!Array.isArray(value)) return [];
  const layouts: CustomLayout[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (layouts.length >= MAX_CUSTOM_LAYOUTS) break;
    const layout = normalizeCustomLayout(item);
    if (!layout || ids.has(layout.id)) continue;
    ids.add(layout.id);
    layouts.push(layout);
  }
  return layouts;
}

// ============ Brand Font Types ============

/** Open-licence faces bundled with the studio (same origin, no font CDN). */
export type BrandFontPresetId =
  | 'inter'
  | 'montserrat'
  | 'poppins'
  | 'oswald'
  | 'playfair-display'
  | 'roboto-slab'
  | 'bebas-neue';

export const BRAND_FONT_PRESET_IDS: readonly BrandFontPresetId[] = [
  'inter',
  'montserrat',
  'poppins',
  'oswald',
  'playfair-display',
  'roboto-slab',
  'bebas-neue',
];

/**
 * The brand typeface for banners, tickers, lower thirds and widget text. An
 * uploaded file stays in the browser that added it (IndexedDB, by fileId);
 * elsewhere the studio falls back to Inter.
 */
export type BrandFont =
  | { source: 'preset'; presetId: BrandFontPresetId }
  | { source: 'upload'; family: string; fileId: string; fileName: string };

export const MAX_BRAND_FONT_FAMILY_LENGTH = 48;

/** Font family names are kept to letters, digits, spaces, dashes and underscores. */
export function normalizeBrandFontFamilyName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_BRAND_FONT_FAMILY_LENGTH);
}

export function normalizeBrandFont(value: unknown): BrandFont | null {
  const raw = customLayoutRecord(value);
  if (!raw) return null;
  if (raw.source === 'preset') {
    return BRAND_FONT_PRESET_IDS.includes(raw.presetId as BrandFontPresetId)
      ? { source: 'preset', presetId: raw.presetId as BrandFontPresetId }
      : null;
  }
  if (raw.source === 'upload') {
    const family = normalizeBrandFontFamilyName(raw.family);
    const fileId = typeof raw.fileId === 'string' && CUSTOM_LAYOUT_ID_PATTERN.test(raw.fileId) ? raw.fileId : '';
    const fileName = customLayoutText(raw.fileName, 120);
    if (!family || !fileId) return null;
    return { source: 'upload', family, fileId, fileName: fileName || family };
  }
  return null;
}
