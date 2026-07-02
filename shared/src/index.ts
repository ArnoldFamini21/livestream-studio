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
}

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

// ============ Signaling Types ============

export type SignalMessage =
  | { type: 'join-room'; payload: JoinRoomPayload }
  | { type: 'room-joined'; payload: RoomJoinedPayload }
  | { type: 'participant-joined'; payload: Participant }
  | { type: 'participant-left'; payload: { participantId: string } }
  | { type: 'offer'; payload: SDPPayload }
  | { type: 'answer'; payload: SDPPayload }
  | { type: 'ice-candidate'; payload: ICEPayload }
  | { type: 'media-state-changed'; payload: MediaStatePayload }
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
  | { type: 'recording-state-changed'; payload: RecordingStatePayload }
  | { type: 'live-stream-state-changed'; payload: LiveStreamStatePayload }
  | { type: 'live-stream-token-request'; payload: LiveStreamTokenRequestPayload }
  | { type: 'live-stream-token-issued'; payload: LiveStreamTokenIssuedPayload }
  | { type: 'external-chat-connect'; payload: ExternalChatConnectPayload }
  | { type: 'external-chat-disconnect'; payload: ExternalChatDisconnectPayload }
  | { type: 'external-chat-status'; payload: ExternalChatStatusPayload }
  | { type: 'co-host-invite-token-request'; payload: CoHostInviteTokenRequestPayload }
  | { type: 'co-host-invite-token-issued'; payload: CoHostInviteTokenIssuedPayload }
  | { type: 'participant-updated'; payload: Participant }
  | { type: 'participant-removed'; payload: { reason: string } }
  | { type: 'end-room'; payload: Record<string, never> }
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
  roomPassword?: string;
  joinSessionId?: string;
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
  features?: {
    chatTyping?: boolean;
  };
}

export interface SDPPayload {
  from: string;
  to: string;
  sdp: RTCSessionDescriptionInit;
}

export interface ICEPayload {
  from: string;
  to: string;
  candidate: RTCIceCandidateInit;
}

export interface MediaStatePayload {
  participantId: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
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

export interface RecordingStatePayload {
  recording: boolean;
  startedAt?: string;
  stoppedAt?: string;
  performedBy: string;
}

export interface LiveStreamStatePayload {
  live: boolean;
  startedAt?: string;
  stoppedAt?: string;
  performedBy: string;
}

export interface LiveStreamTokenRequestPayload {
  requestId: string;
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

export type LayoutMode = 'grid' | 'spotlight' | 'side-by-side' | 'pip' | 'single' | 'featured';

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

// ============ Studio Media Types ============

export type StudioMediaType = 'video' | 'image' | 'pdf' | 'presentation' | 'file';

export interface PresentationSlidePreview {
  id: string;
  title: string;
  lines: string[];
  imageUrl?: string;
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
}

// ============ RTMP Relay Protocol Types ============

export interface LiveStreamTokenClaims {
  v: 1;
  roomId: string;
  participantId: string;
  role: Extract<ParticipantRole, 'host' | 'co-host'>;
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

export interface RtmpRelayStartPayload {
  token: string;
  destinations: RtmpRelayDestination[];
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
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
}

export type RtmpRelayServerMessage =
  | { type: 'session-started'; payload: { roomId: string; destinationIds: string[] } }
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
  createdAt: string;
  expiresAt: string;
  maxBytes: number;
  bytesReceived: number;
  tracks: RecordingUploadTrackStatus[];
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

export interface RecordingExportSessionRequest {
  token?: string;
  basename?: string;
  includeAudioStems?: boolean;
  video?: RecordingExportVideoSettings;
  audio?: RecordingExportAudioSettings;
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
  focusedVideoItemId?: string | null;
  stageItemOrder?: string[];
  // Which overlay IDs should be visible when this scene is active
  visibleOverlayIds: string[];
}
