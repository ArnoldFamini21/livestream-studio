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
}

export type RoomStatus = 'waiting' | 'scheduled' | 'live' | 'recording' | 'ended';

export interface RoomSettings {
  maxParticipants: number;
  resolution: VideoResolution;
  frameRate: number;
  enableRecording: boolean;
  enableStreaming: boolean;
  greenRoomEnabled: boolean;
  passwordProtected: boolean;
}

export type VideoResolution = '720p' | '1080p' | '4k';

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
  | { type: 'recording-state-changed'; payload: RecordingStatePayload }
  | { type: 'live-stream-token-request'; payload: LiveStreamTokenRequestPayload }
  | { type: 'live-stream-token-issued'; payload: LiveStreamTokenIssuedPayload }
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
}

export interface RoomJoinedPayload {
  room: Room;
  participant: Participant;
  participants: Participant[];
  qaQuestions?: QAQuestion[];
  polls?: LivePoll[];
  recordingState?: RecordingStatePayload;
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
  action: 'move-to-stage' | 'move-to-backstage' | 'move-to-green-room' | 'notify-next' | 'promote-co-host' | 'demote-to-guest' | 'mute' | 'unmute' | 'remove';
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

export interface RecordingStatePayload {
  recording: boolean;
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
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  isBackstage: boolean;
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

export type OverlayType = 'lower-third' | 'logo' | 'banner' | 'background' | 'ticker';

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
  type: 'color' | 'image' | 'gradient' | 'none';
  value: string;
}

// ============ Advanced Participant Visual Types ============

export type CameraShape = 'rectangle' | 'rounded' | 'square' | 'circle';
export type NameTagStyle = 'classic' | 'minimal' | 'block';
export type LogoPlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type LogoSize = 'small' | 'medium' | 'large';

// ============ Studio Media Types ============

export type StudioMediaType = 'video' | 'image' | 'pdf' | 'presentation' | 'file';

export interface StudioMediaAsset {
  id: string;
  name: string;
  url: string;
  type: StudioMediaType;
  mimeType: string;
  sizeBytes?: number;
  createdAt: string;
  source: 'upload' | 'url';
}

export interface ActiveMedia {
  assetId?: string;
  type: StudioMediaType;
  url: string;
  name: string;
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

export type RtmpRelayClientMessage =
  | { type: 'start'; payload: RtmpRelayStartPayload }
  | { type: 'stop'; payload?: Record<string, never> };

export type RtmpRelayDestinationStatus = 'connecting' | 'live' | 'error' | 'idle';

export type RtmpRelayServerMessage =
  | { type: 'session-started'; payload: { roomId: string; destinationIds: string[] } }
  | { type: 'session-stopped'; payload: { reason?: string } }
  | { type: 'destination-status'; payload: { destinationId: string; status: RtmpRelayDestinationStatus; message?: string } }
  | { type: 'error'; payload: { code: string; message: string; destinationId?: string } };

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
  logoSize?: LogoSize;
  // Which overlay IDs should be visible when this scene is active
  visibleOverlayIds: string[];
}
