import { lazy, Suspense, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ActiveMedia, LogoPlacement, LogoSize, SignalMessage, Participant, Room, LayoutMode, ChatMessage, ChatReactionType, StreamDestination, StageActionPayload, StageBackground, Scene, CameraShape, NameTagStyle, QAQuestion, StudioMediaAsset, ParticipantNotificationPayload, LivePoll, BroadcastOrientation } from '@studio/shared';
import { ROOM_NOT_OPEN_ERROR_CODE } from '@studio/shared';

function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}

import { useSignaling } from '../hooks/useSignaling.ts';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';
import { useWebRTC } from '../hooks/useWebRTC.ts';
import { useVirtualBackground, type VirtualBackgroundConfig } from '../hooks/useVirtualBackground.ts';
import { useRecording } from '../hooks/useRecording.ts';
import { useScreenShare } from '../hooks/useScreenShare.ts';
import { useLocalRecording, type LocalRecordingSource } from '../hooks/useLocalRecording.ts';
import { useCompositor } from '../hooks/useCompositor.ts';
import { useLiveCaptions } from '../hooks/useLiveCaptions.ts';
import { useRtmpRelay } from '../hooks/useRtmpRelay.ts';
import { useSessionHealth, type HealthStatus } from '../hooks/useSessionHealth.ts';
import { VideoTile } from './VideoTile.tsx';
import { ControlBar } from './ControlBar.tsx';
import { DeviceSelector } from './DeviceSelector.tsx';
import { Sidebar, type SidebarTab } from './Sidebar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { LowerThirdOverlay, type LowerThirdData } from './LowerThird.tsx';
import { detectMediaType } from './MediaLibrary.tsx';
import type { ProductionSceneTemplate } from './SceneManager.tsx';
import { BannerOverlayDisplay, type BannerData } from './BannerOverlay.tsx';
import { TimerOverlayDisplay, useTimerTick, type TimerData } from './TimerOverlay.tsx';
import { LayoutSwitcher } from './LayoutSwitcher.tsx';
import { CommentHighlightOverlay, type HighlightedComment } from './CommentHighlight.tsx';
import { TickerOverlayDisplay, type TickerData } from './TickerOverlay.tsx';
import { WebinarQAPanel, WebinarQAOverlay, WebinarQAAudience } from './WebinarQA.tsx';
import { SessionHealthPanel } from './SessionHealthPanel.tsx';
import { LivePollsPanel, LivePollOverlay } from './LivePolls.tsx';
import { LiveCaptionsPanel, LiveCaptionOverlay } from './LiveCaptions.tsx';
import type { RecordingMarker } from './RecordingPanel.tsx';

const STUDIO_STATE_VERSION = 1;
const INVITE_BASE_URL = import.meta.env.VITE_INVITE_BASE_URL || window.location.origin;
const MAX_PERSISTED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_STUDIO_SCENES = 12;
const HOST_STUDIOS_STORAGE_KEY = 'livestream-studio:scheduled-studios';
const GUEST_JOIN_SESSION_STORAGE_KEY = 'livestream-studio:guest-join-session-id';

const StreamDestinationsPanel = lazy(() => import('./StreamDestinations.tsx').then((module) => ({ default: module.StreamDestinations })));
const InvitePanel = lazy(() => import('./InvitePanel.tsx').then((module) => ({ default: module.InvitePanel })));
const SoundBoard = lazy(() => import('./SoundBoard.tsx').then((module) => ({ default: module.SoundBoard })));
const Teleprompter = lazy(() => import('./Teleprompter.tsx').then((module) => ({ default: module.Teleprompter })));
const BackgroundMusic = lazy(() => import('./BackgroundMusic.tsx').then((module) => ({ default: module.BackgroundMusic })));
const RecordingPanel = lazy(() => import('./RecordingPanel.tsx').then((module) => ({ default: module.RecordingPanel })));
const ProducerPanel = lazy(() => import('./ProducerPanel.tsx').then((module) => ({ default: module.ProducerPanel })));

function upsertChatMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((message) => (
    message.id === incoming.id ||
    (incoming.clientId !== undefined && message.id === incoming.clientId)
  ));
  const next = index >= 0 ? [...messages] : [...messages, incoming];
  if (index >= 0) {
    next[index] = incoming;
  }
  return next.length > 500 ? next.slice(-500) : next;
}

function forgetSavedHostStudio(roomId: string) {
  try {
    const raw = localStorage.getItem(HOST_STUDIOS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    localStorage.setItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(parsed.filter((item) => item?.id !== roomId)));
  } catch {
    // Ignore malformed local host-token cache.
  }
}

interface SavedHostStudio {
  id: string;
  hostName: string;
  hostToken: string;
}

