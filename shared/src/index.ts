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
  | { type: 'stage-action'; payload: StageActionPayload }
  | { type: 'participant-updated'; payload: Participant }
  | { type: 'end-room'; payload: Record<string, never> }
  | { type: 'room-ending'; payload: { countdown: number } }
  | { type: 'room-ended'; payload: Record<string, never> }
  | { type: 'room-ending-cancelled'; payload: Record<string, never> }
  | { type: 'host-changed'; payload: { newHostId: string; newHostName: string } }
  | { type: 'error'; payload: { message: string; code: string } };

export interface JoinRoomPayload {
  roomId: string;
  name: string;
  role: ParticipantRole;
}

export interface RoomJoinedPayload {
  room: Room;
  participant: Participant;
  participants: Participant[];
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
  action: 'move-to-stage' | 'move-to-backstage' | 'move-to-green-room' | 'promote-co-host' | 'demote-to-guest' | 'mute' | 'remove';
  targetParticipantId: string;
  performedBy: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  isBackstage: boolean;
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

// ============ Scene Types ============

export interface Scene {
  id: string;
  name: string;
  layout: LayoutMode;
  background: StageBackground;
  brandColor: string;
  logoUrl: string | null;
  // Which overlay IDs should be visible when this scene is active
  visibleOverlayIds: string[];
}