function getSavedHostStudio(roomId: string): SavedHostStudio | null {
  try {
    const raw = localStorage.getItem(HOST_STUDIOS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const match = parsed.find((item) => item && item.id === roomId);
    if (
      match &&
      typeof match.id === 'string' &&
      typeof match.hostName === 'string' &&
      typeof match.hostToken === 'string' &&
      match.hostToken.length > 0
    ) {
      return {
        id: match.id,
        hostName: match.hostName,
        hostToken: match.hostToken,
      };
    }
  } catch {
    // Ignore malformed local host-token cache.
  }
  return null;
}

function isValidJoinSessionId(value: string | null): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function createJoinSessionId(): string {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return `guest-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
}

function getGuestJoinSessionId(): string | undefined {
  let existing: string | null = null;
  try {
    existing = localStorage.getItem(GUEST_JOIN_SESSION_STORAGE_KEY);
  } catch {
    existing = null;
  }
  if (isValidJoinSessionId(existing)) return existing;

  let fallbackExisting: string | null = null;
  try {
    fallbackExisting = sessionStorage.getItem(GUEST_JOIN_SESSION_STORAGE_KEY);
  } catch {
    fallbackExisting = null;
  }
  if (isValidJoinSessionId(fallbackExisting)) return fallbackExisting;

  const created = createJoinSessionId();
  try {
    localStorage.setItem(GUEST_JOIN_SESSION_STORAGE_KEY, created);
  } catch {
    try {
      sessionStorage.setItem(GUEST_JOIN_SESSION_STORAGE_KEY, created);
    } catch {
      return created;
    }
  }
  return created;
}

interface PersistedStudioState {
  version: typeof STUDIO_STATE_VERSION;
  layout: LayoutMode;
  stageBackground: StageBackground;
  brandColor: string;
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
  logoSize: LogoSize;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  pipCorner: 'TL' | 'TR' | 'BL' | 'BR';
  mediaAssets: StudioMediaAsset[];
  scenes: Scene[];
  activeSceneId: string | null;
  lowerThirds: LowerThirdData[];
  banners: BannerData[];
  timers: TimerData[];
  tickers: TickerData[];
}

interface PendingLiveTokenRequest {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCoHostInviteRequest {
  resolve: (payload: { token: string; expiresAt: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function getStudioStateKey(roomId: string): string {
  return `livestream-studio:room-state:${roomId}`;
}

function getRecordingSourceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'track';
}

function normalizeRecordingMarkerLabel(value: string): string {
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 120) || 'Marker';
}

function LazyPanelFallback() {
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        right: 16,
        bottom: 74,
        zIndex: 70,
        padding: '10px 14px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-secondary)',
        fontSize: 12,
        fontWeight: 700,
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      Loading panel...
    </div>
  );
}

function buildCoHostInviteUrl(baseInviteUrl: string, token: string): string {
  try {
    const url = new URL(baseInviteUrl);
    url.searchParams.set('role', 'co-host');
    url.searchParams.set('invite', token);
    return url.toString();
  } catch {
    const separator = baseInviteUrl.includes('?') ? '&' : '?';
    return `${baseInviteUrl}${separator}role=co-host&invite=${encodeURIComponent(token)}`;
  }
}

function getHealthColor(status: HealthStatus): string {
  switch (status) {
    case 'good': return 'var(--success)';
    case 'warning': return 'var(--warning)';
    case 'bad': return 'var(--danger)';
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getStreamDestinationIssue(dest: Pick<StreamDestination, 'rtmpUrl' | 'streamKey'>): string | null {
  const rtmpUrl = dest.rtmpUrl.trim();
  if (!rtmpUrl) return 'Missing RTMP server URL';
  try {
    const parsed = new URL(rtmpUrl);
    if (parsed.protocol !== 'rtmp:' && parsed.protocol !== 'rtmps:') {
      return 'Invalid RTMP server URL';
    }
  } catch {
    return 'Invalid RTMP server URL';
  }
  if (!dest.streamKey.trim()) return 'Missing stream key';
  return null;
}

function canExchangeStudioMedia(a: Participant | null | undefined, b: Participant | null | undefined): boolean {
  return a?.status === 'on-stage' && b?.status === 'on-stage';
}

function isPersistableLogoUrl(url: string | null): url is string {
  return Boolean(url && !url.startsWith('blob:'));
}

function getPersistableStageBackground(background: StageBackground): StageBackground {
  if (background.type === 'image' && background.value.startsWith('blob:')) {
    return { type: 'none', value: '' };
  }
  return background;
}

function getPersistableScenes(scenes: Scene[]): Scene[] {
  return scenes.map((scene) => ({
    ...scene,
    background: getPersistableStageBackground(scene.background),
    logoUrl: isPersistableLogoUrl(scene.logoUrl) ? scene.logoUrl : null,
  }));
}

function getMaxNumericSuffix(items: Array<{ id: string }> | undefined, prefix: string): number {
  if (!items) return 0;
  return items.reduce((max, item) => {
    const value = Number(item.id.replace(`${prefix}-`, ''));
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
}

function getMediaNameFromUrl(url: string, type: 'video' | 'image'): string {
  if (url.startsWith('data:')) {
    return type === 'video' ? 'Inline video' : 'Inline image';
  }
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (lastSegment) return decodeURIComponent(lastSegment);
  } catch {
    // Fall back to a readable generated name below.
  }
  return type === 'video' ? 'Video URL' : 'Image URL';
}

function getTemplateSceneConfig(template: ProductionSceneTemplate): {
  name: string;
  layout: LayoutMode;
  background: StageBackground;
  brandColor: string;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  banner?: Omit<BannerData, 'id'>;
  ticker?: Omit<TickerData, 'id'>;
  timer?: Omit<TimerData, 'id'>;
} {
  switch (template) {
    case 'starting-soon':
      return {
        name: 'Starting Soon',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #312e81 55%, #0e7490 100%)' },
        brandColor: '#67e8f9',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Starting Soon',
          visible: true,
          style: 'custom',
          customColor: '#0e7490',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Welcome. The live broadcast will begin shortly.',
          visible: true,
          speed: 'normal',
          backgroundColor: '#0f172a',
          textColor: '#e0f2fe',
          separator: '•',
        },
        timer: {
          mode: 'countdown',
          durationSeconds: 300,
          remainingSeconds: 300,
          isRunning: false,
          visible: true,
          position: 'top-right',
          style: 'bold',
        },
      };
    case 'brb':
      return {
        name: 'Be Right Back',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #14532d 58%, #065f46 100%)' },
        brandColor: '#34d399',
        cameraShape: 'rounded',
        nameTagStyle: 'minimal',
        banner: {
          text: 'Be Right Back',
          visible: true,
          style: 'custom',
          customColor: '#059669',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'We will be back in a moment.',
          visible: true,
          speed: 'slow',
          backgroundColor: '#052e16',
          textColor: '#bbf7d0',
          separator: '•',
        },
      };
    case 'ending':
      return {
        name: 'Ending',
        layout: 'single',
        background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #7f1d1d 58%, #991b1b 100%)' },
        brandColor: '#f87171',
        cameraShape: 'rounded',
        nameTagStyle: 'block',
        banner: {
          text: 'Thanks for watching',
          visible: true,
          style: 'custom',
          customColor: '#dc2626',
          isTicker: false,
          position: 'top',
        },
        ticker: {
          text: 'Follow the host for the next live session.',
          visible: true,
          speed: 'normal',
          backgroundColor: '#450a0a',
          textColor: '#fee2e2',
          separator: '•',
        },
      };
  }
}

function getLogoPlacementStyle(placement: LogoPlacement): React.CSSProperties {
  switch (placement) {
    case 'top-left':
      return { top: 12, left: 12 };
    case 'top-right':
      return { top: 12, right: 12 };
    case 'bottom-left':
      return { bottom: 12, left: 12 };
    case 'bottom-right':
      return { bottom: 12, right: 12 };
  }
}

function getLogoSizeStyle(size: LogoSize): React.CSSProperties {
  switch (size) {
    case 'small':
      return { maxHeight: 28, maxWidth: 84 };
    case 'medium':
      return { maxHeight: 42, maxWidth: 128 };
    case 'large':
      return { maxHeight: 58, maxWidth: 180 };
  }
}

export function StudioRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const savedHostStudio = useMemo(() => (roomId ? getSavedHostStudio(roomId) : null), [roomId]);
  const userName = sessionStorage.getItem('userName') || savedHostStudio?.hostName || 'Anonymous';
  const storedUserRole = (sessionStorage.getItem('userRole') || 'guest') as 'host' | 'co-host' | 'guest';
  const roomHostToken = roomId ? sessionStorage.getItem(`hostToken:${roomId}`) || savedHostStudio?.hostToken || '' : '';
  const userRole: 'host' | 'co-host' | 'guest' = roomHostToken
    ? 'host'
    : storedUserRole === 'host'
      ? 'guest'
      : storedUserRole;

  const [room, setRoom] = useState<Room | null>(null);
  const [myParticipant, setMyParticipant] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map());
  const [joined, setJoined] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [mediaAttemptComplete, setMediaAttemptComplete] = useState(false);

  // UI panels
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showStreamDest, setShowStreamDest] = useState(false);
  const [showSoundBoard, setShowSoundBoard] = useState(false);
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [showBackgroundMusic, setShowBackgroundMusic] = useState(false);
  const [showRecordingPanel, setShowRecordingPanel] = useState(false);
  const [showProducerPanel, setShowProducerPanel] = useState(false);
  const [showWebinarQA, setShowWebinarQA] = useState(false);
  const [showPolls, setShowPolls] = useState(false);
  const [showCaptionsPanel, setShowCaptionsPanel] = useState(false);
  const [showHealthPanel, setShowHealthPanel] = useState(false);
  const [showGuestChat, setShowGuestChat] = useState(false);
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [sidebarActiveTab, setSidebarActiveTab] = useState<SidebarTab | null>('people');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [guestNotification, setGuestNotification] = useState<ParticipantNotificationPayload | null>(null);

  // Layout
  const [layout, setLayout] = useState<LayoutMode>('grid');

  // Lower thirds
  const [lowerThirds, setLowerThirds] = useState<LowerThirdData[]>([]);

  // Banners
  const [banners, setBanners] = useState<BannerData[]>([]);

  // Timers
  const [timers, setTimers] = useState<TimerData[]>([]);

  // Stream destinations
  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [broadcastOrientation, setBroadcastOrientation] = useState<BroadcastOrientation>('landscape');
  const [isLive, setIsLive] = useState(false);

  // Room ending countdown — driven by server-issued absolute end time.
  const [roomEnding, setRoomEnding] = useState(false);
  const [roomEndsAt, setRoomEndsAt] = useState<number | null>(null);
  const [endingCountdown, setEndingCountdown] = useState(10);
  const [sessionRecordingStartedAt, setSessionRecordingStartedAt] = useState<string | null>(null);
  const [sessionRecordingElapsed, setSessionRecordingElapsed] = useState(0);

  // Media overlay
  const [activeMedia, setActiveMedia] = useState<ActiveMedia | null>(null);
  const [mediaAssets, setMediaAssets] = useState<StudioMediaAsset[]>([]);

  const [stageBackground, setStageBackground] = useState<StageBackground>({ type: 'none', value: '' });
  const [brandColor, setBrandColor] = useState('#a78bfa');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoPlacement, setLogoPlacement] = useState<LogoPlacement>('top-right');
  const [logoSize, setLogoSize] = useState<LogoSize>('medium');
  const [cameraShape, setCameraShape] = useState<CameraShape>('rectangle');
  const [nameTagStyle, setNameTagStyle] = useState<NameTagStyle>('classic');
  const [pipCorner, setPipCorner] = useState<'TL' | 'TR' | 'BL' | 'BR'>('BR');
  const [focusedVideoItemId, setFocusedVideoItemId] = useState<string | null>(null);
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>({});
  const [recordingMarkers, setRecordingMarkers] = useState<RecordingMarker[]>([]);

  // Cleanup blob URLs when logoUrl changes
  useEffect(() => {
    const url = logoUrl;
    return () => {
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [logoUrl]);

  // Scenes
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);

  // Comment highlighting
  const [highlightedComment, setHighlightedComment] = useState<HighlightedComment | null>(null);

  // Tickers
  const [tickers, setTickers] = useState<TickerData[]>([]);

  // Webinar Q&A
  const [qaQuestions, setQAQuestions] = useState<QAQuestion[]>([]);
  const [myUpvotes, setMyUpvotes] = useState<Set<string>>(new Set());
  const [polls, setPolls] = useState<LivePoll[]>([]);
  const [myPollVotes, setMyPollVotes] = useState<Record<string, string>>({});
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionLanguage, setCaptionLanguage] = useState('en-US');

  // Hooks
  const { connect, disconnect, send, addHandler, connected, reconnectFailed, retry: retryConnection } = useSignaling();
  const {
    localStream: rawLocalStream, audioEnabled, videoEnabled,
    error: mediaError,
    startMedia, stopMedia, toggleAudio, toggleVideo,
    switchAudioDevice, switchVideoDevice,
    audioDevices, videoDevices, audioOutputDevices,
    selectedAudioDeviceId, selectedVideoDeviceId,
    selectedAudioOutputDeviceId,
    onAudioOutputDeviceChange,
  } = useMediaDevices();

  // Virtual webcam background (Zoom-style). Off by default; persists across sessions.
  const [vbConfig, setVbConfig] = useState<VirtualBackgroundConfig>(() => {
    try {
      const raw = localStorage.getItem('livestream-studio:virtual-background');
      if (raw) {
        const parsed = JSON.parse(raw) as VirtualBackgroundConfig;
        if (parsed && (parsed.mode === 'off' || parsed.mode === 'blur' || parsed.mode === 'image')) {
          return parsed;
        }
      }
    } catch {
      // ignore invalid persisted value
    }
    return { mode: 'off' };
  });
  useEffect(() => {
    try {
      localStorage.setItem('livestream-studio:virtual-background', JSON.stringify(vbConfig));
    } catch {
      // ignore quota errors
    }
  }, [vbConfig]);

  const { outputStream: localStream, ready: vbReady, error: vbError } = useVirtualBackground({
    inputStream: rawLocalStream,
    config: vbConfig,
  });

  const { remoteStreams, connectToPeer, handleOffer, handleAnswer, handleIceCandidate, removePeer, replaceTrack, cleanup } = useWebRTC({
    localStream,
    myParticipantId: myParticipant?.id || null,
    send,
  });

  const broadcastRemoteStreams = useMemo(() => {
    const streams = new Map<string, MediaStream>();
    for (const [id, participant] of participants) {
      const stream = remoteStreams.get(id);
      if (participant.status === 'on-stage' && stream) {
        streams.set(id, stream);
      }
    }
    return streams;
  }, [participants, remoteStreams]);

  const { isRecording, formattedTime, startRecording, downloadRecordings } = useRecording();
  const { screenStream, isScreenSharing, startScreenShare, stopScreenShare } = useScreenShare();
  const {
    isRecording: isLocalRecording,
    formattedTime: localRecFormattedTime,
    recordingLabels: localRecordingLabels,
    startRecording: startLocalRecording,
    stopRecording: stopLocalRecording,
  } = useLocalRecording();

  const effectiveAudioEnabled = audioEnabled && Boolean(localStream?.getAudioTracks()[0]);
  const effectiveVideoEnabled = videoEnabled && Boolean(localStream?.getVideoTracks()[0]);
  const isHostOrCoHost = myParticipant?.role === 'host' || myParticipant?.role === 'co-host';
  const sessionHealth = useSessionHealth({
    localStream,
    connected,
    mediaError,
    audioDeviceCount: audioDevices.length,
    videoDeviceCount: videoDevices.length,
    participantCount: participants.size + (myParticipant ? 1 : 0),
    isRecording: isRecording || isLocalRecording || Boolean(sessionRecordingStartedAt),
    isLive,
  });
  const captionsAllowed = Boolean(isHostOrCoHost && myParticipant?.status !== 'green-room');
  const {
    supported: captionsSupported,
    listening: captionsListening,
    error: captionsError,
    activeCaption,
    segments: captionSegments,
    clearCaptions,
  } = useLiveCaptions({
    enabled: captionsAllowed && captionsEnabled,
    language: captionLanguage,
    speakerName: myParticipant?.name || userName,
    maxSegments: 500,
  });
  const broadcastCaption = captionsAllowed ? activeCaption : null;

  useEffect(() => {
    if (!roomId || !savedHostStudio?.hostToken) return;
    try {
      if (!sessionStorage.getItem(`hostToken:${roomId}`)) {
        sessionStorage.setItem(`hostToken:${roomId}`, savedHostStudio.hostToken);
      }
      if (!sessionStorage.getItem('userName') && savedHostStudio.hostName) {
        sessionStorage.setItem('userName', savedHostStudio.hostName);
      }
      sessionStorage.setItem('userRole', 'host');
    } catch {
      // Host-token recovery is best-effort; the join payload still uses the in-memory token.
    }
  }, [roomId, savedHostStudio?.hostName, savedHostStudio?.hostToken]);

  const joinedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const myParticipantRef = useRef<Participant | null>(null);
  const mediaAssetsRef = useRef<StudioMediaAsset[]>(mediaAssets);
  const idCounters = useRef({ lt: 0, dest: 0, banner: 0, timer: 0, ticker: 0, qa: 0, poll: 0, media: 0 });
  const liveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveTokenRequestsRef = useRef<Map<string, PendingLiveTokenRequest>>(new Map());
  const coHostInviteRequestsRef = useRef<Map<string, PendingCoHostInviteRequest>>(new Map());
  const bannerAutoDismissTimersRef = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; durationSeconds: number }>>(new Map());
  const studioStateLoadedRef = useRef(false);
  const audioEnabledRef = useRef(audioEnabled);
  const videoEnabledRef = useRef(videoEnabled);
  const isScreenSharingRef = useRef(isScreenSharing);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const publishedTrackIdsRef = useRef<{ audio?: string; video?: string }>({});

  // Refs for signaling handler dependencies to reduce recreation frequency
  const connectToPeerRef = useRef(connectToPeer);
  // Initial peers we should dial once myParticipant has settled. Stays a ref so we don't trigger renders.
  const initialPeersToConnectRef = useRef<string[]>([]);
  const handleOfferRef = useRef(handleOffer);
  const handleAnswerRef = useRef(handleAnswer);
  const handleIceCandidateRef = useRef(handleIceCandidate);
  const removePeerRef = useRef(removePeer);
  const cleanupRef = useRef(cleanup);
  const disconnectRef = useRef(disconnect);
  const stopMediaRef = useRef(stopMedia);
  const stopScreenShareRef = useRef(stopScreenShare);
  const navigateRef = useRef(navigate);

  // Refs for onToggleScreenShare dependencies
  const replaceTrackRef = useRef(replaceTrack);
  const startScreenShareRef = useRef(startScreenShare);
  const sendRef = useRef(send);

  // Initialize Canvas Compositor for RTMP
  const { compositeStreamRef, compositeCanvasRef } = useCompositor({
    containerRef: stageRef,
    isLive,
    banners,
    lowerThirds,
    timers,
    tickers,
    activeMedia,
    highlightedComment,
    highlightedQA: qaQuestions.find((question) => question.highlighted) || null,
    highlightedPoll: polls.find((poll) => poll.highlighted) || null,
    caption: broadcastCaption,
    stageBackground,
    brandColor,
    logoUrl,
    logoPlacement,
    logoSize,
  });

  const handleRelayDestinationStatus = useCallback((destinationId: string, status: 'connecting' | 'live' | 'error' | 'idle') => {
    setDestinations((prev) => prev.map((destination) => (
      destination.id === destinationId ? { ...destination, status } : destination
    )));
  }, []);

  const {
    startRelay,
    stopRelay,
    stats: relayStats,
    readiness: relayReadiness,
    checkRelayReadiness,
  } = useRtmpRelay({
    compositeStreamRef,
    localStream,
    localParticipantId: myParticipant?.id || null,
    remoteStreams: broadcastRemoteStreams,
    screenStream,
    participantVolumes,
    readinessEnabled: isHostOrCoHost,
    onDestinationStatus: handleRelayDestinationStatus,
  });

  const handleParticipantVolumeChange = useCallback((participantId: string, volume: number) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    setParticipantVolumes((current) => {
      if (current[participantId] === clamped) return current;
      return { ...current, [participantId]: clamped };
    });
  }, []);

  useEffect(() => {
    setParticipantVolumes((current) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [participantId, volume] of Object.entries(current)) {
        if (participants.has(participantId) || participantId === myParticipant?.id) {
          next[participantId] = volume;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [myParticipant?.id, participants]);

  useEffect(() => {
    return () => {
      if (liveStatusTimerRef.current) clearTimeout(liveStatusTimerRef.current);
      for (const request of liveTokenRequestsRef.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Studio closed before live stream authorization completed.'));
      }
      liveTokenRequestsRef.current.clear();
      for (const request of coHostInviteRequestsRef.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Studio closed before co-host invite authorization completed.'));
      }
      coHostInviteRequestsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!captionsAllowed && captionsEnabled) {
      setCaptionsEnabled(false);
      setShowCaptionsPanel(false);
    }
  }, [captionsAllowed, captionsEnabled]);

  useEffect(() => {
    mediaAssetsRef.current = mediaAssets;
  }, [mediaAssets]);

  useEffect(() => {
    return () => {
      for (const asset of mediaAssetsRef.current) {
        if (asset.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
      }
    };
  }, []);

  // Restore non-sensitive room setup from this browser.
  useEffect(() => {
    studioStateLoadedRef.current = false;
    if (!roomId) return;

    let loadCompleteTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const raw = localStorage.getItem(getStudioStateKey(roomId));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedStudioState>;
        if (parsed.version === STUDIO_STATE_VERSION) {
          if (parsed.layout) setLayout(parsed.layout);
          if (parsed.stageBackground) setStageBackground(parsed.stageBackground);
          if (parsed.brandColor) setBrandColor(parsed.brandColor);
          if (parsed.logoUrl !== undefined) setLogoUrl(parsed.logoUrl);
          if (parsed.logoPlacement) setLogoPlacement(parsed.logoPlacement);
          if (parsed.logoSize) setLogoSize(parsed.logoSize);
          if (parsed.cameraShape) setCameraShape(parsed.cameraShape);
          if (parsed.nameTagStyle) setNameTagStyle(parsed.nameTagStyle);
          if (parsed.pipCorner) setPipCorner(parsed.pipCorner);
          if (Array.isArray(parsed.mediaAssets)) setMediaAssets(parsed.mediaAssets.filter((asset) => asset.source === 'url'));
          if (Array.isArray(parsed.scenes)) {
            setScenes(parsed.scenes);
            setActiveSceneId(parsed.activeSceneId && parsed.scenes.some((scene) => scene.id === parsed.activeSceneId) ? parsed.activeSceneId : null);
          }
          if (Array.isArray(parsed.lowerThirds)) setLowerThirds(parsed.lowerThirds);
          if (Array.isArray(parsed.banners)) setBanners(parsed.banners);
          if (Array.isArray(parsed.timers)) setTimers(parsed.timers.map((timer) => ({ ...timer, isRunning: false })));
          if (Array.isArray(parsed.tickers)) setTickers(parsed.tickers);
          idCounters.current = {
            ...idCounters.current,
            lt: getMaxNumericSuffix(parsed.lowerThirds, 'lt'),
            banner: getMaxNumericSuffix(parsed.banners, 'banner'),
            timer: getMaxNumericSuffix(parsed.timers, 'timer'),
            ticker: getMaxNumericSuffix(parsed.tickers, 'ticker'),
            media: getMaxNumericSuffix(parsed.mediaAssets, 'media'),
          };
        }
      }
    } catch (err) {
      console.warn('Failed to restore studio state:', err);
    } finally {
      loadCompleteTimer = setTimeout(() => {
        studioStateLoadedRef.current = true;
      }, 0);
    }

    return () => {
      if (loadCompleteTimer) clearTimeout(loadCompleteTimer);
    };
  }, [roomId]);

  // Persist room setup locally without storing stream keys or transient media state.
  useEffect(() => {
    if (!roomId || !studioStateLoadedRef.current) return;
    const timeout = setTimeout(() => {
      const state: PersistedStudioState = {
        version: STUDIO_STATE_VERSION,
        layout,
        stageBackground: getPersistableStageBackground(stageBackground),
        brandColor,
        logoUrl: isPersistableLogoUrl(logoUrl) ? logoUrl : null,
        logoPlacement,
        logoSize,
        cameraShape,
        nameTagStyle,
        pipCorner,
        mediaAssets: mediaAssets.filter((asset) => asset.source === 'url'),
        scenes: getPersistableScenes(scenes),
        activeSceneId: activeSceneId && scenes.some((scene) => scene.id === activeSceneId) ? activeSceneId : null,
        lowerThirds,
        banners,
        timers: timers.map((timer) => ({ ...timer, isRunning: false })),
        tickers,
      };

      try {
        localStorage.setItem(getStudioStateKey(roomId), JSON.stringify(state));
      } catch (err) {
        console.warn('Failed to persist studio state:', err);
      }
    }, 250);

    return () => clearTimeout(timeout);
  }, [roomId, layout, stageBackground, brandColor, logoUrl, logoPlacement, logoSize, cameraShape, nameTagStyle, pipCorner, mediaAssets, scenes, activeSceneId, lowerThirds, banners, timers, tickers]);

  // Keep refs in sync with state
  useEffect(() => {
    myParticipantRef.current = myParticipant;
  }, [myParticipant]);
  useEffect(() => { audioEnabledRef.current = effectiveAudioEnabled; }, [effectiveAudioEnabled]);
  useEffect(() => { videoEnabledRef.current = effectiveVideoEnabled; }, [effectiveVideoEnabled]);
  useEffect(() => { isScreenSharingRef.current = isScreenSharing; }, [isScreenSharing]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  // Keep function refs in sync
  useEffect(() => { connectToPeerRef.current = connectToPeer; }, [connectToPeer]);

  useEffect(() => () => {
    bannerAutoDismissTimersRef.current.forEach(({ timer }) => clearTimeout(timer));
    bannerAutoDismissTimersRef.current.clear();
  }, []);

  useEffect(() => {
    const autoDismissTimers = bannerAutoDismissTimersRef.current;
    const activeTimedBannerIds = new Set<string>();

    banners.forEach((banner) => {
      const durationSeconds = Number(banner.durationSeconds);
      if (!banner.visible || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

      const normalizedDuration = Math.min(3600, Math.max(1, Math.round(durationSeconds)));
      activeTimedBannerIds.add(banner.id);
      const existing = autoDismissTimers.get(banner.id);
      if (existing?.durationSeconds === normalizedDuration) return;

      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        autoDismissTimers.delete(banner.id);
        setBanners((prev) => prev.map((item) => (
          item.id === banner.id && item.visible ? { ...item, visible: false } : item
        )));
      }, normalizedDuration * 1000);

      autoDismissTimers.set(banner.id, { timer, durationSeconds: normalizedDuration });
    });

    autoDismissTimers.forEach(({ timer }, bannerId) => {
      if (activeTimedBannerIds.has(bannerId)) return;
      clearTimeout(timer);
      autoDismissTimers.delete(bannerId);
    });
  }, [banners]);

  // Once we know our own participant ID, dial each peer in the initial roster.
  // Driven by myParticipant?.id rather than a setTimeout race.
  useEffect(() => {
    if (!myParticipant?.id) return;
    const ids = initialPeersToConnectRef.current;
    if (ids.length === 0) return;
    initialPeersToConnectRef.current = [];
    for (const id of ids) {
      connectToPeerRef.current(id).catch((err) => console.error('Failed to connect to peer:', err));
    }
  }, [myParticipant?.id]);

  useEffect(() => {
    if (!myParticipant?.id) return;

    for (const [id, participant] of participants) {
      if (canExchangeStudioMedia(myParticipant, participant)) {
        connectToPeerRef.current(id).catch((err) => console.error('Failed to connect to peer:', err));
      } else {
        removePeerRef.current(id);
      }
    }

    if (myParticipant.status !== 'on-stage') {
      cleanupRef.current();
    }
  }, [myParticipant?.id, myParticipant?.status, participants]);
  useEffect(() => { handleOfferRef.current = handleOffer; }, [handleOffer]);
  useEffect(() => { handleAnswerRef.current = handleAnswer; }, [handleAnswer]);
  useEffect(() => { handleIceCandidateRef.current = handleIceCandidate; }, [handleIceCandidate]);
  useEffect(() => { removePeerRef.current = removePeer; }, [removePeer]);
  useEffect(() => { cleanupRef.current = cleanup; }, [cleanup]);
  useEffect(() => { disconnectRef.current = disconnect; }, [disconnect]);
  useEffect(() => { stopMediaRef.current = stopMedia; }, [stopMedia]);
  useEffect(() => { stopScreenShareRef.current = stopScreenShare; }, [stopScreenShare]);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  useEffect(() => { replaceTrackRef.current = replaceTrack; }, [replaceTrack]);
  useEffect(() => { startScreenShareRef.current = startScreenShare; }, [startScreenShare]);
  useEffect(() => { sendRef.current = send; }, [send]);

  useEffect(() => {
    if (!sessionRecordingStartedAt) {
      setSessionRecordingElapsed(0);
      return;
    }

    const updateElapsed = () => {
      setSessionRecordingElapsed(Math.max(0, Math.floor((Date.now() - new Date(sessionRecordingStartedAt).getTime()) / 1000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [sessionRecordingStartedAt]);

  // Connect WebSocket and start media on mount
  useEffect(() => {
    connect();
    let active = true;
    const fallbackTimer = setTimeout(() => {
      if (active) setMediaAttemptComplete(true);
    }, 3000);
    startMedia(undefined, undefined, {
      audioEnabled: sessionStorage.getItem('preferredAudioEnabled') !== 'false',
      videoEnabled: sessionStorage.getItem('preferredVideoEnabled') !== 'false',
    }).finally(() => {
      if (!active) return;
      clearTimeout(fallbackTimer);
      setMediaAttemptComplete(true);
    });
    return () => {
      active = false;
      clearTimeout(fallbackTimer);
    };
  }, [connect, startMedia]);

  // Fix 1: Reset joinedRef and clear room-ending state when disconnected so room-join is re-sent on reconnect
  useEffect(() => {
    if (!connected) {
      joinedRef.current = false;
      setRoomEnding(false);
      setRoomEndsAt(null);
      setEndingCountdown(10);
    }
  }, [connected]);

  // Tick the local countdown against the server-issued absolute end time.
  useEffect(() => {
    if (!roomEnding || roomEndsAt === null) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((roomEndsAt - Date.now()) / 1000));
      setEndingCountdown(remaining);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [roomEnding, roomEndsAt]);

  // WebSocket connection timeout: show error if not connected within 10 seconds
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!connected) {
        setConnectionError('Unable to connect to server. Please check your connection and try again.');
      }
    }, 10000);
    return () => clearTimeout(timeout);
  }, [connected]);

  useEffect(() => {
    if (connected) {
      setConnectionError(null);
    }
  }, [connected]);

  // Join room once connected
  useEffect(() => {
    if (connected && roomId && !joinedRef.current && (localStream || mediaError || mediaAttemptComplete)) {
      joinedRef.current = true;
      // Only present hostToken when claiming host — guests never have one to send.
      const hostToken = userRole === 'host'
        ? roomHostToken || undefined
        : undefined;
      const coHostInviteToken = userRole === 'co-host'
        ? sessionStorage.getItem(`coHostInviteToken:${roomId}`) || undefined
        : undefined;
      const roomPassword = hostToken || coHostInviteToken ? undefined : sessionStorage.getItem(`roomPassword:${roomId}`) || undefined;
      const joinSessionId = userRole === 'host' ? undefined : getGuestJoinSessionId();
      send({
        type: 'join-room',
        payload: { roomId, name: userName, role: userRole, hostToken, coHostInviteToken, roomPassword, joinSessionId },
      });
    }
  }, [connected, localStream, mediaError, mediaAttemptComplete, roomId, roomHostToken, userName, userRole, send]);

  useEffect(() => {
    if (!guestNotification) return;
    if (myParticipant?.status === 'on-stage') {
      setGuestNotification(null);
      return;
    }
    const timer = window.setTimeout(() => setGuestNotification(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [guestNotification, myParticipant?.status]);

  // Signaling message handler
  const handleSignalingMessage = useCallback(
    (message: SignalMessage) => {
      switch (message.type) {
        case 'room-joined': {
          const { room: roomData, participant, participants: existing, chatMessages: existingChatMessages = [], qaQuestions: existingQuestions = [], polls: existingPolls = [], recordingState } = message.payload;
          setRoom(roomData);
          setMyParticipant(participant);
          setJoined(true);
          setChatMessages(existingChatMessages);
          setQAQuestions(existingQuestions);
          setPolls(existingPolls);
          setSessionRecordingStartedAt(recordingState?.recording ? recordingState.startedAt || new Date().toISOString() : null);
          const map = new Map<string, Participant>();
          existing.forEach((p) => map.set(p.id, p));
          setParticipants(map);
          // Defer connectToPeer until myParticipant has propagated through useWebRTC's ref;
          // a dedicated effect below handles the initial connect-out.
          initialPeersToConnectRef.current = existing
            .filter((p) => canExchangeStudioMedia(participant, p))
            .map((p) => p.id);
          break;
        }
        case 'participant-joined': {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.set(message.payload.id, message.payload);
            return next;
          });
          break;
        }
        case 'participant-left': {
          const { participantId } = message.payload;
          setParticipants((prev) => { const n = new Map(prev); n.delete(participantId); return n; });
          removePeerRef.current(participantId);
          break;
        }
        case 'participant-updated': {
          const updated = message.payload;
          setParticipants((prev) => {
            const next = new Map(prev);
            if (next.has(updated.id)) {
              next.set(updated.id, updated);
            }
            return next;
          });
          // Update self if it's our participant (use ref to avoid stale closure)
          if (myParticipantRef.current && updated.id === myParticipantRef.current.id) {
            setMyParticipant(updated);
          }
          break;
        }
        case 'offer':
          handleOfferRef.current(message.payload.from, message.payload.sdp).catch(err => console.error('Failed to handle offer:', err));
          break;
        case 'answer':
          handleAnswerRef.current(message.payload.from, message.payload.sdp).catch(err => console.error('Failed to handle answer:', err));
          break;
        case 'ice-candidate':
          handleIceCandidateRef.current(message.payload.from, message.payload.candidate).catch(err => console.error('Failed to handle ICE candidate:', err));
          break;
        case 'media-state-changed': {
          const { participantId, audioEnabled: a, videoEnabled: v, screenSharing: s } = message.payload;
          setParticipants((prev) => {
            const next = new Map(prev);
            const e = next.get(participantId);
            if (e) next.set(participantId, { ...e, audioEnabled: a, videoEnabled: v, screenSharing: s });
            return next;
          });
          break;
        }
        case 'chat-message':
          setChatMessages((prev) => upsertChatMessage(prev, message.payload));
          break;
        case 'chat-message-updated':
          setChatMessages((prev) => prev.map((chatMessage) => (
            chatMessage.id === message.payload.id ? message.payload : chatMessage
          )));
          break;
        case 'qa-question-updated': {
          const updated = message.payload;
          setQAQuestions((prev) => {
            const next = updated.highlighted
              ? prev.map((q) => ({ ...q, highlighted: q.id === updated.id ? updated.highlighted : false }))
              : [...prev];
            const index = next.findIndex((q) => q.id === updated.id);
            if (index >= 0) {
              next[index] = updated.highlighted ? { ...updated, highlighted: true } : updated;
            } else {
              next.push(updated);
            }
            return next;
          });
          break;
        }
        case 'poll-updated': {
          const updated = message.payload;
          setPolls((prev) => {
            const next = updated.highlighted
              ? prev.map((poll) => ({ ...poll, highlighted: poll.id === updated.id ? updated.highlighted : false }))
              : [...prev];
            const index = next.findIndex((poll) => poll.id === updated.id);
            if (index >= 0) {
              next[index] = updated.highlighted ? { ...updated, highlighted: true } : updated;
            } else {
              next.push(updated);
            }
            return next;
          });
          break;
        }
        case 'participant-removed':
          cleanupRef.current();
          stopMediaRef.current();
          stopScreenShareRef.current();
          disconnectRef.current();
          setConnectionError(message.payload.reason || 'You were removed from this session.');
          break;
        case 'participant-notification':
          setGuestNotification(message.payload);
          break;
        case 'room-ending': {
          const endsAt = Date.parse(message.payload.endsAt);
          if (Number.isFinite(endsAt)) {
            setRoomEnding(true);
            setRoomEndsAt(endsAt);
            setEndingCountdown(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
          }
          break;
        }
        case 'room-ending-cancelled':
          setRoomEnding(false);
          setRoomEndsAt(null);
          setEndingCountdown(10);
          break;
        case 'host-changed':
          setRoom((prev) => prev ? { ...prev, hostId: message.payload.newHostId } : prev);
          break;
        case 'recording-state-changed':
          setSessionRecordingStartedAt(message.payload.recording ? message.payload.startedAt || new Date().toISOString() : null);
          setRoom((prev) => prev ? { ...prev, status: message.payload.recording ? 'recording' : 'waiting' } : prev);
          break;
        case 'live-stream-token-issued': {
          const pending = liveTokenRequestsRef.current.get(message.payload.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            liveTokenRequestsRef.current.delete(message.payload.requestId);
            pending.resolve(message.payload.token);
          }
          break;
        }
        case 'co-host-invite-token-issued': {
          const pending = coHostInviteRequestsRef.current.get(message.payload.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            coHostInviteRequestsRef.current.delete(message.payload.requestId);
            pending.resolve({
              token: message.payload.token,
              expiresAt: message.payload.expiresAt,
            });
          }
          break;
        }
        case 'room-ended':
          setRoomEnding(false);
          cleanupRef.current();
          stopMediaRef.current();
          stopScreenShareRef.current();
          navigateRef.current('/');
          break;
        case 'error':
          console.error('Server error:', message.payload.message);
          if (message.payload.code === 'ROOM_NOT_FOUND') {
            setConnectionError('This room does not exist or has ended.');
          }
          if (
            message.payload.code === 'ROOM_PASSWORD_REQUIRED' ||
            message.payload.code === 'ROOM_PASSWORD_INVALID' ||
            message.payload.code === ROOM_NOT_OPEN_ERROR_CODE ||
            message.payload.code === 'PARTICIPANT_BANNED'
          ) {
            if (roomId) sessionStorage.removeItem(`roomPassword:${roomId}`);
            cleanupRef.current();
            stopMediaRef.current();
            stopScreenShareRef.current();
            disconnectRef.current();
            setConnectionError(message.payload.message);
          }
          if (message.payload.code === 'HOST_TOKEN_INVALID') {
            if (roomId) {
              sessionStorage.removeItem(`hostToken:${roomId}`);
              forgetSavedHostStudio(roomId);
            }
            sessionStorage.setItem('userRole', 'guest');
            cleanupRef.current();
            stopMediaRef.current();
            stopScreenShareRef.current();
            disconnectRef.current();
            setConnectionError(message.payload.message);
          }
          if (
            liveTokenRequestsRef.current.size > 0 &&
            ['UNAUTHORIZED', 'LIVE_STREAM_NOT_CONFIGURED', 'VALIDATION_ERROR'].includes(message.payload.code)
          ) {
            const error = new Error(message.payload.message);
            for (const [requestId, request] of liveTokenRequestsRef.current) {
              clearTimeout(request.timer);
              request.reject(error);
              liveTokenRequestsRef.current.delete(requestId);
            }
          }
          if (message.payload.code === 'CO_HOST_INVITE_INVALID') {
            if (roomId) sessionStorage.removeItem(`coHostInviteToken:${roomId}`);
            sessionStorage.setItem('userRole', 'guest');
            cleanupRef.current();
            stopMediaRef.current();
            stopScreenShareRef.current();
            disconnectRef.current();
            setConnectionError(message.payload.message);
          }
          if (
            coHostInviteRequestsRef.current.size > 0 &&
            ['UNAUTHORIZED', 'PARTICIPANT_NOT_ADMITTED', 'VALIDATION_ERROR'].includes(message.payload.code)
          ) {
            const error = new Error(message.payload.message);
            for (const [requestId, request] of coHostInviteRequestsRef.current) {
              clearTimeout(request.timer);
              request.reject(error);
              coHostInviteRequestsRef.current.delete(requestId);
            }
          }
          break;
        // Client-to-server messages: not expected here but listed for exhaustive check
        case 'join-room':
        case 'stage-action':
        case 'chat-reaction':
        case 'chat-star-update':
        case 'qa-question-submitted':
        case 'qa-question-update':
        case 'qa-question-upvote':
        case 'poll-create':
        case 'poll-vote':
        case 'poll-update':
        case 'live-stream-token-request':
        case 'co-host-invite-token-request':
        case 'end-room':
          break;
        default:
          assertNever(message);
      }
    },
    [] // No external dependencies — all mutable values accessed via refs
  );

  useEffect(() => {
    const rm = addHandler(handleSignalingMessage);
    return rm;
  }, [addHandler, handleSignalingMessage]);

  // Keep active peer connections aligned when a device switch or fallback replaces tracks.
  useEffect(() => {
    const audioTrack = localStream?.getAudioTracks()[0];
    const videoTrack = localStream?.getVideoTracks()[0];
    const published = publishedTrackIdsRef.current;

    if (audioTrack?.id !== published.audio) {
      published.audio = audioTrack?.id;
      if (audioTrack) {
        replaceTrack(audioTrack).catch((err) => console.error('Failed to publish audio track:', err));
      }
    }

    if (videoTrack?.id !== published.video) {
      published.video = videoTrack?.id;
      if (videoTrack) {
        replaceTrack(videoTrack).catch((err) => console.error('Failed to publish video track:', err));
      }
    }
  }, [localStream, replaceTrack]);

  // Sync local tracks when remotely muted/unmuted
  useEffect(() => {
    if (!myParticipant || !localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack && audioTrack.enabled !== myParticipant.audioEnabled) {
      audioTrack.enabled = myParticipant.audioEnabled;
    }
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && videoTrack.enabled !== myParticipant.videoEnabled) {
      videoTrack.enabled = myParticipant.videoEnabled;
    }
  }, [myParticipant?.audioEnabled, myParticipant?.videoEnabled, localStream]);

  useEffect(() => {
    if (!myParticipant) return;
    const hasAudio = Boolean(localStream?.getAudioTracks()[0]?.enabled);
    const hasVideo = Boolean(localStream?.getVideoTracks()[0]?.enabled);
    if (hasAudio === myParticipant.audioEnabled && hasVideo === myParticipant.videoEnabled) return;
    setMyParticipant((prev) => prev && prev.id === myParticipant.id ? { ...prev, audioEnabled: hasAudio, videoEnabled: hasVideo } : prev);
    send({
      type: 'media-state-changed',
      payload: {
        participantId: myParticipant.id,
        audioEnabled: hasAudio,
        videoEnabled: hasVideo,
        screenSharing: isScreenSharing,
      },
    });
  }, [myParticipant, localStream, isScreenSharing, send]);

  // ====== Actions ======

  const onToggleAudio = useCallback(() => {
    const s = toggleAudio();
    if (myParticipantRef.current) send({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: s, videoEnabled: videoEnabledRef.current, screenSharing: isScreenSharingRef.current } });
  }, [toggleAudio, send]);
  const onToggleVideo = useCallback(() => {
    const s = toggleVideo();
    if (myParticipantRef.current) send({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: s, screenSharing: isScreenSharingRef.current } });
  }, [toggleVideo, send]);
  const onLeave = () => {
    if (userRole === 'host') {
      // Host ends the room: trigger server-side countdown for all participants
      send({ type: 'end-room', payload: {} });
    } else {
      // Guests just leave immediately
      cleanup(); stopMedia(); stopScreenShare(); navigate('/');
    }
  };

  const onAudioDeviceChange = async (id: string) => {
    try { const t = await switchAudioDevice(id); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch audio device:', err); }
  };
  const onVideoDeviceChange = async (id: string) => {
    try { const t = await switchVideoDevice(id); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch video device:', err); }
  };
  // Screen sharing — replace the camera video track on all peer connections
  // so remote participants actually receive the screen feed.
  const onToggleScreenShare = useCallback(async () => {
    if (isScreenSharingRef.current) {
      stopScreenShareRef.current();
      // Restore the camera video track on all peer connections
      const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
      if (cameraTrack) await replaceTrackRef.current(cameraTrack);
      if (myParticipantRef.current) sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: false } });
    } else {
      try {
        const stream = await startScreenShareRef.current();
        if (stream && myParticipantRef.current) {
          // Replace the camera video track with the screen video track on all peers
          const screenTrack = stream.getVideoTracks()[0];
          if (screenTrack) {
            await replaceTrackRef.current(screenTrack);
            // When the user stops sharing via the browser's native button,
            // restore the camera track automatically
            screenTrack.addEventListener('ended', async () => {
              stopScreenShareRef.current();
              const camTrack = localStreamRef.current?.getVideoTracks()[0];
              if (camTrack) await replaceTrackRef.current(camTrack);
              if (myParticipantRef.current) {
                sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: false } });
              }
            });
          }
          sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: true } });
        }
      } catch (err) {
        // User cancelled screen share dialog or permission denied
        console.warn('Screen share cancelled or failed:', err);
      }
    }
  }, []); // All mutable values accessed via refs

  // Recording
  const onToggleRecording = async () => {
    if (!myParticipant) return;
    if (isRecording) {
      await downloadRecordings();
      send({
        type: 'recording-state-changed',
        payload: {
          recording: false,
          performedBy: myParticipant.id,
        },
      });
      setSessionRecordingStartedAt(null);
    } else {
      const streams = new Map<string, { stream: MediaStream; name: string; isLocal: boolean }>();
      if (localStream && myParticipant.status === 'on-stage') {
        streams.set(myParticipant.id, { stream: localStream, name: myParticipant.name, isLocal: true });
      }
      for (const [id, participant] of participants) {
        if (participant.status !== 'on-stage') continue;
        const rs = remoteStreams.get(id);
        if (rs) streams.set(id, { stream: rs, name: participant.name, isLocal: false });
      }
      if (streams.size === 0) return;
      startRecording(streams);
      const startedAt = new Date().toISOString();
      setSessionRecordingStartedAt(startedAt);
      send({
        type: 'recording-state-changed',
        payload: {
          recording: true,
          startedAt,
          performedBy: myParticipant.id,
        },
      });
    }
  };

  // Local recording (separate on-stage tracks)
  const onStartLocalRecording = () => {
    if (!myParticipant) return;
    const sources: LocalRecordingSource[] = [];
    const localAudioTracks = localStream?.getAudioTracks().filter((track) => track.readyState === 'live') || [];
    const localVideoTracks = localStream?.getVideoTracks().filter((track) => track.readyState === 'live') || [];
    const localId = getRecordingSourceId(myParticipant.id);

    if (localAudioTracks.length > 0) {
      sources.push({
        id: `${localId}-audio`,
        label: `${myParticipant.name} audio`,
        kind: 'audio',
        stream: new MediaStream(localAudioTracks),
        bitsPerSecond: 256_000,
      });
    }

    if (localVideoTracks.length > 0) {
      sources.push({
        id: `${localId}-camera`,
        label: `${myParticipant.name} camera`,
        kind: 'video',
        stream: new MediaStream(localVideoTracks),
        bitsPerSecond: 8_000_000,
      });
    }

    for (const [id, participant] of participants) {
      if (participant.status !== 'on-stage') continue;
      const remoteStream = remoteStreams.get(id);
      if (!remoteStream) continue;
      const remoteTracks = remoteStream.getTracks().filter((track) => track.readyState === 'live');
      if (remoteTracks.length === 0) continue;
      const hasVideo = remoteTracks.some((track) => track.kind === 'video');
      sources.push({
        id: `${getRecordingSourceId(id)}-isolated`,
        label: participant.screenSharing ? `${participant.name} screen` : `${participant.name} isolated`,
        kind: hasVideo ? 'video' : 'audio',
        stream: new MediaStream(remoteTracks),
        bitsPerSecond: hasVideo ? 8_000_000 : 256_000,
      });
    }

    if (isScreenSharing && screenStream) {
      const screenTracks = screenStream.getTracks().filter((track) => track.readyState === 'live');
      if (screenTracks.length > 0) {
        sources.push({
          id: `${localId}-screen`,
          label: `${myParticipant.name} screen`,
          kind: 'screen',
          stream: new MediaStream(screenTracks),
          bitsPerSecond: 8_000_000,
        });
      }
    }

    if (sources.length === 0) return;
    setRecordingMarkers([]);
    void startLocalRecording(sources).catch((err) => console.error('Failed to start local recording:', err));
  };

  const onAddRecordingMarker = useCallback((seconds: number, label: string) => {
    const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    setRecordingMarkers((current) => [
      ...current,
      {
        id: `marker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: normalizeRecordingMarkerLabel(label),
        seconds: safeSeconds,
        createdAt: new Date().toISOString(),
      },
    ].slice(-200));
  }, []);

  const onRemoveRecordingMarker = useCallback((markerId: string) => {
    setRecordingMarkers((current) => current.filter((marker) => marker.id !== markerId));
  }, []);

  const onClearRecordingMarkers = useCallback(() => {
    setRecordingMarkers([]);
  }, []);

  const onReplaceRecordingMarkers = useCallback((markers: RecordingMarker[]) => {
    setRecordingMarkers(markers
      .filter((marker) => marker && Number.isFinite(marker.seconds))
      .map((marker) => ({
        id: marker.id || `marker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: normalizeRecordingMarkerLabel(marker.label),
        seconds: Math.max(0, Math.floor(marker.seconds)),
        createdAt: Number.isFinite(Date.parse(marker.createdAt)) ? marker.createdAt : new Date().toISOString(),
      }))
      .slice(-200));
  }, []);

  // Chat
  const onSendChat = (content: string, isBackstage = false) => {
    if (!myParticipant) return;
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      senderId: myParticipant.id,
      senderName: myParticipant.name,
      content,
      timestamp: new Date().toISOString(),
      isBackstage,
    };

    // Public messages are broadcast to everyone except the sender, so keep them
    // optimistic. Backstage messages are echoed back by the server only to the
    // production team, which avoids client-generated duplicate IDs.
    if (!isBackstage) {
      setChatMessages((prev) => {
        const next = [...prev, msg];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }

    send({ type: 'chat-message', payload: msg });
  };

  const onReactChat = (messageId: string, reaction: ChatReactionType) => {
    send({ type: 'chat-reaction', payload: { messageId, reaction } });
  };

  const onToggleChatStar = (messageId: string, starred: boolean) => {
    send({ type: 'chat-star-update', payload: { messageId, starred } });
  };

  // Lower thirds
  const onAddLowerThird = (lt: Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean }) => {
    setLowerThirds((prev) => [...prev, { ...lt, id: `lt-${++idCounters.current.lt}`, visible: lt.visible ?? false }]);
  };
  const onToggleLowerThird = (id: string) => {
    setLowerThirds((prev) => prev.map((lt) => ({ ...lt, visible: lt.id === id ? !lt.visible : lt.visible })));
  };
  const onRemoveLowerThird = (id: string) => {
    setLowerThirds((prev) => prev.filter((lt) => lt.id !== id));
  };

  // Banners
  const onAddBanner = (banner: Omit<BannerData, 'id' | 'visible'> & { visible?: boolean }) => {
    setBanners((prev) => [...prev, { ...banner, id: `banner-${++idCounters.current.banner}`, visible: banner.visible ?? false }]);
  };
  const onToggleBanner = (id: string) => {
    setBanners((prev) => prev.map((b) => ({ ...b, visible: b.id === id ? !b.visible : b.visible })));
  };
  const onRemoveBanner = (id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  };

  // Timers
  const onAddTimer = (timer: Omit<TimerData, 'id' | 'visible'> & { visible?: boolean }) => {
    setTimers((prev) => [...prev, { ...timer, id: `timer-${++idCounters.current.timer}`, visible: timer.visible ?? false }]);
  };
  const onToggleTimer = (id: string) => {
    setTimers((prev) => prev.map((t) => ({ ...t, visible: t.id === id ? !t.visible : t.visible })));
  };
  const onRemoveTimer = (id: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== id));
  };
  const onUpdateTimer = useCallback((id: string, updates: Partial<TimerData>) => {
    setTimers((prev) => prev.map((t) => t.id === id ? { ...t, ...updates } : t));
  }, []);

  // Timer ticking
  useTimerTick(timers, onUpdateTimer);

  const inviteUrl = useMemo(() => (
    `${INVITE_BASE_URL.replace(/\/+$/, '')}/join/${roomId || ''}`
  ), [roomId]);

  const requestLiveStreamToken = useCallback((): Promise<string> => {
    const requestId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        liveTokenRequestsRef.current.delete(requestId);
        reject(new Error('Timed out while authorizing live stream.'));
      }, 10_000);

      liveTokenRequestsRef.current.set(requestId, { resolve, reject, timer });
      send({
        type: 'live-stream-token-request',
        payload: { requestId },
      });
    });
  }, [send]);

  const requestCoHostInvite = useCallback(async (): Promise<{ inviteUrl: string; expiresAt: string }> => {
    const requestId = `cohost-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const { token, expiresAt } = await new Promise<{ token: string; expiresAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        coHostInviteRequestsRef.current.delete(requestId);
        reject(new Error('Timed out while creating co-host invite.'));
      }, 10_000);

      coHostInviteRequestsRef.current.set(requestId, { resolve, reject, timer });
      send({
        type: 'co-host-invite-token-request',
        payload: { requestId },
      });
    });

    return {
      inviteUrl: buildCoHostInviteUrl(inviteUrl, token),
      expiresAt,
    };
  }, [inviteUrl, send]);

  // Stream destinations
  const onAddDestination = (dest: Omit<StreamDestination, 'id' | 'status'>) => {
    setDestinations((prev) => [...prev, { ...dest, id: `dest-${++idCounters.current.dest}`, status: 'idle' }]);
  };
  const onUpdateDestination = (id: string, dest: Omit<StreamDestination, 'id' | 'status'>) => {
    setDestinations((prev) => prev.map((destination) => (
      destination.id === id ? { ...destination, ...dest, status: 'idle' } : destination
    )));
  };
  const onRemoveDestination = (id: string) => {
    setDestinations((prev) => prev.filter((d) => d.id !== id));
  };
  const onToggleDestination = (id: string) => {
    setDestinations((prev) => prev.map((d) => d.id === id ? { ...d, enabled: !d.enabled } : d));
  };
  const onGoLive = async () => {
    if (liveStatusTimerRef.current) {
      clearTimeout(liveStatusTimerRef.current);
      liveStatusTimerRef.current = null;
    }

    const enabledDestinations = destinations.filter((d) => d.enabled);
    if (
      enabledDestinations.length === 0 ||
      enabledDestinations.length > 3 ||
      enabledDestinations.some((d) => getStreamDestinationIssue(d))
    ) {
      setDestinations((prev) => prev.map((d) => d.enabled ? { ...d, status: 'error' } : d));
      return;
    }

    const readiness = await checkRelayReadiness();
    if (readiness.status !== 'ready') {
      setDestinations((prev) => prev.map((d) => d.enabled ? { ...d, status: 'error' } : d));
      return;
    }

    setIsLive(true);
    setDestinations((prev) => prev.map((d) => d.enabled ? { ...d, status: 'connecting' } : { ...d, status: 'idle' }));
    try {
      const token = await requestLiveStreamToken();
      await startRelay({
        token,
        orientation: broadcastOrientation,
        destinations: enabledDestinations.map((destination) => ({
          id: destination.id,
          name: destination.name,
          rtmpUrl: destination.rtmpUrl,
          streamKey: destination.streamKey,
        })),
      });
    } catch (err) {
      console.error('Failed to start live stream:', err);
      stopRelay();
      setIsLive(false);
      setDestinations((prev) => prev.map((d) => d.enabled ? { ...d, status: 'error' } : { ...d, status: 'idle' }));
    }
  };
  const onStopLive = () => {
    if (liveStatusTimerRef.current) {
      clearTimeout(liveStatusTimerRef.current);
      liveStatusTimerRef.current = null;
    }
    stopRelay();
    setIsLive(false);
    setDestinations((prev) => prev.map((d) => ({ ...d, status: 'idle' })));
  };

  // Stage actions (participant management)
  const onStageAction = (action: StageActionPayload['action'], targetId: string) => {
    if (!myParticipant) return;
    send({
      type: 'stage-action',
      payload: {
        action,
        targetParticipantId: targetId,
        performedBy: myParticipant.id,
      },
    });
  };

  // Media library
  const onUploadMedia = (files: FileList | File[]) => {
    const nextAssets = Array.from(files).map((file) => ({
      id: `media-${++idCounters.current.media}`,
      name: file.name,
      url: URL.createObjectURL(file),
      type: detectMediaType(file),
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      createdAt: new Date().toISOString(),
      source: 'upload' as const,
    }));
    if (nextAssets.length > 0) {
      setMediaAssets((prev) => [...nextAssets, ...prev].slice(0, 80));
    }
  };

  const onAddMediaUrl = (url: string, type: 'video' | 'image') => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const asset: StudioMediaAsset = {
      id: `media-${++idCounters.current.media}`,
      name: getMediaNameFromUrl(trimmed, type),
      url: trimmed,
      type,
      mimeType: type === 'video' ? 'video/url' : 'image/url',
      createdAt: new Date().toISOString(),
      source: 'url',
    };
    setMediaAssets((prev) => [asset, ...prev].slice(0, 80));
  };

  const onPlayMediaAsset = (asset: StudioMediaAsset) => {
    setActiveMedia({
      assetId: asset.id,
      type: asset.type,
      url: asset.url,
      name: asset.name,
    });
  };

  const onRemoveMediaAsset = (assetId: string) => {
    setMediaAssets((prev) => {
      const asset = prev.find((item) => item.id === assetId);
      if (asset?.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
      return prev.filter((item) => item.id !== assetId);
    });
    setActiveMedia((current) => current?.assetId === assetId ? null : current);
  };

  const onStopMedia = () => setActiveMedia(null);

  // Helper to convert blob URL to data URL
  const blobToDataUrl = async (blobUrl: string, maxBytes = MAX_PERSISTED_IMAGE_BYTES): Promise<string> => {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      throw new Error('Image is too large to persist');
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  };

  // Scenes
  const onSaveScene = async (name: string) => {
    if (scenes.length >= MAX_STUDIO_SCENES) return;

    // Convert blob URL to data URL so the scene survives blob revocation
    let persistedLogoUrl = logoUrl;
    if (logoUrl && logoUrl.startsWith('blob:')) {
      try {
        persistedLogoUrl = await blobToDataUrl(logoUrl);
      } catch {
        // Keep original URL if conversion fails
      }
    }
    let persistedBackground = stageBackground;
    if (stageBackground.type === 'image' && stageBackground.value.startsWith('blob:')) {
      try {
        persistedBackground = { ...stageBackground, value: await blobToDataUrl(stageBackground.value) };
      } catch {
        // Keep original URL for this session if conversion fails
      }
    }

    const newScene: Scene = {
      id: `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      layout,
      background: persistedBackground,
      brandColor,
      logoUrl: persistedLogoUrl,
      cameraShape,
      nameTagStyle,
      logoPlacement,
      logoSize,
      visibleOverlayIds: [
        ...lowerThirds.filter(o => o.visible).map(o => o.id),
        ...banners.filter(b => b.visible).map(b => b.id),
        ...timers.filter(t => t.visible).map(t => t.id),
        ...tickers.filter(t => t.visible).map(t => t.id),
      ],
    };
    setScenes(prev => [...prev, newScene]);
    setActiveSceneId(newScene.id);
  };

  const onCreateTemplateScene = (template: ProductionSceneTemplate) => {
    if (scenes.length >= MAX_STUDIO_SCENES) return;
    const config = getTemplateSceneConfig(template);
    const visibleOverlayIds: string[] = [];
    let nextBanner: BannerData | null = null;
    let nextTicker: TickerData | null = null;
    let nextTimer: TimerData | null = null;

    if (config.banner) {
      nextBanner = { ...config.banner, id: `banner-${++idCounters.current.banner}` };
      visibleOverlayIds.push(nextBanner.id);
    }
    if (config.ticker) {
      nextTicker = { ...config.ticker, id: `ticker-${++idCounters.current.ticker}` };
      visibleOverlayIds.push(nextTicker.id);
    }
    if (config.timer) {
      nextTimer = { ...config.timer, id: `timer-${++idCounters.current.timer}` };
      visibleOverlayIds.push(nextTimer.id);
    }

    const newScene: Scene = {
      id: `scene-template-${template}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: config.name,
      layout: config.layout,
      background: config.background,
      brandColor: config.brandColor,
      logoUrl: null,
      cameraShape: config.cameraShape,
      nameTagStyle: config.nameTagStyle,
      logoPlacement: 'top-right',
      logoSize: 'medium',
      visibleOverlayIds,
    };

    setScenes(prev => prev.length >= MAX_STUDIO_SCENES ? prev : [...prev, newScene]);
    setLayout(config.layout);
    setStageBackground(config.background);
    setBrandColor(config.brandColor);
    setLogoUrl(null);
    setCameraShape(config.cameraShape);
    setNameTagStyle(config.nameTagStyle);
    setLogoPlacement('top-right');
    setLogoSize('medium');
    setFocusedVideoItemId(null);
    setLowerThirds(prev => prev.map(o => ({ ...o, visible: false })));
    if (nextBanner) {
      setBanners(prev => [...prev.map(b => ({ ...b, visible: false })), nextBanner]);
    } else {
      setBanners(prev => prev.map(b => ({ ...b, visible: false })));
    }
    if (nextTimer) {
      setTimers(prev => [...prev.map(t => ({ ...t, visible: false, isRunning: false })), nextTimer]);
    } else {
      setTimers(prev => prev.map(t => ({ ...t, visible: false, isRunning: false })));
    }
    if (nextTicker) {
      setTickers(prev => [...prev.map(t => ({ ...t, visible: false })), nextTicker]);
    } else {
      setTickers(prev => prev.map(t => ({ ...t, visible: false })));
    }
    setActiveSceneId(newScene.id);
  };

  const onApplyScene = (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return;
    if (sceneId === activeSceneId) return;
    setLayout(scene.layout);
    setStageBackground(scene.background);
    setBrandColor(scene.brandColor || '#a78bfa');
    setLogoUrl(scene.logoUrl || null);
    setCameraShape(scene.cameraShape || 'rectangle');
    setNameTagStyle(scene.nameTagStyle || 'classic');
    setLogoPlacement(scene.logoPlacement || 'top-right');
    setLogoSize(scene.logoSize || 'medium');
    setFocusedVideoItemId(null);
    // Restore overlay visibility from saved scene
    const visibleIds = new Set(scene.visibleOverlayIds);
    setLowerThirds(prev => prev.map(o => ({ ...o, visible: visibleIds.has(o.id) })));
    setBanners(prev => prev.map(b => ({ ...b, visible: visibleIds.has(b.id) })));
    setTimers(prev => prev.map(t => ({ ...t, visible: visibleIds.has(t.id), isRunning: visibleIds.has(t.id) ? t.isRunning : false })));
    setTickers(prev => prev.map(t => ({ ...t, visible: visibleIds.has(t.id) })));
    setActiveSceneId(sceneId);
  };
  const onDeleteScene = (sceneId: string) => {
    setScenes(prev => prev.filter(s => s.id !== sceneId));
    if (activeSceneId === sceneId) setActiveSceneId(null);
  };
  const onRenameScene = (sceneId: string, newName: string) => {
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, name: newName } : s));
  };

  // Tickers
  const onAddTicker = (ticker: Omit<TickerData, 'id' | 'visible'> & { visible?: boolean }) => {
    setTickers(prev => [...prev, { ...ticker, id: `ticker-${++idCounters.current.ticker}`, visible: ticker.visible ?? false }]);
  };
  const onToggleTicker = (id: string) => {
    setTickers(prev => prev.map(t => ({ ...t, visible: t.id === id ? !t.visible : t.visible })));
  };
  const onRemoveTicker = (id: string) => {
    setTickers(prev => prev.filter(t => t.id !== id));
  };
  const onUpdateTicker = (id: string, updates: Partial<TickerData>) => {
    setTickers(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  // Comment highlighting
  const onHighlightComment = (comment: HighlightedComment) => setHighlightedComment(comment);
  const onDismissComment = () => setHighlightedComment(null);

  // Webinar Q&A
  const onSubmitQuestion = (content: string) => {
    const text = content.trim();
    if (!text) return;
    send({
      type: 'qa-question-submitted',
      payload: { id: `qa-${++idCounters.current.qa}`, content: text },
    });
  };
  const onApproveQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, status: 'approved' as const } : q));
    send({ type: 'qa-question-update', payload: { questionId: id, updates: { status: 'approved' } } });
  };
  const onDismissQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, status: 'dismissed' as const, highlighted: false } : q));
    send({ type: 'qa-question-update', payload: { questionId: id, updates: { status: 'dismissed', highlighted: false } } });
  };
  const onAnswerQuestion = (id: string, answer: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, status: 'answered' as const, answer } : q));
    send({ type: 'qa-question-update', payload: { questionId: id, updates: { answer } } });
  };
  const onHighlightQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => ({ ...q, highlighted: q.id === id })));
    send({ type: 'qa-question-update', payload: { questionId: id, updates: { highlighted: true } } });
  };
  const onUnhighlightQuestion = (id: string) => {
    setQAQuestions(prev => prev.map(q => q.id === id ? { ...q, highlighted: false } : q));
    send({ type: 'qa-question-update', payload: { questionId: id, updates: { highlighted: false } } });
  };
  const onUpvoteQuestion = (id: string) => {
    setMyUpvotes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setQAQuestions(p => p.map(q => q.id === id ? { ...q, upvotes: Math.max(0, q.upvotes - 1) } : q));
      } else {
        next.add(id);
        setQAQuestions(p => p.map(q => q.id === id ? { ...q, upvotes: q.upvotes + 1 } : q));
      }
      return next;
    });
    send({ type: 'qa-question-upvote', payload: { questionId: id } });
  };

  const onCreatePoll = (question: string, options: string[]) => {
    const cleanOptions = options.map((option) => option.trim()).filter(Boolean);
    if (!question.trim() || cleanOptions.length < 2) return;
    send({
      type: 'poll-create',
      payload: {
        id: `poll-${++idCounters.current.poll}`,
        question: question.trim(),
        options: cleanOptions,
      },
    });
  };

  const onVotePoll = (pollId: string, optionId: string) => {
    setMyPollVotes((prev) => ({ ...prev, [pollId]: optionId }));
    send({ type: 'poll-vote', payload: { pollId, optionId } });
  };

  const onClosePoll = (pollId: string) => {
    setPolls((prev) => prev.map((poll) => poll.id === pollId ? { ...poll, status: 'closed' as const } : poll));
    send({ type: 'poll-update', payload: { pollId, updates: { status: 'closed' } } });
  };

  const onHighlightPoll = (pollId: string) => {
    setPolls((prev) => prev.map((poll) => ({ ...poll, highlighted: poll.id === pollId })));
    send({ type: 'poll-update', payload: { pollId, updates: { highlighted: true } } });
  };

  const onUnhighlightPoll = (pollId: string) => {
    setPolls((prev) => prev.map((poll) => poll.id === pollId ? { ...poll, highlighted: false } : poll));
    send({ type: 'poll-update', payload: { pollId, updates: { highlighted: false } } });
  };

  // Build video items (only show on-stage participants) - memoized
  // When someone is screen sharing, the screen share replaces their camera track
  // on the WebRTC connection. Locally, we show the screen share as a separate tile.
  const videoItems = useMemo(() => {
    const items: Array<{ id: string; name: string; stream: MediaStream | null; isLocal: boolean; audioEnabled: boolean; videoEnabled: boolean; volume: number; isScreenShare?: boolean }> = [];
    if (myParticipant && myParticipant.status === 'on-stage') {
      items.push({ id: myParticipant.id, name: myParticipant.name, stream: localStream, isLocal: true, audioEnabled: effectiveAudioEnabled, videoEnabled: effectiveVideoEnabled, volume: participantVolumes[myParticipant.id] ?? 1 });
      // Add local screen share as a separate tile
      if (isScreenSharing && screenStream) {
        items.push({ id: `${myParticipant.id}-screen`, name: `${myParticipant.name}'s Screen`, stream: screenStream, isLocal: true, audioEnabled: false, videoEnabled: true, volume: 1, isScreenShare: true });
      }
    }
    for (const [id, p] of participants) {
      if (p.status === 'on-stage') {
        items.push({ id, name: p.screenSharing ? `${p.name}'s screen` : p.name, stream: remoteStreams.get(id) || null, isLocal: false, audioEnabled: p.screenSharing ? false : p.audioEnabled, videoEnabled: p.screenSharing ? true : p.videoEnabled, volume: participantVolumes[id] ?? 1, isScreenShare: p.screenSharing || false });
      }
    }
    return items;
  }, [myParticipant, participants, localStream, effectiveAudioEnabled, effectiveVideoEnabled, remoteStreams, isScreenSharing, screenStream, participantVolumes]);

  const orderedVideoItems = useMemo(() => {
    if (!focusedVideoItemId) return videoItems;
    const focusedIndex = videoItems.findIndex((item) => item.id === focusedVideoItemId);
    if (focusedIndex <= 0) return videoItems;
    const focusedItem = videoItems[focusedIndex];
    return [
      focusedItem,
      ...videoItems.slice(0, focusedIndex),
      ...videoItems.slice(focusedIndex + 1),
    ];
  }, [videoItems, focusedVideoItemId]);

  useEffect(() => {
    if (focusedVideoItemId && !videoItems.some((item) => item.id === focusedVideoItemId)) {
      setFocusedVideoItemId(null);
    }
  }, [focusedVideoItemId, videoItems]);

  // Auto-switch layout when participant count changes
  useEffect(() => {
    const count = videoItems.length;
    // Layouts requiring >= 2 participants
    if (count < 2 && (layout === 'spotlight' || layout === 'featured' || layout === 'side-by-side' || layout === 'pip')) {
      setLayout(count === 1 ? 'single' : 'grid');
    }
    // Single layout with multiple participants should switch to grid
    if (count > 1 && layout === 'single') {
      setLayout('grid');
    }
  }, [videoItems.length, layout]);

  // All participants for the manager - memoized
  const allParticipantsMap = useMemo(() => {
    const map = new Map<string, Participant>();
    if (myParticipant) map.set(myParticipant.id, myParticipant);
    for (const [id, p] of participants) {
      map.set(id, p);
    }
    return map;
  }, [myParticipant, participants]);

  // Stage background style - memoized
  const stageBackgroundStyle = useMemo((): React.CSSProperties => {
    switch (stageBackground.type) {
      case 'color':
        return { background: stageBackground.value };
      case 'gradient':
        return { background: stageBackground.value };
      case 'image':
        return {
          backgroundImage: `url(${stageBackground.value})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        };
      case 'none':
      default:
        return {};
    }
  }, [stageBackground]);

  // ====== Layout Engine ======
  // Each layout helper returns { containerStyle, tileStyles[], mode }.
  // The rendering section uses containerStyle on the wrapper and applies
  // tileStyles[i] to each tile so that centering and sizing are precise.

  type LayoutResult = {
    containerStyle: React.CSSProperties;
    tileStyles: React.CSSProperties[];
    mode: 'flex' | 'grid' | 'custom';
  };

  const GAP = 8;

  // Shared base — border-box prevents padding overflow beyond the 16:9 canvas
  const containerBase: React.CSSProperties = {
    width: '100%',
    height: '100%',
    padding: 8,
    boxSizing: 'border-box' as const,
  };

  // Optimal auto-grid for 1-12 participants.
  // Uses flexbox + percentage widths; justify-content:center handles
  // centering the last row when it has fewer tiles than the row above.
  const getAutoGridLayout = useCallback((count: number): LayoutResult => {
    if (count <= 0) return { containerStyle: { ...containerBase, display: 'flex' }, tileStyles: [], mode: 'flex' };

    let maxCols = 1;
    if (count >= 2 && count <= 4) maxCols = 2;
    else if (count >= 5 && count <= 9) maxCols = 3;
    else if (count >= 10 && count <= 16) maxCols = 4;
    else maxCols = Math.ceil(Math.sqrt(count * 16 / 9));

    const tileW = `calc(${100 / maxCols}% - ${GAP * (maxCols - 1) / maxCols}px)`;

    const tiles: React.CSSProperties[] = Array.from({ length: count }, () => ({
      width: tileW,
      aspectRatio: '16 / 9',
      flexShrink: 0,
      flexGrow: 0,
    }));

    return {
      containerStyle: {
        ...containerBase,
        display: 'flex',
        flexWrap: 'wrap' as const,
        justifyContent: 'center',
        alignContent: 'center',
        gap: GAP,
      },
      tileStyles: tiles,
      mode: 'flex',
    };
  }, []);

  // Screen share layout: screen tile gets prominent placement.
  const getScreenShareLayout = useCallback((items: typeof videoItems): LayoutResult => {
    const screenIdx = items.findIndex(v => v.isScreenShare);
    const speakerCount = items.length - 1;

    if (speakerCount <= 4) {
      // CSS Grid: screen takes left column, speakers stack in right column
      const speakerRows = Math.max(speakerCount, 1);
      const tiles: React.CSSProperties[] = items.map((_, i) => {
        if (i === screenIdx) {
          return { gridColumn: '1', gridRow: `1 / ${speakerRows + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center' };
        }
        const si = i < screenIdx ? i : i - 1;
        return { gridColumn: '2', gridRow: `${si + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center' };
      });
      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: speakerCount > 0 ? '1fr 0.32fr' : '1fr',
          gridTemplateRows: `repeat(${speakerRows}, 1fr)`,
          gap: GAP,
          alignItems: 'center',
          justifyItems: 'center',
        },
        tileStyles: tiles,
        mode: 'grid',
      };
    }
    // 5+ speakers: screen on top 80%, speaker strip at bottom 20%
    const tiles: React.CSSProperties[] = items.map((_, i) => {
      if (i === screenIdx) {
        return { width: `calc(80% - ${GAP}px)`, aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0, order: 0 };
      }
      return {
        width: `calc(20% - ${GAP}px)`,
        aspectRatio: '16 / 9',
        flexShrink: 0, flexGrow: 0, order: 1,
      };
    });
    return {
      containerStyle: { ...containerBase, display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'center', alignContent: 'center', gap: GAP },
      tileStyles: tiles,
      mode: 'custom',
    };
  }, []);

  // Spotlight: 1 large tile top ~74%, thumbnail strip bottom ~26%
  const getSpotlightLayout = useCallback((count: number): LayoutResult => {
    if (count <= 1) return getAutoGridLayout(count);
    const thumbCount = count - 1;
    const maxThumbsPerRow = Math.max(3, Math.min(thumbCount, 6)); 
    const thumbW = 100 / maxThumbsPerRow;
    const mainW = 100 - thumbW; 

    const tiles: React.CSSProperties[] = [
      { width: `calc(${mainW}% - ${GAP}px)`, aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0 },
    ];
    for (let i = 0; i < thumbCount; i++) {
      tiles.push({
        width: `calc(${thumbW}% - ${GAP}px)`,
        aspectRatio: '16 / 9',
        flexShrink: 0, flexGrow: 0,
      });
    }
    return {
      containerStyle: { ...containerBase, display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'center', alignContent: 'center', gap: GAP },
      tileStyles: tiles,
      mode: 'flex',
    };
  }, [getAutoGridLayout]);

  // Featured: 1 large tile ~72% left + side tiles ~28% right (CSS Grid for clean stacking)
  const getFeaturedLayout = useCallback((count: number): LayoutResult => {
    if (count <= 1) return getAutoGridLayout(count);
    const sideCount = count - 1;
    const tiles: React.CSSProperties[] = [
      { gridColumn: '1', gridRow: `1 / ${sideCount + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center' },
    ];
    for (let i = 0; i < sideCount; i++) {
      tiles.push({
        gridColumn: '2', gridRow: `${i + 1}`, width: '100%', aspectRatio: '16 / 9', alignSelf: 'center',
      });
    }
    return {
      containerStyle: {
        ...containerBase,
        display: 'grid',
        gridTemplateColumns: '1fr 0.38fr',
        gridTemplateRows: `repeat(${sideCount}, 1fr)`,
        gap: GAP,
        alignItems: 'center',
        justifyItems: 'center',
      },
      tileStyles: tiles,
      mode: 'grid',
    };
  }, [getAutoGridLayout]);

  // Final computed layout
  const layoutResult = useMemo((): LayoutResult => {
    const count = orderedVideoItems.length;
    const hasScreenShare = orderedVideoItems.some(v => v.isScreenShare);

    // Screen share layout takes priority across all layout modes
    if (hasScreenShare) {
      return getScreenShareLayout(orderedVideoItems);
    }

    switch (layout) {
      case 'grid':
        return getAutoGridLayout(count);
      case 'spotlight':
        return getSpotlightLayout(count);
      case 'featured':
        return getFeaturedLayout(count);
      case 'side-by-side': {
        const showCount = Math.min(count, 2);
        const tiles: React.CSSProperties[] = Array.from({ length: showCount }, () => ({
          width: showCount === 2 ? `calc(50% - ${GAP / 2}px)` : '100%',
          aspectRatio: '16 / 9',
          flexShrink: 0, flexGrow: 0,
        }));
        return {
          containerStyle: { ...containerBase, display: 'flex', justifyContent: 'center', alignItems: 'center', alignContent: 'center', gap: GAP },
          tileStyles: tiles,
          mode: 'flex',
        };
      }
      case 'pip': {
        const pipPos = {
          TL: { top: 20, left: 20 },
          TR: { top: 20, right: 20 },
          BL: { bottom: 20, left: 20 },
          BR: { bottom: 20, right: 20 },
        }[pipCorner];
        const tiles: React.CSSProperties[] = [
          { width: '100%', aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0 },
        ];
        if (count >= 2) {
          tiles.push({
            position: 'absolute' as const,
            ...pipPos,
            width: '24%',
            aspectRatio: '16 / 9',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 4px 24px rgba(0, 0, 0, 0.5)',
            border: '2px solid rgba(255, 255, 255, 0.15)',
            zIndex: 5,
            flexShrink: 0, flexGrow: 0,
            cursor: 'pointer',
            transition: 'top 0.3s ease, bottom 0.3s ease, left 0.3s ease, right 0.3s ease',
          });
        }
        return {
          containerStyle: { ...containerBase, display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative' as const },
          tileStyles: tiles,
          mode: 'custom',
        };
      }
      case 'single': {
        return {
          containerStyle: { ...containerBase, display: 'flex', justifyContent: 'center', alignItems: 'center' },
          tileStyles: count > 0 ? [{ width: '100%', aspectRatio: '16 / 9', flexShrink: 0, flexGrow: 0 }] : [],
          mode: 'flex',
        };
      }
      default:
        return assertNever(layout);
    }
  }, [layout, orderedVideoItems, getAutoGridLayout, getScreenShareLayout, getSpotlightLayout, getFeaturedLayout]);

  // These must be called before any conditional returns to satisfy Rules of Hooks
  const visibleBanners = useMemo(() => banners.filter(b => b.visible), [banners]);
  const visibleTimers = useMemo(() => timers.filter(t => t.visible), [timers]);
  const visibleTickers = useMemo(() => tickers.filter(t => t.visible), [tickers]);
  const highlightedQA = useMemo(() => qaQuestions.find(q => q.highlighted) || null, [qaQuestions]);
  const highlightedPoll = useMemo(() => polls.find((poll) => poll.highlighted) || null, [polls]);
  const showCompositorDebug = import.meta.env.DEV && isLive;
  const sessionRecordingActive = Boolean(sessionRecordingStartedAt || isRecording || isLocalRecording);
  const sessionRecordingTime = isRecording
    ? formattedTime
    : sessionRecordingStartedAt
      ? formatDuration(sessionRecordingElapsed)
      : localRecFormattedTime;

  // Connection error
  if (connectionError) {
    const passwordError = connectionError === 'This room requires a password' || connectionError === 'Incorrect room password';
    const hostAccessError = connectionError.includes('Host access is missing or expired');
    const joinRecoverableError = passwordError || hostAccessError || connectionError === 'Co-host invite link is invalid or expired';
    return (
      <div style={styles.loading}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
        <p style={{ ...styles.loadingText, color: '#ef4444', marginTop: 16 }}>{connectionError}</p>
        <button
          className="btn-primary"
          style={{ marginTop: 16, padding: '10px 24px', borderRadius: 10, fontSize: 14, fontWeight: 600 }}
          onClick={() => navigate(joinRecoverableError && roomId ? `/join/${roomId}` : '/')}
        >
          {joinRecoverableError ? 'Back to join screen' : 'Go to homepage'}
        </button>
      </div>
    );
  }

  // Reconnect failed after max attempts — let the user manually retry rather than spinning forever.
  if (reconnectFailed) {
    return (
      <div style={styles.loading}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p style={{ ...styles.loadingText, color: '#f59e0b', marginTop: 16 }}>
          Could not reconnect to the studio. Your network may be down or the server is unreachable.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
          <button
            className="btn-primary"
            style={{ padding: '10px 24px', borderRadius: 10, fontSize: 14, fontWeight: 600 }}
            onClick={retryConnection}
          >
            Retry
          </button>
          <button
            className="btn-ghost"
            style={{ padding: '10px 24px', borderRadius: 10, fontSize: 14, fontWeight: 600 }}
            onClick={() => navigate('/')}
          >
            Go to homepage
          </button>
        </div>
      </div>
    );
  }

  // Loading
  if (!joined) {
    return (
      <div style={styles.loading}>
        <div style={styles.spinner} />
        <p style={styles.loadingText}>Joining studio...</p>
      </div>
    );
  }

  const visibleLowerThird = lowerThirds.find((lt) => lt.visible);
  const canManagePolls = Boolean(isHostOrCoHost && myParticipant?.status !== 'green-room');
  const canVotePolls = Boolean(!isHostOrCoHost && myParticipant?.status !== 'green-room');
  const captionBottomOffset = Math.max(
    24,
    visibleTickers.length > 0 ? 72 : 0,
    visibleLowerThird ? 112 : 0,
    visibleBanners.length > 0 ? 132 : 0,
    highlightedComment ? 128 : 0
  );
  const waitingCount = Array.from(participants.values()).filter((participant) => participant.status === 'green-room').length;
  const offStageGuestStatus = !isHostOrCoHost ? myParticipant?.status : null;
  const isHeldOffStageGuest = offStageGuestStatus === 'green-room' || offStageGuestStatus === 'backstage';
  const holdLabel = offStageGuestStatus === 'backstage' ? 'Backstage' : 'Green room';
  const holdKicker = offStageGuestStatus === 'backstage' ? 'Backstage' : 'Waiting for host';
  const holdTitle = offStageGuestStatus === 'backstage' ? "You're backstage" : "You're in the green room";
  const holdText = offStageGuestStatus === 'backstage'
    ? 'You are off the broadcast stage. The host can bring you back live when ready.'
    : 'The host can see that you arrived and will bring you on stage when ready.';

  if (isHeldOffStageGuest) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <div style={styles.logoMark}>
              <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="7" fill="url(#g2-waiting)" />
                <circle cx="16" cy="16" r="4" fill="white" />
                <defs><linearGradient id="g2-waiting" x1="0" y1="0" x2="32" y2="32"><stop stopColor="#a78bfa" /><stop offset="1" stopColor="#67e8f9" /></linearGradient></defs>
              </svg>
            </div>
            <h2 style={styles.roomTitle}>{room?.name || 'Studio'}</h2>
            <div style={styles.divider} />
            <span style={styles.waitingBadge}>
              <span style={styles.waitingDot} />
              {holdLabel}
            </span>
          </div>
          <div style={styles.headerRight}>
            <button
              style={{
                ...styles.healthBtn,
                borderColor: getHealthColor(sessionHealth.status),
                color: getHealthColor(sessionHealth.status),
              }}
              onClick={() => setShowHealthPanel(true)}
              title="Session health"
              aria-label={`Session health: ${sessionHealth.label}, ${sessionHealth.score}`}
            >
              <span style={{ ...styles.healthDot, background: getHealthColor(sessionHealth.status) }} />
              {sessionHealth.score}
            </button>
            <span style={styles.roomIdBadge}>{roomId}</span>
          </div>
        </div>

        <div style={styles.waitingMain}>
          <div style={styles.waitingShell}>
            <div style={styles.waitingPreview}>
              <VideoTile
                stream={localStream}
                name={myParticipant?.name || userName}
                isLocal
                audioEnabled={effectiveAudioEnabled}
                videoEnabled={effectiveVideoEnabled}
                brandColor={brandColor}
                cameraShape={cameraShape}
                nameTagStyle={nameTagStyle}
              />
            </div>
            <div style={styles.waitingCopy}>
              <span style={styles.waitingKicker}>{holdKicker}</span>
              <h1 style={styles.waitingTitle}>{holdTitle}</h1>
              <p style={styles.waitingText}>{holdText}</p>
              {guestNotification && (
                <div style={{
                  ...styles.waitingNotice,
                  ...(guestNotification.tone === 'warning' ? styles.waitingNoticeWarning : {}),
                  ...(guestNotification.tone === 'success' ? styles.waitingNoticeSuccess : {}),
                }}>
                  <span style={styles.waitingNoticeIcon}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 2 11 13" />
                      <path d="m22 2-7 20-4-9-9-4 20-7z" />
                    </svg>
                  </span>
                  <span style={styles.waitingNoticeCopy}>
                    <strong style={styles.waitingNoticeTitle}>{guestNotification.title}</strong>
                    <span style={styles.waitingNoticeText}>{guestNotification.message}</span>
                  </span>
                </div>
              )}
              {offStageGuestStatus === 'green-room' && waitingCount > 0 && (
                <span style={styles.waitingQueue}>{waitingCount} waiting</span>
              )}
            </div>
          </div>
        </div>

        <ControlBar
          audioEnabled={effectiveAudioEnabled}
          videoEnabled={effectiveVideoEnabled}
          onToggleAudio={onToggleAudio}
          onToggleVideo={onToggleVideo}
          onLeave={onLeave}
          onOpenDeviceSettings={() => setShowDeviceSettings(true)}
          roomId={roomId || ''}
          isHost={false}
          isScreenSharing={false}
          onOpenChat={offStageGuestStatus === 'backstage' ? () => setShowGuestChat(!showGuestChat) : undefined}
          participantCount={allParticipantsMap.size}
          isLive={isLive}
        />

        {offStageGuestStatus === 'backstage' && showGuestChat && (
          <ChatPanel
            messages={chatMessages.filter((msg) => msg.isBackstage)}
            onSend={(content) => onSendChat(content, true)}
            onReact={onReactChat}
            onClose={() => setShowGuestChat(false)}
            senderName={userName}
            title="Backstage Chat"
            placeholder="Send a backstage note..."
            emptyText="No backstage notes yet"
            emptyHint="Coordinate with the host and backstage guests."
          />
        )}

        {showHealthPanel && (
          <SessionHealthPanel
            summary={sessionHealth}
            onClose={() => setShowHealthPanel(false)}
          />
        )}

        {showDeviceSettings && (
          <DeviceSelector
            audioDevices={audioDevices}
            videoDevices={videoDevices}
            audioOutputDevices={audioOutputDevices}
            selectedAudioDeviceId={selectedAudioDeviceId}
            selectedVideoDeviceId={selectedVideoDeviceId}
            selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
            onAudioDeviceChange={onAudioDeviceChange}
            onVideoDeviceChange={onVideoDeviceChange}
            onAudioOutputDeviceChange={onAudioOutputDeviceChange}
            onClose={() => setShowDeviceSettings(false)}
            virtualBackground={vbConfig}
            onVirtualBackgroundChange={setVbConfig}
            virtualBackgroundReady={vbReady}
            virtualBackgroundError={vbError}
          />
        )}
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logoMark}>
            <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="7" fill="url(#g2)" />
              <circle cx="16" cy="16" r="4" fill="white" />
              <defs><linearGradient id="g2" x1="0" y1="0" x2="32" y2="32"><stop stopColor="#a78bfa" /><stop offset="1" stopColor="#67e8f9" /></linearGradient></defs>
            </svg>
          </div>
          <h2 style={styles.roomTitle}>{room?.name || 'Studio'}</h2>
          <div style={styles.divider} />
          <span style={styles.badge}>
            <span style={styles.badgeDot} />
            {orderedVideoItems.length} in studio
          </span>
          {isHostOrCoHost && waitingCount > 0 && (
            <span style={styles.waitingBadge}>
              <span style={styles.waitingDot} />
              {waitingCount} waiting
            </span>
          )}
          {sessionRecordingActive && (
            <span style={styles.recBadge}>
              <span style={styles.recDot} />
              REC {sessionRecordingTime}
            </span>
          )}
          {isLive && (
            <span style={styles.liveBadge}>
              <span style={styles.liveBadgeDot} />
              LIVE
            </span>
          )}
          {captionsEnabled && isHostOrCoHost && (
            <span style={styles.captionBadge}>
              <span style={{
                ...styles.captionBadgeDot,
                background: captionsListening ? 'var(--success)' : 'var(--warning)',
              }} />
              CC
            </span>
          )}
          {myParticipant && (
            <span style={styles.roleBadge}>{myParticipant.role}</span>
          )}
        </div>
        <div style={styles.headerRight}>
          <button
            style={{
              ...styles.healthBtn,
              borderColor: getHealthColor(sessionHealth.status),
              color: getHealthColor(sessionHealth.status),
            }}
            onClick={() => setShowHealthPanel(true)}
            title="Session health"
            aria-label={`Session health: ${sessionHealth.label}, ${sessionHealth.score}`}
          >
            <span style={{ ...styles.healthDot, background: getHealthColor(sessionHealth.status) }} />
            {sessionHealth.score}
          </button>
          {isHostOrCoHost && (
            <button
              style={{ ...styles.headerBtn, ...(showSidebar ? styles.headerBtnActive : {}) }}
              onClick={() => setShowSidebar(!showSidebar)}
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
              aria-pressed={showSidebar}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
            </button>
          )}
          <span style={styles.roomIdBadge}>{roomId}</span>
        </div>
      </div>

      {/* Main Area */}
      <div style={styles.main}>
        {/* Stage */}
        <div style={styles.stage}>
          {/* Screen share overlay */}
          {isScreenSharing && (
            <div style={styles.screenShareBanner}>
              <span style={styles.screenShareDot} />
              You are sharing your screen
              <button className="hover-scale" style={styles.screenShareStopBtn} onClick={onToggleScreenShare} aria-label="Stop screen sharing">Stop Sharing</button>
            </div>
          )}

          {/* Fixed 16:9 Canvas */}
          <div style={styles.canvasWrapper}>
            <div ref={stageRef} style={{ ...styles.canvas, ...stageBackgroundStyle }}>
              <div style={{ ...styles.gridBase, ...layoutResult.containerStyle, position: 'relative' }}>
                {/* Render tiles based on layout engine */}
                {(() => {
                  // Determine which items to render based on layout
                  const itemsToRender = layout === 'side-by-side'
                    ? orderedVideoItems.slice(0, 2)
                    : layout === 'single'
                      ? orderedVideoItems.slice(0, 1)
                      : layout === 'pip'
                        ? orderedVideoItems.slice(0, 2)
                        : orderedVideoItems;

                  return itemsToRender.map((item, i) => {
                    const isPipSmallTile = layout === 'pip' && i === 1;
                    const isFocusedTile = focusedVideoItemId === item.id;
                    const canFocusTile = isHostOrCoHost && orderedVideoItems.length > 1;
                    return (
                      <div
                        key={item.id}
                        style={{
                          ...styles.tileWrapper,
                          ...(isFocusedTile ? styles.tileWrapperFocused : {}),
                          ...(layoutResult.tileStyles[i] || {}),
                        }}
                        onClick={isPipSmallTile ? () => {
                          setPipCorner((prev) => {
                            const order: Array<'TL' | 'TR' | 'BR' | 'BL'> = ['TL', 'TR', 'BR', 'BL'];
                            return order[(order.indexOf(prev) + 1) % 4];
                          });
                        } : undefined}
                        title={isPipSmallTile ? 'Click to move PiP position' : undefined}
                      >
                        {canFocusTile && (
                          <button
                            type="button"
                            style={{ ...styles.focusTileBtn, ...(isFocusedTile ? styles.focusTileBtnActive : {}) }}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (isFocusedTile) {
                                setFocusedVideoItemId(null);
                                return;
                              }
                              setFocusedVideoItemId(item.id);
                              if (layout === 'grid') setLayout('spotlight');
                            }}
                            aria-label={isFocusedTile ? `Clear main stage focus for ${item.name}` : `Make ${item.name} the main stage tile`}
                            title={isFocusedTile ? 'Clear main stage focus' : 'Make main stage tile'}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill={isFocusedTile ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                            </svg>
                          </button>
                        )}
                        <VideoTile
                          stream={item.stream}
                          name={item.name}
                          isLocal={item.isLocal}
                          isScreenShare={item.isScreenShare}
                          audioEnabled={item.audioEnabled}
                          videoEnabled={item.videoEnabled}
                          volume={item.volume}
                          brandColor={brandColor}
                          cameraShape={cameraShape}
                          nameTagStyle={nameTagStyle}
                        />
                      </div>
                    );
                  });
                })()}

                {/* Media overlay on stage */}
                {activeMedia && (
                  <div className="studio-active-media" style={styles.mediaOverlay}>
                    {activeMedia.type === 'video' ? (
                      <video src={activeMedia.url} style={styles.mediaContent} autoPlay controls />
                    ) : activeMedia.type === 'image' ? (
                      <img src={activeMedia.url} alt={activeMedia.name} style={styles.mediaContent} />
                    ) : activeMedia.type === 'pdf' ? (
                      <iframe src={activeMedia.url} style={styles.mediaContent} title="PDF" />
                    ) : (
                      <div style={styles.mediaDocumentCard}>
                        <div style={styles.mediaDocumentIcon}>
                          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 3h20v14H2z" />
                            <path d="M8 21h8" />
                            <path d="M12 17v4" />
                          </svg>
                        </div>
                        <div style={styles.mediaDocumentTitle}>{activeMedia.name}</div>
                        <div style={styles.mediaDocumentType}>{activeMedia.type === 'presentation' ? 'Presentation deck' : 'Shared file'}</div>
                      </div>
                    )}
                    <button className="panel-close-btn" style={styles.mediaCloseBtn} onClick={onStopMedia} aria-label="Close media overlay">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}

                {/* Lower Third Overlay */}
                {visibleLowerThird && <LowerThirdOverlay data={visibleLowerThird} />}

                {/* Banner Overlays */}
                {visibleBanners.map((b) => (
                  <BannerOverlayDisplay key={b.id} data={b} />
                ))}

                {/* Timer Overlays */}
                {visibleTimers.map((t) => (
                  <TimerOverlayDisplay key={t.id} data={t} />
                ))}

                {/* Ticker Overlays */}
                {visibleTickers.map((t) => (
                  <TickerOverlayDisplay key={t.id} data={t} />
                ))}

                {/* Comment Highlight Overlay */}
                <CommentHighlightOverlay comment={highlightedComment} />

                {/* Webinar Q&A Overlay */}
                <WebinarQAOverlay question={highlightedQA} />

                {/* Live Poll Overlay */}
                <LivePollOverlay poll={highlightedPoll} />

                {/* Live Caption Overlay */}
                <LiveCaptionOverlay
                  caption={broadcastCaption}
                  brandColor={brandColor}
                  bottomOffset={captionBottomOffset}
                />
              </div>

              {/* Logo watermark */}
              {logoUrl && (
                <div style={{ ...styles.logoWatermark, ...getLogoPlacementStyle(logoPlacement) }}>
                  <img src={logoUrl} alt="Logo" style={{ ...styles.logoWatermarkImg, ...getLogoSizeStyle(logoSize) }} />
                </div>
              )}

              {/* Debug Compositor Preview (development only) */}
              {showCompositorDebug && (
                <div style={{ position: 'absolute', top: 16, right: 16, width: 240, aspectRatio: '16/9', border: '2px solid red', borderRadius: 8, overflow: 'hidden', zIndex: 1000, background: '#000', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                  <span style={{ position: 'absolute', top: 4, left: 4, background: 'red', color: 'white', fontSize: 10, padding: '2px 4px', borderRadius: 4, fontWeight: 'bold', zIndex: 10 }}>COMPOSITOR OUTPUT</span>
                  <video
                    autoPlay
                    muted
                    playsInline
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    ref={(el) => {
                      if (el && compositeStreamRef.current && el.srcObject !== compositeStreamRef.current) {
                        el.srcObject = compositeStreamRef.current;
                      }
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Floating layout switcher (like StreamYard) — below canvas */}
          {isHostOrCoHost && (
            <div style={styles.layoutBar}>
              <LayoutSwitcher
                currentLayout={layout}
                onLayoutChange={setLayout}
                participantCount={orderedVideoItems.length}
              />
            </div>
          )}

          {/* Teleprompter overlay */}
          {showTeleprompter && (
            <Suspense fallback={<LazyPanelFallback />}>
              <Teleprompter onClose={() => setShowTeleprompter(false)} />
            </Suspense>
          )}
        </div>

        {/* Stream Destinations Panel */}
        {showStreamDest && (
          <Suspense fallback={<LazyPanelFallback />}>
            <StreamDestinationsPanel
              destinations={destinations}
              onAdd={onAddDestination}
              onUpdate={onUpdateDestination}
              onRemove={onRemoveDestination}
              onToggle={onToggleDestination}
              broadcastOrientation={broadcastOrientation}
              onBroadcastOrientationChange={setBroadcastOrientation}
              isLive={isLive}
              relayStats={relayStats}
              relayReadiness={relayReadiness}
              onRetryRelayReadiness={checkRelayReadiness}
              onGoLive={onGoLive}
              onStopLive={onStopLive}
              onClose={() => setShowStreamDest(false)}
            />
          </Suspense>
        )}

        {/* Guest Chat Panel */}
        {!isHostOrCoHost && showGuestChat && (
          <ChatPanel
            messages={chatMessages.filter((msg) => !msg.isBackstage)}
            onSend={onSendChat}
            onReact={onReactChat}
            onClose={() => setShowGuestChat(false)}
            senderName={userName}
          />
        )}

        {/* Sidebar (right) - host/co-host only */}
        {isHostOrCoHost && showSidebar && (
          <Sidebar
            activeTab={sidebarActiveTab}
            onActiveTabChange={setSidebarActiveTab}
            lowerThirds={lowerThirds}
            onAddLowerThird={onAddLowerThird}
            onToggleLowerThird={onToggleLowerThird}
            onRemoveLowerThird={onRemoveLowerThird}
            banners={banners}
            onAddBanner={onAddBanner}
            onToggleBanner={onToggleBanner}
            onRemoveBanner={onRemoveBanner}
            timers={timers}
            onAddTimer={onAddTimer}
            onToggleTimer={onToggleTimer}
            onRemoveTimer={onRemoveTimer}
            onUpdateTimer={onUpdateTimer}
            stageBackground={stageBackground}
            onStageBackgroundChange={setStageBackground}
            brandColor={brandColor}
            onBrandColorChange={setBrandColor}
            logoUrl={logoUrl}
            onLogoUrlChange={setLogoUrl}
            logoPlacement={logoPlacement}
            onLogoPlacementChange={setLogoPlacement}
            logoSize={logoSize}
            onLogoSizeChange={setLogoSize}
            cameraShape={cameraShape}
            onCameraShapeChange={setCameraShape}
            nameTagStyle={nameTagStyle}
            onNameTagStyleChange={setNameTagStyle}
            mediaAssets={mediaAssets}
            activeMedia={activeMedia}
            onUploadMedia={onUploadMedia}
            onAddMediaUrl={onAddMediaUrl}
            onPlayMediaAsset={onPlayMediaAsset}
            onRemoveMediaAsset={onRemoveMediaAsset}
            onStopMedia={onStopMedia}
            scenes={scenes}
            activeSceneId={activeSceneId}
            onSaveScene={onSaveScene}
            onCreateTemplateScene={onCreateTemplateScene}
            onApplyScene={onApplyScene}
            onDeleteScene={onDeleteScene}
            onRenameScene={onRenameScene}
            tickers={tickers}
            onAddTicker={onAddTicker}
            onToggleTicker={onToggleTicker}
            onRemoveTicker={onRemoveTicker}
            onUpdateTicker={onUpdateTicker}
            chatMessages={chatMessages}
            highlightedComment={highlightedComment}
            onHighlightComment={onHighlightComment}
            onDismissComment={onDismissComment}
            chatPanelMessages={chatMessages}
            onSendChat={onSendChat}
            onReactChat={onReactChat}
            onToggleChatStar={onToggleChatStar}
            chatSenderName={userName}
            allParticipants={allParticipantsMap}
            myParticipantId={myParticipant?.id || ''}
            myRole={myParticipant?.role || 'guest'}
            onStageAction={onStageAction}
            remoteStreams={remoteStreams}
            localStream={localStream}
            participantVolumes={participantVolumes}
            onParticipantVolumeChange={handleParticipantVolumeChange}
          />
        )}

        {/* Webinar Q&A Panel (host) */}
        {isHostOrCoHost && showWebinarQA && (
          <WebinarQAPanel
            questions={qaQuestions}
            onApprove={onApproveQuestion}
            onDismiss={onDismissQuestion}
            onAnswer={onAnswerQuestion}
            onHighlight={onHighlightQuestion}
            onUnhighlight={onUnhighlightQuestion}
            onClose={() => setShowWebinarQA(false)}
          />
        )}

        {/* Webinar Q&A Audience (guest) */}
        {!isHostOrCoHost && showWebinarQA && (
          <WebinarQAAudience
            questions={qaQuestions.filter(q => q.status === 'approved' || q.status === 'answered' || q.authorId === myParticipant?.id)}
            onSubmitQuestion={onSubmitQuestion}
            onUpvote={onUpvoteQuestion}
            myUpvotes={myUpvotes}
          />
        )}

        {showPolls && (
          <LivePollsPanel
            polls={polls}
            canManagePolls={canManagePolls}
            canVotePolls={canVotePolls}
            myVotes={myPollVotes}
            onCreatePoll={onCreatePoll}
            onVote={onVotePoll}
            onClosePoll={onClosePoll}
            onHighlightPoll={onHighlightPoll}
            onUnhighlightPoll={onUnhighlightPoll}
            onClose={() => setShowPolls(false)}
          />
        )}

        {isHostOrCoHost && showCaptionsPanel && (
          <LiveCaptionsPanel
            enabled={captionsEnabled}
            listening={captionsListening}
            supported={captionsSupported}
            language={captionLanguage}
            error={captionsError}
            segments={captionSegments}
            roomName={room?.name || 'Studio'}
            onToggle={() => setCaptionsEnabled((current) => !current)}
            onLanguageChange={setCaptionLanguage}
            onClear={clearCaptions}
            onClose={() => setShowCaptionsPanel(false)}
          />
        )}

        {isHostOrCoHost && showInvitePanel && (
          <Suspense fallback={<LazyPanelFallback />}>
            <InvitePanel
              roomName={room?.name || 'Studio'}
              roomId={roomId || ''}
              hostName={room?.hostName}
              inviteUrl={inviteUrl}
              scheduledFor={room?.scheduledFor}
              passwordProtected={Boolean(room?.settings.passwordProtected)}
              participantCount={allParticipantsMap.size}
              waitingCount={waitingCount}
              isLive={isLive}
              onCreateCoHostInvite={requestCoHostInvite}
              onClose={() => setShowInvitePanel(false)}
            />
          </Suspense>
        )}

        {/* Recording Panel */}
        {showRecordingPanel && (
          <Suspense fallback={<LazyPanelFallback />}>
            <RecordingPanel
              isRecording={isLocalRecording}
              formattedTime={localRecFormattedTime}
              recordingTrackLabels={localRecordingLabels}
              recordingMarkers={recordingMarkers}
              onStartRecording={onStartLocalRecording}
              onStopRecording={stopLocalRecording}
              onAddRecordingMarker={onAddRecordingMarker}
              onRemoveRecordingMarker={onRemoveRecordingMarker}
              onClearRecordingMarkers={onClearRecordingMarkers}
              onReplaceRecordingMarkers={onReplaceRecordingMarkers}
              roomName={room?.name || 'Studio'}
              captionSegments={captionSegments}
              captionLanguage={captionLanguage}
              onClose={() => setShowRecordingPanel(false)}
            />
          </Suspense>
        )}
      </div>

      {/* Control Bar */}
      <ControlBar
        audioEnabled={effectiveAudioEnabled}
        videoEnabled={effectiveVideoEnabled}
        onToggleAudio={onToggleAudio}
        onToggleVideo={onToggleVideo}
        onLeave={onLeave}
        onOpenDeviceSettings={() => setShowDeviceSettings(true)}
        roomId={roomId || ''}
        isHost={isHostOrCoHost}
        isRecording={isRecording}
        formattedTime={formattedTime}
        onToggleRecording={onToggleRecording}
        isScreenSharing={isScreenSharing}
        onToggleScreenShare={onToggleScreenShare}
        onOpenChat={isHostOrCoHost ? () => { setShowSidebar(true); setSidebarActiveTab('chat'); } : () => setShowGuestChat(!showGuestChat)}
        onOpenParticipants={() => { setShowSidebar(true); setSidebarActiveTab('people'); }}
        onOpenInvitePanel={isHostOrCoHost ? () => setShowInvitePanel(true) : undefined}
        onOpenStreamDestinations={() => setShowStreamDest(!showStreamDest)}
        onOpenSoundBoard={() => setShowSoundBoard(!showSoundBoard)}
        onOpenTeleprompter={() => setShowTeleprompter(!showTeleprompter)}
        onOpenMediaPanel={() => { setShowSidebar(true); setSidebarActiveTab('media'); }}
        onOpenBackgroundMusic={() => setShowBackgroundMusic(!showBackgroundMusic)}
        onOpenRecordingPanel={() => setShowRecordingPanel(!showRecordingPanel)}
        onOpenProducerPanel={() => setShowProducerPanel(!showProducerPanel)}
        onOpenWebinarQA={() => setShowWebinarQA(!showWebinarQA)}
        onOpenPolls={() => setShowPolls(!showPolls)}
        onOpenCaptions={isHostOrCoHost ? () => setShowCaptionsPanel(!showCaptionsPanel) : undefined}
        onOpenHealthPanel={() => setShowHealthPanel(true)}
        participantCount={allParticipantsMap.size}
        isLive={isLive}
        captionsActive={captionsEnabled}
      />

      {/* Producer Panel (full-screen overlay) */}
      {isHostOrCoHost && showProducerPanel && (
        <Suspense fallback={<LazyPanelFallback />}>
          <ProducerPanel
            participants={allParticipantsMap}
            myParticipantId={myParticipant?.id || ''}
            remoteStreams={remoteStreams}
            localStream={localStream}
            onStageAction={onStageAction}
            isLive={isLive}
            isRecording={isRecording}
            formattedTime={formattedTime}
            currentLayout={layout}
            onLayoutChange={setLayout}
            onClose={() => setShowProducerPanel(false)}
          />
        </Suspense>
      )}

      {/* Sound Board Modal */}
      {showSoundBoard && (
        <Suspense fallback={<LazyPanelFallback />}>
          <SoundBoard onClose={() => setShowSoundBoard(false)} />
        </Suspense>
      )}

      {/* Background Music Modal */}
      {showBackgroundMusic && (
        <Suspense fallback={<LazyPanelFallback />}>
          <BackgroundMusic onClose={() => setShowBackgroundMusic(false)} />
        </Suspense>
      )}

      {/* Session Health Panel */}
      {showHealthPanel && (
        <SessionHealthPanel
          summary={sessionHealth}
          onClose={() => setShowHealthPanel(false)}
        />
      )}

      {/* Device Settings Modal */}
      {showDeviceSettings && (
        <DeviceSelector
          audioDevices={audioDevices}
          videoDevices={videoDevices}
          audioOutputDevices={audioOutputDevices}
          selectedAudioDeviceId={selectedAudioDeviceId}
          selectedVideoDeviceId={selectedVideoDeviceId}
          selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
          onAudioDeviceChange={onAudioDeviceChange}
          onVideoDeviceChange={onVideoDeviceChange}
          onAudioOutputDeviceChange={onAudioOutputDeviceChange}
          onClose={() => setShowDeviceSettings(false)}
          virtualBackground={vbConfig}
          onVirtualBackgroundChange={setVbConfig}
          virtualBackgroundReady={vbReady}
          virtualBackgroundError={vbError}
        />
      )}

      {/* Room Ending Countdown Overlay */}
      {roomEnding && (
        <div style={styles.roomEndingOverlay}>
          <div style={styles.roomEndingCard}>
            <div style={styles.roomEndingIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <h2 style={styles.roomEndingTitle}>Room is ending...</h2>
            <div style={styles.roomEndingCountdown}>{endingCountdown}</div>
            <p style={styles.roomEndingSubtitle}>The host is ending this session</p>
            <div style={styles.roomEndingBar}>
              <div
                style={{
                  ...styles.roomEndingBarFill,
                  width: `${((10 - endingCountdown) / 10) * 100}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    background: 'var(--bg-primary)',
  },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
  },
  loadingText: { color: 'var(--text-secondary)', fontSize: 14 },
  spinner: {
    width: 36, height: 36,
    border: '2.5px solid var(--border)',
    borderTopColor: 'var(--accent)',
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },
  // Header
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: 'rgba(15, 23, 42, 0.8)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    flexShrink: 0,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  logoMark: { display: 'flex' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 6 },
  roomTitle: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  divider: { width: 1, height: 16, background: 'var(--border-strong)' },
  badge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, padding: '3px 10px', borderRadius: 20,
    background: 'var(--success-subtle)', color: 'var(--success)', fontWeight: 500,
  },
  badgeDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', animation: 'pulse 2s infinite' },
  waitingBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, padding: '3px 10px', borderRadius: 20,
    background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', fontWeight: 600,
  },
  waitingDot: { width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 2s infinite' },
  recBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
    background: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger, #ef4444)',
    fontFamily: 'monospace',
  },
  recDot: {
    width: 8, height: 8, borderRadius: '50%', background: 'var(--danger, #ef4444)',
    animation: 'livePulse 1.5s infinite',
  },
  liveBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 700, padding: '3px 12px', borderRadius: 20,
    background: '#ef4444', color: 'white',
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  liveBadgeDot: {
    width: 6, height: 6, borderRadius: '50%', background: 'white',
    animation: 'pulse 1.5s infinite',
  },
  captionBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 20,
    background: 'rgba(14, 165, 233, 0.14)', color: '#bae6fd',
  },
  captionBadgeDot: {
    width: 6, height: 6, borderRadius: '50%',
  },
  roleBadge: {
    fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
    background: 'var(--accent-subtle)', color: 'var(--accent)',
    textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  },
  headerBtn: {
    width: 32, height: 32, borderRadius: 8,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    color: 'var(--text-secondary)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, transition: 'all var(--transition-fast)',
  },
  headerBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  healthBtn: {
    height: 32,
    minWidth: 54,
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    border: '1px solid',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '0 9px',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    fontVariantNumeric: 'tabular-nums',
  },
  healthDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  roomIdBadge: {
    fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace',
    padding: '4px 8px', borderRadius: 6, background: 'var(--bg-tertiary)',
  },
  // Main
  main: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  waitingMain: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 24,
    background: 'rgba(0, 0, 0, 0.15)',
  },
  waitingShell: {
    width: 'min(960px, 100%)',
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: 24,
    alignItems: 'center',
  },
  waitingPreview: {
    aspectRatio: '16 / 9',
    borderRadius: 14,
    overflow: 'hidden',
    border: '2px solid rgba(245, 158, 11, 0.28)',
    background: '#0f172a',
    boxShadow: '0 10px 32px rgba(0, 0, 0, 0.35)',
  },
  waitingCopy: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
  },
  waitingKicker: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: '#fbbf24',
  },
  waitingTitle: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.1,
    fontWeight: 700,
    letterSpacing: 0,
  },
  waitingText: {
    margin: 0,
    maxWidth: 360,
    fontSize: 14,
    lineHeight: 1.55,
    color: 'var(--text-secondary)',
  },
  waitingNotice: {
    width: 'min(360px, 100%)',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 9,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(96, 165, 250, 0.24)',
    background: 'rgba(96, 165, 250, 0.1)',
    color: '#bfdbfe',
    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.18)',
  },
  waitingNoticeSuccess: {
    borderColor: 'rgba(34, 197, 94, 0.28)',
    background: 'rgba(34, 197, 94, 0.12)',
    color: '#bbf7d0',
  },
  waitingNoticeWarning: {
    borderColor: 'rgba(245, 158, 11, 0.28)',
    background: 'rgba(245, 158, 11, 0.12)',
    color: '#fde68a',
  },
  waitingNoticeIcon: {
    width: 20,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  waitingNoticeCopy: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  waitingNoticeTitle: {
    fontSize: 13,
    lineHeight: 1.25,
    color: 'currentColor',
  },
  waitingNoticeText: {
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--text-secondary)',
  },
  waitingQueue: {
    marginTop: 4,
    padding: '5px 10px',
    borderRadius: 999,
    background: 'rgba(255, 255, 255, 0.06)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 600,
  },
  stage: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    gap: 8,
    overflow: 'hidden',
    position: 'relative',
    background: 'rgba(0, 0, 0, 0.15)',
  },
  canvasWrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 0,
  },
  canvas: {
    position: 'relative',
    width: '100%',
    maxHeight: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 14,
    overflow: 'hidden',
    border: '2px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
    background: '#0f172a',
  },
  // Base grid container — actual layout props are merged from layoutResult.containerStyle
  gridBase: {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box' as const,
    transition: 'opacity 0.3s ease, gap 0.3s ease',
  },
  // Generic tile wrapper — per-tile sizing is merged from layoutResult.tileStyles[i]
  tileWrapper: {
    boxSizing: 'border-box' as const,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    borderRadius: 16,
    position: 'relative',
    transition: 'width 0.3s ease, height 0.3s ease, flex-basis 0.3s ease, opacity 0.3s ease, border-radius 0.3s ease, transform 0.3s ease',
  },
  tileWrapperFocused: {
    outline: '2px solid var(--accent)',
    outlineOffset: -2,
  },
  focusTileBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 12,
    width: 30,
    height: 30,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.18)',
    background: 'rgba(15, 23, 42, 0.72)',
    color: 'rgba(255, 255, 255, 0.86)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0, 0, 0, 0.24)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  },
  focusTileBtnActive: {
    background: 'var(--accent)',
    border: '1px solid var(--accent)',
    color: 'white',
  },
  layoutBar: {
    flexShrink: 0,
    zIndex: 10,
  },
  // Screen share banner
  screenShareBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 16px',
    background: 'rgba(34, 197, 94, 0.12)',
    border: '1px solid rgba(34, 197, 94, 0.25)',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 500,
    color: '#22c55e',
    marginBottom: 8,
    alignSelf: 'stretch',
  },
  screenShareDot: {
    width: 6, height: 6, borderRadius: '50%', background: '#22c55e',
    animation: 'pulse 2s infinite',
  },
  screenShareStopBtn: {
    marginLeft: 'auto',
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: 600,
    background: '#ef4444',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  // Media overlay
  mediaOverlay: {
    position: 'absolute',
    inset: 8,
    background: '#000',
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    overflow: 'hidden',
  },
  mediaContent: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    border: 'none',
  },
  mediaDocumentCard: {
    width: 'min(520px, 72%)',
    minHeight: 260,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
    borderRadius: 16,
    background: 'linear-gradient(135deg, rgba(17,24,39,0.96), rgba(49,46,129,0.88))',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'white',
    textAlign: 'center',
  },
  mediaDocumentIcon: {
    width: 76,
    height: 76,
    borderRadius: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.08)',
    color: '#c4b5fd',
  },
  mediaDocumentTitle: {
    maxWidth: '100%',
    fontSize: 22,
    fontWeight: 700,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  mediaDocumentType: {
    fontSize: 13,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.62)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  mediaCloseBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'rgba(0,0,0,0.6)',
    border: '1px solid rgba(255,255,255,0.15)',
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    zIndex: 11,
  },
  // Room ending overlay
  roomEndingOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.75)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  roomEndingCard: {
    background: 'rgba(15, 23, 42, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    padding: '40px 48px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    minWidth: 320,
    boxShadow: '0 24px 48px rgba(0, 0, 0, 0.4)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  roomEndingIcon: {
    color: 'var(--text-muted)',
    marginBottom: 8,
  },
  roomEndingTitle: {
    fontSize: 20,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    letterSpacing: '-0.01em',
  },
  roomEndingCountdown: {
    fontSize: 64,
    fontWeight: 700,
    color: 'var(--accent)',
    fontFamily: 'monospace',
    lineHeight: 1,
    margin: '12px 0',
  },
  roomEndingSubtitle: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    margin: 0,
  },
  roomEndingBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    background: 'var(--bg-tertiary)',
    marginTop: 20,
    overflow: 'hidden',
  },
  roomEndingBarFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: 2,
    transition: 'width 1s linear',
  },
  // Logo watermark
  logoWatermark: {
    position: 'absolute',
    zIndex: 6,
    opacity: 0.85,
    pointerEvents: 'none',
  },
  logoWatermarkImg: {
    objectFit: 'contain',
  },
};
