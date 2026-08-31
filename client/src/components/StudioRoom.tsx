import { lazy, Suspense, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ActiveMedia, LogoPlacement, LogoPosition, LogoSize, SignalMessage, Participant, Room, LayoutMode, ChatMessage, ChatTypingPayload, ChatReactionType, StreamDestination, StageActionPayload, StageBackground, Scene, CameraShape, NameTagStyle, QAQuestion, StudioMediaAsset, StudioMediaType, ParticipantNotificationPayload, LivePoll, BroadcastOrientation, RtmpRelayBackupRecordingPayload, RtmpRelayDestinationStatus, StudioBrandingPayload, WaitingRoomBranding, ExternalChatStatusPayload, ExternalChatPlatform } from '@studio/shared';
import { ROOM_NOT_OPEN_ERROR_CODE, canExchangeStudioMedia } from '@studio/shared';

function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}

import { useSignaling } from '../hooks/useSignaling.ts';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';
import { useWebRTC } from '../hooks/useWebRTC.ts';
import { DEFAULT_ICE_CONFIG, fetchIceConfig } from '../utils/iceConfig.ts';
import type { PeerBandwidthHealth } from '../utils/webrtcBandwidthAdaptation.ts';
import { SfuSocketSession } from '../utils/sfuSocket.ts';
import { mergeSfuMediaWithMeshFallback, shouldUseSfuMedia, type SfuTransportStatus } from '../utils/sfuRuntime.ts';
import { useVirtualBackground, type VirtualBackgroundConfig } from '../hooks/useVirtualBackground.ts';
import { useRecording, type RecordingStreamInput } from '../hooks/useRecording.ts';
import { useScreenShare } from '../hooks/useScreenShare.ts';
import { useLocalRecording, type LocalRecordingSource } from '../hooks/useLocalRecording.ts';
import { persistRecordingSession, type LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import { useCompositor } from '../hooks/useCompositor.ts';
import { useLiveCaptions } from '../hooks/useLiveCaptions.ts';
import { useRtmpRelay } from '../hooks/useRtmpRelay.ts';
import { useBroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { useSessionHealth, type HealthStatus } from '../hooks/useSessionHealth.ts';
import { useMediaServerHealth } from '../hooks/useMediaServerHealth.ts';
import type { SessionPeerHealthParticipant } from '../utils/sessionPeerHealth.ts';
import {
  clearUrlHostToken,
  getHostSession,
  getSavedHostStudio,
  getStoredParticipantRole,
  getStoredUserName,
  getUrlHostToken,
  persistLegacyHostSession,
  persistHostSession,
  removeSavedHostStudio,
} from '../utils/hostSession.ts';
import { VideoTile } from './VideoTile.tsx';
import { ControlBar } from './ControlBar.tsx';
import { DeviceSelector } from './DeviceSelector.tsx';
import { Sidebar, type SidebarTab } from './Sidebar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { LowerThirdOverlay, type LowerThirdData } from './LowerThird.tsx';
import { canPlayMediaAsset, detectMediaType } from './MediaLibrary.tsx';
import {
  buildPresentationPreview,
  getPowerPointRenderStrategy,
  hasRenderedPresentationSlides,
  type PresentationServerRenderFailure,
} from '../utils/presentationPreview.ts';
import {
  clampPresentationSlideIndex,
  getPresentationDeckUnitLabel,
  getNextPresentationSlideIndex,
  getPresentationSlides,
} from '../utils/presentationDeckControls.ts';
import { BannerOverlayDisplay, type BannerData } from './BannerOverlay.tsx';
import { TimerOverlayDisplay, useTimerTick, type TimerData } from './TimerOverlay.tsx';
import { LayoutSwitcher } from './LayoutSwitcher.tsx';
import { createActiveSpeakerTracker } from '../utils/activeSpeaker.ts';
import { planMeshCapacity } from '../utils/meshCapacityPlanner.ts';
import {
  groupShortcutsByCategory,
  resolveShortcutId,
  shouldIgnoreShortcutTarget,
} from '../utils/keyboardShortcuts.ts';
import { CommentHighlightOverlay, type HighlightedComment } from './CommentHighlight.tsx';
import { TickerOverlayDisplay, type TickerData } from './TickerOverlay.tsx';
import { WidgetOverlayDisplay, type WidgetOverlayData } from './WidgetOverlay.tsx';
import { WebinarQAPanel, WebinarQAOverlay, WebinarQAAudience } from './WebinarQA.tsx';
import { SessionHealthPanel } from './SessionHealthPanel.tsx';
import { LivePollsPanel, LivePollOverlay } from './LivePolls.tsx';
import { LiveCaptionsPanel, LiveCaptionOverlay } from './LiveCaptions.tsx';
import { ReactionOverlay, createFloatingReaction, REACTION_OVERLAY_DURATION_MS, type FloatingReaction } from './ReactionOverlay.tsx';
import type {
  BlobExportDownload,
  RecordingMarker,
  RecordingServerClipExportInput,
  RecordingServerExportArtifactInput,
  RecordingServerExportRefreshInput,
  RecordingServerUploadInput,
} from './RecordingPanel.tsx';
import { buildBrandThemeVariables } from '../utils/brandTheme.ts';
import { DEFAULT_LOGO_OPACITY, normalizeLogoOpacity } from '../utils/logoWatermark.ts';
import { getCustomLogoPositionStyle, getLogoPositionFromPointer, normalizeLogoPosition } from '../utils/logoPosition.ts';
import { readPreferredAudioProcessing, readPreferredVideoQuality, type AudioProcessingPreferences, type VideoQualityPresetId } from '../utils/mediaPreferences.ts';
import {
  VIRTUAL_BACKGROUND_STORAGE_KEY,
  normalizeVirtualBackgroundConfig,
  parseVirtualBackgroundConfig,
  serializeVirtualBackgroundConfig,
} from '../utils/virtualBackgrounds.ts';
import {
  getMediaShareLayoutPlan,
  mergeSharedMediaParticipantItems,
  selectVisibleStageItems,
  type MediaShareParticipantPlacement,
} from '../utils/mediaShareLayouts.ts';
import { buildGuestInviteUrl, buildSecureGuestInviteUrl } from '../utils/inviteLinks.ts';
import { getStudioRecordingStatus } from '../utils/studioRecordingStatus.ts';
import {
  buildLiveSessionSummary,
  getLiveStreamElapsedSeconds,
  getLiveStreamStatus,
  type LiveSessionSummary,
} from '../utils/liveStreamStatus.ts';
import { getProductionExitGuardDecision } from '../utils/productionExitGuard.ts';
import {
  getProductionScenePackTemplateIds,
  getProductionSceneTemplateConfig,
  type ProductionSceneTemplate,
  type ProductionSceneTemplateConfig,
} from '../utils/productionSceneTemplates.ts';
import { getStreamDestinationIssue } from '../utils/streamDestinations.ts';
import {
  CHAT_TYPING_TTL_MS,
  getChatTypingNames,
  removeExpiredChatTypingIndicators,
  upsertChatTypingIndicator,
  type ChatTypingIndicator,
} from '../utils/chatTyping.ts';
import {
  DEFAULT_RTMP_RELAY_OUTPUT_PRESET_ID,
  type RtmpRelayOutputPresetId,
} from '../utils/rtmpRelayOutput.ts';
import {
  buildRecordingReadinessSummary,
  type RecordingParticipantReadiness,
} from '../utils/recordingReadiness.ts';
import { getDuckedParticipantVolumes } from '../utils/audioDucking.ts';
import { getLiveAudioTracks } from '../utils/audioStreamTracks.ts';
import { buildLocalRecordingSources, buildParticipantRecordingSources } from '../utils/localRecordingSources.ts';
import {
  downloadRecordingExportArtifact,
  exportDistributedRecordingSession,
  getRecordingExportJob,
  requestRecordingClipExport,
  uploadRecordingToMediaServer,
  waitForDistributedRecordingSession,
  type RecordingUploadFileInput,
} from '../utils/recordingUpload.ts';
import { getRecordingFileExtension } from '../utils/recordingMimeTypes.ts';
import { syncRecordingCatalogEntry } from '../utils/recordingCatalog.ts';
import {
  downloadRtmpBackupRecording,
  pollRtmpBackupRecording,
} from '../utils/rtmpBackupRecording.ts';
import {
  buildToolbarRecordingUploadFiles,
  formatRecordingTimestamp,
  getToolbarRecordingFallbackToast,
  makeToolbarRecordingFileName,
} from '../utils/toolbarRecording.ts';
import {
  getSceneActiveMediaForApply,
  getSceneActiveMediaSnapshot,
  getScenePipCornerForApply,
  getSceneStageItemOrderForApply,
  normalizeSceneActiveMediaSnapshot,
} from '../utils/sceneApplication.ts';
import {
  createScreenPictureInPictureStream,
} from '../utils/screenPictureInPicture.ts';
import {
  canControlStudioRecording,
  canUseAdmittedOperatorControls,
  isStudioOperator,
} from '../utils/studioAccess.ts';
import {
  applyStageItemOrder,
  moveStageItemInOrder,
  normalizeStageItemOrder,
  reorderStageItemBefore,
  type StageItemOrderDirection,
} from '../utils/stageItemOrder.ts';
import {
  getStagePresenceTransitionDelayMs,
  getStagePresenceWrapperStyle,
  reconcileStagePresenceItems,
  type StagePresenceTrackedItem,
} from '../utils/stagePresenceTransitions.ts';
import {
  LAYOUT_SWITCH_TRANSITION_DURATION_MS,
  getStageLayoutTransitionStyle,
  shouldStartLayoutTransition,
  type StageLayoutTransition,
} from '../utils/layoutTransitions.ts';
import { getStageTilePrimaryClickAction } from '../utils/stageTileInteractions.ts';
import { duplicateSceneInOrder, moveSceneInOrder, replaceSceneInOrder, type SceneOrderDirection } from '../utils/sceneOrder.ts';
import {
  buildPopoutChatUrl,
  createPopoutChatSessionId,
  getPopoutChatChannelName,
  isPopoutChatCommand,
  type PopoutChatState,
} from '../utils/popoutChat.ts';
import {
  AUTO_SPEAKER_LOWER_THIRD_DURATION_SECONDS,
  LOWER_THIRD_ANIMATION_EXIT_MS,
  addLowerThird,
  normalizeLowerThirdDurationSeconds,
  getParticipantLowerThirdTitle,
  selectAutoSpeakerLowerThirdCandidate,
  toggleLowerThirdVisibility,
  type AutoSpeakerLowerThirdCandidate,
  type LowerThirdDraft,
  upsertAutoSpeakerLowerThird,
} from '../utils/lowerThirds.ts';
import {
  MAX_SCENE_PACK_BYTES,
  buildScenePack,
  buildScenePackFilename,
  importScenePack,
  parseScenePackJson,
  type ScenePackOverlayKind,
} from '../utils/scenePacks.ts';
import {
  DEFAULT_SCENE_TRANSITION_PRESET_ID,
  getSceneTransitionOverlayStyle,
  isPersistableSceneStingerClip,
  normalizeSceneStingerClip,
  normalizeSceneTransitionPresetId,
  type SceneStingerClip,
  type SceneTransitionPresetId,
} from '../utils/sceneTransitions.ts';
import {
  DEFAULT_STUDIO_THEME_ID,
  normalizeStudioThemeId,
  type StudioThemeId,
} from '../utils/studioThemes.ts';
import {
  DEFAULT_WAITING_ROOM_BRANDING,
  buildStudioBrandingPayload,
  normalizeWaitingRoomBranding,
} from '../utils/waitingRoomBranding.ts';
import {
  DEFAULT_STREAM_SCREEN_CONFIG,
  buildActiveStreamScreen,
  normalizeStreamScreenConfig,
  type StreamScreenConfig,
  type StreamScreenKind,
} from '../utils/streamScreens.ts';
import { useToast } from './Toast.tsx';

const STUDIO_STATE_VERSION = 1;
const INVITE_BASE_URL = import.meta.env.VITE_INVITE_BASE_URL || window.location.origin;
const MAX_PERSISTED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_STUDIO_SCENES = 12;
const SCENE_TRANSITION_DURATION_MS = 520;
const STINGER_TRANSITION_DURATION_MS = 1200;
const GUEST_JOIN_SESSION_STORAGE_KEY = 'livestream-studio:guest-join-session-id';
const HOST_ACCESS_MISSING_MESSAGE = 'Host access is missing or expired. Reopen this studio from the saved host entry on the home screen.';

const StreamDestinationsPanel = lazy(() => import('./StreamDestinations.tsx').then((module) => ({ default: module.StreamDestinations })));
const InvitePanel = lazy(() => import('./InvitePanel.tsx').then((module) => ({ default: module.InvitePanel })));
const SoundBoard = lazy(() => import('./SoundBoard.tsx').then((module) => ({ default: module.SoundBoard })));
const Teleprompter = lazy(() => import('./Teleprompter.tsx').then((module) => ({ default: module.Teleprompter })));
const BackgroundMusic = lazy(() => import('./BackgroundMusic.tsx').then((module) => ({ default: module.BackgroundMusic })));
const RecordingPanel = lazy(() => import('./RecordingPanel.tsx').then((module) => ({ default: module.RecordingPanel })));
const ProducerPanel = lazy(() => import('./ProducerPanel.tsx').then((module) => ({ default: module.ProducerPanel })));

interface ProductionSceneDraft {
  scene: Scene;
  config: ProductionSceneTemplateConfig;
  lowerThird: LowerThirdData | null;
  banner: BannerData | null;
  ticker: TickerData | null;
  timer: TimerData | null;
}

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
  studioTheme?: StudioThemeId;
  stageBackground: StageBackground;
  brandColor: string;
  logoUrl: string | null;
  waitingRoomBranding?: WaitingRoomBranding;
  streamScreens?: StreamScreenConfig;
  logoPlacement: LogoPlacement;
  logoPosition: LogoPosition | null;
  logoSize: LogoSize;
  logoOpacity: number;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  pipCorner: 'TL' | 'TR' | 'BL' | 'BR';
  stageItemOrder: string[];
  mediaAssets: StudioMediaAsset[];
  scenes: Scene[];
  activeSceneId: string | null;
  sceneTransitionPreset?: SceneTransitionPresetId;
  sceneStingerClip?: SceneStingerClip | null;
  lowerThirds: LowerThirdData[];
  autoSpeakerLowerThirds?: boolean;
  audioDuckingEnabled?: boolean;
  banners: BannerData[];
  timers: TimerData[];
  tickers: TickerData[];
  widgets: WidgetOverlayData[];
}

interface StageVideoItem {
  id: string;
  name: string;
  stream: MediaStream | null;
  isLocal: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  volume: number;
  isScreenShare?: boolean;
  connectionHealth?: PeerBandwidthHealth | null;
}

interface PendingLiveTokenRequest {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRecordingUploadTokenRequest extends PendingLiveTokenRequest {
  sessionId: string;
}

interface PendingCoHostInviteRequest {
  resolve: (payload: { token: string; expiresAt: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingGuestInviteRequest {
  resolve: (payload: { token: string; expiresAt: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SceneTransitionState {
  sceneId: string;
  sceneName: string;
  presetId: SceneTransitionPresetId;
  visible: boolean;
  durationMs: number;
  stingerClip?: SceneStingerClip | null;
}

interface ActiveStreamScreenState {
  kind: StreamScreenKind;
  activatedAtMs: number;
}

function getStudioStateKey(roomId: string): string {
  return `livestream-studio:room-state:${roomId}`;
}

type BrowserAudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext;

interface ProgramRecordingAudioSource {
  id?: string;
  stream: MediaStream;
  volume: number;
}

interface CreateProgramRecordingSourceOptions {
  compositeStream: MediaStream | null;
  localStream: MediaStream | null;
  localParticipant: Participant | null;
  participants: Map<string, Participant>;
  remoteStreams: Map<string, MediaStream>;
  screenStream: MediaStream | null;
  auxiliaryAudioStream: MediaStream | null;
  participantVolumes: Record<string, number>;
  participantAudioLevels: Record<string, number>;
  audioDuckingEnabled: boolean;
}

interface CreateScreenPictureInPictureRecordingSourceOptions {
  id: string;
  label: string;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
}

function getAudioContextConstructor(): BrowserAudioContextConstructor | null {
  const globalWithWebkit = globalThis as typeof globalThis & {
    webkitAudioContext?: BrowserAudioContextConstructor;
  };
  return globalWithWebkit.AudioContext || globalWithWebkit.webkitAudioContext || null;
}

function createRecordingAudioContext(AudioContextConstructor: BrowserAudioContextConstructor): AudioContext {
  try {
    return new AudioContextConstructor({ sampleRate: 48_000 });
  } catch {
    return new AudioContextConstructor();
  }
}

function createScreenPictureInPictureRecordingSource(
  options: CreateScreenPictureInPictureRecordingSourceOptions
): LocalRecordingSource | null {
  const pipStream = createScreenPictureInPictureStream({
    screenStream: options.screenStream,
    cameraStream: options.cameraStream,
    frameRate: 30,
  });
  if (!pipStream) return null;

  return {
    id: options.id,
    label: options.label,
    kind: 'screen',
    stream: new MediaStream([
      pipStream.videoTrack,
      ...getLiveAudioTracks(options.screenStream),
    ]),
    bitsPerSecond: 8_500_000,
    cleanup: pipStream.cleanup,
  };
}

function createProgramRecordingSource(options: CreateProgramRecordingSourceOptions): LocalRecordingSource | null {
  const videoTrack = options.compositeStream?.getVideoTracks().find((track) => track.readyState === 'live');
  if (!videoTrack) return null;

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) return null;

  const audioContext = createRecordingAudioContext(AudioContextConstructor);
  const destination = audioContext.createMediaStreamDestination();
  const audioSources: ProgramRecordingAudioSource[] = [];
  const participantIds: string[] = [];

  if (options.localParticipant?.status === 'on-stage') {
    participantIds.push(options.localParticipant.id);
  }
  for (const [id, participant] of options.participants) {
    if (participant.status === 'on-stage') participantIds.push(id);
  }

  const programVolumes = getDuckedParticipantVolumes({
    enabled: options.audioDuckingEnabled,
    participantVolumes: options.participantVolumes,
    participantAudioLevels: options.participantAudioLevels,
    participantIds,
  });

  const localAudioTracks = options.localParticipant?.status === 'on-stage'
    ? getLiveAudioTracks(options.localStream)
    : [];
  if (localAudioTracks.length > 0 && options.localParticipant) {
    audioSources.push({
      id: options.localParticipant.id,
      stream: new MediaStream(localAudioTracks),
      volume: programVolumes[options.localParticipant.id] ?? 1,
    });
  }

  for (const [id, participant] of options.participants) {
    if (participant.status !== 'on-stage') continue;
    const audioTracks = getLiveAudioTracks(options.remoteStreams.get(id));
    if (audioTracks.length > 0) {
      audioSources.push({
        id,
        stream: new MediaStream(audioTracks),
        volume: programVolumes[id] ?? 1,
      });
    }
  }

  const screenAudioTracks = getLiveAudioTracks(options.screenStream);
  if (screenAudioTracks.length > 0) {
    audioSources.push({ stream: new MediaStream(screenAudioTracks), volume: 1 });
  }

  const auxiliaryAudioTracks = getLiveAudioTracks(options.auxiliaryAudioStream);
  if (auxiliaryAudioTracks.length > 0) {
    audioSources.push({ stream: new MediaStream(auxiliaryAudioTracks), volume: 1 });
  }

  const sourceNodes: MediaStreamAudioSourceNode[] = [];
  const gainNodes: GainNode[] = [];
  let silentOscillator: OscillatorNode | null = null;

  for (const source of audioSources) {
    const sourceNode = audioContext.createMediaStreamSource(source.stream);
    const gainNode = audioContext.createGain();
    gainNode.gain.value = Math.min(1, Math.max(0, source.volume));
    sourceNode.connect(gainNode);
    gainNode.connect(destination);
    sourceNodes.push(sourceNode);
    gainNodes.push(gainNode);
  }

  if (audioSources.length === 0) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    oscillator.connect(gainNode);
    gainNode.connect(destination);
    oscillator.start();
    silentOscillator = oscillator;
    gainNodes.push(gainNode);
  }

  const audioTracks = destination.stream.getAudioTracks();
  const stream = new MediaStream([videoTrack, ...audioTracks]);
  let cleanedUp = false;

  return {
    id: 'program-mix',
    label: 'Program mix',
    kind: 'program',
    stream,
    bitsPerSecond: 10_000_000,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        silentOscillator?.stop();
      } catch {
        // Already stopped.
      }
      sourceNodes.forEach((node) => node.disconnect());
      gainNodes.forEach((node) => node.disconnect());
      audioTracks.forEach((track) => track.stop());
      void audioContext.close();
    },
  };
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

function getDestinationStatusMessage(status: RtmpRelayDestinationStatus, message?: string): string | undefined {
  const trimmed = message?.trim();
  if (trimmed) return trimmed.slice(0, 240);
  if (status === 'connecting') return 'Connecting to RTMP destination...';
  if (status === 'error') return 'Destination relay reported an error.';
  return undefined;
}

function getRoomActivityStatus(live: boolean, recordingStartedAt: string | null): Room['status'] {
  if (live) return 'live';
  if (recordingStartedAt) return 'recording';
  return 'waiting';
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getLiveBackupNoticeText(backup: RtmpRelayBackupRecordingPayload | null): string {
  if (!backup) return '';
  if (backup.status === 'disabled') return 'Server backup recording is disabled on this media server.';
  if (backup.status === 'recording') return 'Server backup recording is active.';
  if (backup.status === 'finalizing') return 'Server backup recording is finalizing.';
  if (backup.status === 'ready') {
    const size = formatFileSize(backup.sizeBytes);
    return `Server backup recording is ready${size ? ` (${size})` : ''}.`;
  }
  return backup.error ? `Server backup recording failed: ${backup.error}` : 'Server backup recording failed.';
}

function isPersistableLogoUrl(url: string | null): url is string {
  return Boolean(url && !url.startsWith('blob:'));
}

function getPersistableStageBackground(background: StageBackground): StageBackground {
  if ((background.type === 'image' || background.type === 'video') && background.value.startsWith('blob:')) {
    return { type: 'none', value: '' };
  }
  return background;
}

function getStageBackgroundStyle(background: StageBackground): React.CSSProperties {
  switch (background.type) {
    case 'color':
      return { background: background.value };
    case 'gradient':
      return { background: background.value };
    case 'image':
      return {
        backgroundImage: `url(${background.value})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      };
    case 'video':
      return {};
    case 'none':
    default:
      return {};
  }
}

function getWaitingRoomBackgroundStyle(
  mode: WaitingRoomBranding['backgroundMode'],
  background: StageBackground,
  brandColor: string
): React.CSSProperties {
  if (mode === 'studio') {
    const stageStyle = getStageBackgroundStyle(background);
    if (Object.keys(stageStyle).length > 0) return stageStyle;
  }

  const brandWash = /^#[\da-f]{6}$/i.test(brandColor) ? `${brandColor}66` : 'rgba(167, 139, 250, 0.4)';
  return {
    background: `radial-gradient(circle at 18% 18%, ${brandWash} 0, transparent 34%), linear-gradient(135deg, #0f172a 0%, #020617 100%)`,
  };
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

function MediaDocumentCard({ media }: { media: ActiveMedia }) {
  return (
    <div style={styles.mediaDocumentCard}>
      <div style={styles.mediaDocumentIcon}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3h20v14H2z" />
          <path d="M8 21h8" />
          <path d="M12 17v4" />
        </svg>
      </div>
      <div style={styles.mediaDocumentTitle}>{media.name}</div>
      <div style={styles.mediaDocumentType}>{media.type === 'presentation' ? 'Presentation deck' : 'Shared file'}</div>
    </div>
  );
}

function getDeckRenderFailureMessage(type: StudioMediaType, failure?: PresentationServerRenderFailure): string {
  const routing = failure?.renderRouting?.toLowerCase();
  const code = failure?.code?.toUpperCase();

  if (routing === 'no-server' || code === 'MEDIA_SERVER_NO_SERVER') {
    return 'PowerPoint formatting could not be preserved because the exact render service is not deployed. Sync the Render media-server, then upload this deck again.';
  }
  if (failure?.timedOut || code === 'PRESENTATION_RENDER_TIMEOUT') {
    return type === 'pdf'
      ? 'PDF rendering timed out. Try a smaller PDF or upload it again.'
      : 'PowerPoint rendering timed out. Try a smaller deck, or export it to PDF and upload that.';
  }
  if (code === 'PRESENTATION_TOO_LARGE') {
    return 'This presentation is too large to prepare for broadcast. Export a compressed PDF or split the deck.';
  }
  if (code === 'PRESENTATION_RENDERER_UNAVAILABLE') {
    return 'Presentation render service is missing LibreOffice or Poppler. Redeploy the Docker media-server, then upload this deck again.';
  }
  if (code === 'PRESENTATION_RENDER_UNAVAILABLE') {
    return 'PowerPoint exact render service is unreachable. Check the Render media-server, then upload this deck again.';
  }
  if (code === 'PRESENTATION_RENDER_INCOMPLETE') {
    return 'PowerPoint renderer returned a text-only preview. Redeploy the Render media-server, then upload this deck again so the original slide design is preserved.';
  }
  return type === 'pdf'
    ? 'PDF could not be rendered into broadcast slides. Try uploading it again.'
    : 'PowerPoint design could not be preserved. Try uploading again, or export the deck to PDF and upload that.';
}

function getDeckPreparationMessage(type: StudioMediaType): string {
  return type === 'pdf'
    ? 'Rendering PDF pages for broadcast...'
    : 'Rendering PowerPoint design for broadcast...';
}

function getUnavailableMediaServerPresentationFailure(
  type: StudioMediaType,
  health: ReturnType<typeof useMediaServerHealth>['health']
): PresentationServerRenderFailure | undefined {
  if (type !== 'presentation') return undefined;

  if (health.renderRouting?.toLowerCase() === 'no-server' || /not provisioned/i.test(health.message)) {
    return {
      status: health.httpStatus,
      code: 'MEDIA_SERVER_NO_SERVER',
      message: health.message,
      ...(health.renderRouting ? { renderRouting: health.renderRouting } : {}),
    };
  }

  if (health.presentationRenderer?.ready === false) {
    return {
      status: health.httpStatus,
      code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      message: health.presentationRenderer.message || health.message,
    };
  }

  if (health.status === 'unavailable') {
    return {
      status: health.httpStatus,
      code: 'PRESENTATION_RENDER_UNAVAILABLE',
      message: health.message,
      ...(health.renderRouting ? { renderRouting: health.renderRouting } : {}),
    };
  }

  return undefined;
}

function PresentationRenderMissingCard({ media }: { media: ActiveMedia }) {
  return (
    <div style={styles.presentationRenderMissingCard}>
      <div style={styles.presentationRenderMissingTitle}>
        {media.type === 'pdf' ? 'PDF render unavailable' : 'PowerPoint render unavailable'}
      </div>
      <div style={styles.presentationRenderMissingText}>
        {getDeckRenderFailureMessage(media.type)}
      </div>
    </div>
  );
}

function PresentationDeckStage({
  media,
  slideIndex,
  onSlideIndexChange,
}: {
  media: ActiveMedia;
  slideIndex: number;
  onSlideIndexChange: (index: number) => void;
}) {
  const slides = getPresentationSlides(media);
  const unitLabel = getPresentationDeckUnitLabel(slides.length > 0 && media.preview?.kind === 'presentation-slides' ? media.preview.sourceFormat : null);
  const currentIndex = clampPresentationSlideIndex(slideIndex, slides.length);
  const slide = slides[currentIndex];

  if (!slide) return <PresentationRenderMissingCard media={media} />;

  return (
    <div style={styles.presentationStage}>
      <div style={styles.presentationSlideVisualFrame}>
        <img
          src={slide.imageUrl}
          alt={`${media.name} ${unitLabel.toLowerCase()} ${currentIndex + 1}`}
          style={styles.presentationSlideImage}
        />
      </div>
      {slides.length > 1 && (
        <div style={styles.presentationControls}>
          <button
            type="button"
            style={{ ...styles.presentationControlBtn, ...(currentIndex <= 0 ? styles.presentationControlBtnDisabled : {}) }}
            disabled={currentIndex <= 0}
            onClick={() => onSlideIndexChange(currentIndex - 1)}
          >
            Prev
          </button>
          <button
            type="button"
            style={{ ...styles.presentationControlBtn, ...(currentIndex >= slides.length - 1 ? styles.presentationControlBtnDisabled : {}) }}
            disabled={currentIndex >= slides.length - 1}
            onClick={() => onSlideIndexChange(currentIndex + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function getPersistableScenes(scenes: Scene[], mediaAssets: StudioMediaAsset[] = []): Scene[] {
  const persistableMediaIds = new Set(
    mediaAssets
      .filter((asset) => asset.source === 'url')
      .map((asset) => asset.id)
  );

  return scenes.map((scene) => {
    const persistableScene: Scene = {
      ...scene,
      background: getPersistableStageBackground(scene.background),
      logoUrl: isPersistableLogoUrl(scene.logoUrl) ? scene.logoUrl : null,
      logoPosition: normalizeLogoPosition(scene.logoPosition),
      logoOpacity: normalizeLogoOpacity(scene.logoOpacity),
    };

    if ('focusedVideoItemId' in scene) {
      persistableScene.focusedVideoItemId = typeof scene.focusedVideoItemId === 'string' ? scene.focusedVideoItemId : null;
    }
    if (Array.isArray(scene.stageItemOrder)) {
      persistableScene.stageItemOrder = scene.stageItemOrder.filter((id): id is string => typeof id === 'string');
    }
    const activeMediaSnapshot = normalizeSceneActiveMediaSnapshot(scene.activeMedia);
    persistableScene.activeMedia = activeMediaSnapshot && persistableMediaIds.has(activeMediaSnapshot.assetId)
      ? activeMediaSnapshot
      : null;

    return persistableScene;
  });
}

function downloadJsonFile(fileName: string, contents: string) {
  const blob = new Blob([contents], { type: 'application/json' });
  downloadBlobFile(blob, fileName);
}

function downloadBlobFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadToolbarRecordingFallbackFiles(
  files: RecordingUploadFileInput[],
  timestamp: string
) {
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    downloadBlobFile(file.blob, file.fileName || makeToolbarRecordingFileName(file.label, file.blob, timestamp));
    if (index < files.length - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    }
  }
}

function getReadyMp4Artifact(exportJob: Awaited<ReturnType<typeof uploadRecordingToMediaServer>>['exportJob']) {
  return exportJob?.artifacts.find((artifact) => artifact.status === 'ready' && artifact.id === 'final-mp4') ||
    exportJob?.artifacts.find((artifact) => artifact.status === 'ready' && artifact.format === 'mp4') ||
    null;
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
  const { addToast } = useToast();
  const savedHostStudio = useMemo(() => (roomId ? getSavedHostStudio(roomId) : null), [roomId]);
  const urlHostToken = roomId ? getUrlHostToken() : '';
  const hostSession = useMemo(() => (roomId ? getHostSession(roomId, urlHostToken) : null), [roomId, urlHostToken]);
  const storedUserRole = getStoredParticipantRole();
  const userName = hostSession?.hostName || getStoredUserName() || savedHostStudio?.hostName || 'Anonymous';
  const roomHostToken = hostSession?.hostToken || '';
  const popoutChatSessionId = useMemo(() => (roomId ? createPopoutChatSessionId() : ''), [roomId]);
  const missingHostAccess = Boolean(roomId && !hostSession && storedUserRole === 'host');
  const userRole: 'host' | 'co-host' | 'guest' = hostSession
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
  const broadcastAudioBus = useBroadcastAudioBus();
  const [showInvitePanel, setShowInvitePanel] = useState(false);
  const [sidebarActiveTab, setSidebarActiveTab] = useState<SidebarTab | null>('people');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatTypingIndicators, setChatTypingIndicators] = useState<ChatTypingIndicator[]>([]);
  const [supportsChatTyping, setSupportsChatTyping] = useState(false);
  const [externalChatStatuses, setExternalChatStatuses] = useState<Partial<Record<ExternalChatPlatform, ExternalChatStatusPayload>>>({});
  const [guestNotification, setGuestNotification] = useState<ParticipantNotificationPayload | null>(null);

  // Layout
  const [layout, setLayout] = useState<LayoutMode>('grid');
  const layoutRef = useRef<LayoutMode>('grid');
  const [layoutTransition, setLayoutTransition] = useState<StageLayoutTransition | null>(null);

  // Lower thirds
  const [lowerThirds, setLowerThirds] = useState<LowerThirdData[]>([]);
  const [autoSpeakerLowerThirds, setAutoSpeakerLowerThirds] = useState(false);

  // Banners
  const [banners, setBanners] = useState<BannerData[]>([]);

  // Timers
  const [timers, setTimers] = useState<TimerData[]>([]);

  // Stream destinations
  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [broadcastOrientation, setBroadcastOrientation] = useState<BroadcastOrientation>('landscape');
  const [rtmpRelayOutputPreset, setRtmpRelayOutputPreset] = useState<RtmpRelayOutputPresetId>(DEFAULT_RTMP_RELAY_OUTPUT_PRESET_ID);
  const [isLive, setIsLive] = useState(false);
  const [streamScreenConfig, setStreamScreenConfig] = useState<StreamScreenConfig>(DEFAULT_STREAM_SCREEN_CONFIG);
  const [activeStreamScreenState, setActiveStreamScreenState] = useState<ActiveStreamScreenState | null>(null);
  const [liveSessionSummary, setLiveSessionSummary] = useState<LiveSessionSummary | null>(null);
  const [liveBackupRecording, setLiveBackupRecording] = useState<RtmpRelayBackupRecordingPayload | null>(null);
  const [liveBackupDownloading, setLiveBackupDownloading] = useState(false);

  // Room ending countdown — driven by server-issued absolute end time.
  const [roomEnding, setRoomEnding] = useState(false);
  const [roomEndsAt, setRoomEndsAt] = useState<number | null>(null);
  const [endingCountdown, setEndingCountdown] = useState(10);
  const [liveStartedAt, setLiveStartedAt] = useState<string | null>(null);
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [sessionRecordingStartedAt, setSessionRecordingStartedAt] = useState<string | null>(null);
  const [sessionRecordingSessionId, setSessionRecordingSessionId] = useState<string | null>(null);
  const [sessionRecordingPaused, setSessionRecordingPaused] = useState(false);
  const [supportsCoordinatedRecording, setSupportsCoordinatedRecording] = useState(false);
  const [participantRecordingFinalizing, setParticipantRecordingFinalizing] = useState(false);
  const [sessionRecordingElapsed, setSessionRecordingElapsed] = useState(0);

  // Media overlay
  const [activeMedia, setActiveMedia] = useState<ActiveMedia | null>(null);
  const [activeMediaSlideIndex, setActiveMediaSlideIndex] = useState(0);
  const [mediaAssets, setMediaAssets] = useState<StudioMediaAsset[]>([]);

  useEffect(() => {
    const slideCount = getPresentationSlides(activeMedia).length;
    if (slideCount <= 1) return;

    const handlePresentationKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTextEntryTarget(event.target)) return;
      const direction = event.key === 'ArrowLeft' || event.key === 'PageUp'
        ? 'previous'
        : event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' '
          ? 'next'
          : null;
      if (!direction) return;

      event.preventDefault();
      setActiveMediaSlideIndex((current) => getNextPresentationSlideIndex(current, slideCount, direction));
    };

    window.addEventListener('keydown', handlePresentationKeyDown);
    return () => window.removeEventListener('keydown', handlePresentationKeyDown);
  }, [activeMedia]);

  const [stageBackground, setStageBackground] = useState<StageBackground>({ type: 'none', value: '' });
  const [studioTheme, setStudioTheme] = useState<StudioThemeId>(DEFAULT_STUDIO_THEME_ID);
  const [brandColor, setBrandColor] = useState('#a78bfa');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [waitingRoomBranding, setWaitingRoomBranding] = useState<WaitingRoomBranding>(DEFAULT_WAITING_ROOM_BRANDING);
  const [remoteStudioBranding, setRemoteStudioBranding] = useState<StudioBrandingPayload | null>(null);
  const [logoPlacement, setLogoPlacement] = useState<LogoPlacement>('top-right');
  const [logoPosition, setLogoPosition] = useState<LogoPosition | null>(null);
  const [logoSize, setLogoSize] = useState<LogoSize>('medium');
  const [logoOpacity, setLogoOpacity] = useState(DEFAULT_LOGO_OPACITY);
  const [cameraShape, setCameraShape] = useState<CameraShape>('rectangle');
  const [nameTagStyle, setNameTagStyle] = useState<NameTagStyle>('classic');
  const [pipCorner, setPipCorner] = useState<'TL' | 'TR' | 'BL' | 'BR'>('BR');
  const [focusedVideoItemId, setFocusedVideoItemId] = useState<string | null>(null);
  const [stageItemOrder, setStageItemOrder] = useState<string[]>([]);
  const [draggedStageItemId, setDraggedStageItemId] = useState<string | null>(null);
  const [stageDropTargetId, setStageDropTargetId] = useState<string | null>(null);
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>({});
  const [audioDuckingEnabled, setAudioDuckingEnabled] = useState(false);
  const [stageAudioLevels, setStageAudioLevels] = useState<Record<string, number>>({});
  const [recordingMarkers, setRecordingMarkers] = useState<RecordingMarker[]>([]);

  useEffect(() => {
    const previousTheme = document.body.dataset.studioTheme;
    document.body.dataset.studioTheme = studioTheme;
    return () => {
      if (previousTheme) {
        document.body.dataset.studioTheme = previousTheme;
      } else {
        delete document.body.dataset.studioTheme;
      }
    };
  }, [studioTheme]);

  useEffect(() => {
    const variables = buildBrandThemeVariables(brandColor, studioTheme);
    const previousValues = variables.map(([property]) => [
      property,
      document.body.style.getPropertyValue(property),
    ] as const);

    variables.forEach(([property, value]) => {
      document.body.style.setProperty(property, value);
    });

    return () => {
      previousValues.forEach(([property, value]) => {
        if (value) {
          document.body.style.setProperty(property, value);
        } else {
          document.body.style.removeProperty(property);
        }
      });
    };
  }, [brandColor, studioTheme]);

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
  const [sceneTransitionPreset, setSceneTransitionPreset] = useState<SceneTransitionPresetId>(DEFAULT_SCENE_TRANSITION_PRESET_ID);
  const [sceneStingerClip, setSceneStingerClip] = useState<SceneStingerClip | null>(null);
  const [sceneTransition, setSceneTransition] = useState<SceneTransitionState | null>(null);
  const [scenePackMessage, setScenePackMessage] = useState<string | null>(null);

  useEffect(() => {
    const clip = sceneStingerClip;
    return () => {
      if (clip?.source === 'upload' && clip.url.startsWith('blob:')) URL.revokeObjectURL(clip.url);
    };
  }, [sceneStingerClip]);

  // Comment highlighting
  const [highlightedComment, setHighlightedComment] = useState<HighlightedComment | null>(null);

  // Tickers
  const [tickers, setTickers] = useState<TickerData[]>([]);
  const [widgets, setWidgets] = useState<WidgetOverlayData[]>([]);

  // Webinar Q&A
  const [qaQuestions, setQAQuestions] = useState<QAQuestion[]>([]);
  const [myUpvotes, setMyUpvotes] = useState<Set<string>>(new Set());
  const [polls, setPolls] = useState<LivePoll[]>([]);
  const [myPollVotes, setMyPollVotes] = useState<Record<string, string>>({});
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionLanguage, setCaptionLanguage] = useState('en-US');

  // Hooks
  const { connect, disconnect, send, addHandler, connected, reconnectFailed, retry: retryConnection } = useSignaling();
  const {
    localStream: rawLocalStream, audioEnabled, videoEnabled,
    error: mediaError,
    startMedia, stopMedia, setAudioTrackEnabled, setVideoTrackEnabled, toggleAudio, toggleVideo,
    switchAudioDevice, switchVideoDevice,
    audioDevices, videoDevices, audioOutputDevices,
    selectedAudioDeviceId, selectedVideoDeviceId,
    selectedAudioOutputDeviceId,
    audioProcessing,
    videoQuality,
    recommendedVideoQuality,
    updateAudioProcessing,
    updateVideoQuality,
    onAudioOutputDeviceChange,
  } = useMediaDevices();

  // Virtual webcam background (Zoom-style). Off by default; persists across sessions.
  const [vbConfig, setVbConfig] = useState<VirtualBackgroundConfig>(() => {
    try {
      return parseVirtualBackgroundConfig(localStorage.getItem(VIRTUAL_BACKGROUND_STORAGE_KEY));
    } catch {
      return { mode: 'off' };
    }
  });
  const onVirtualBackgroundChange = useCallback((next: VirtualBackgroundConfig) => {
    setVbConfig(normalizeVirtualBackgroundConfig(next));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(VIRTUAL_BACKGROUND_STORAGE_KEY, serializeVirtualBackgroundConfig(vbConfig));
    } catch {
      // ignore quota errors
    }
  }, [vbConfig]);

  const { outputStream: localStream, ready: vbReady, error: vbError } = useVirtualBackground({
    inputStream: rawLocalStream,
    config: vbConfig,
  });

  const [sfuRemoteStreams, setSfuRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [sfuTransportStatus, setSfuTransportStatus] = useState<SfuTransportStatus>('idle');
  const [sfuReconnectNonce, setSfuReconnectNonce] = useState(0);
  const sfuSessionRef = useRef<SfuSocketSession | null>(null);

  const {
    remoteStreams: meshRemoteStreams,
    peerBandwidthHealth,
    connectToPeer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    removePeer,
    replaceTrack,
    setAudioForwardingEnabled,
    setVideoForwardingEnabled,
    cleanup,
  } = useWebRTC({
    localStream,
    myParticipantId: myParticipant?.id || null,
    send,
  });

  const remoteStreams = useMemo(() => (
    sfuTransportStatus === 'active'
      ? mergeSfuMediaWithMeshFallback(meshRemoteStreams, sfuRemoteStreams)
      : meshRemoteStreams
  ), [meshRemoteStreams, sfuRemoteStreams, sfuTransportStatus]);

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

  const {
    isRecording,
    isPaused: isRecordingPaused,
    formattedTime,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
  } = useRecording();
  const { screenStream, isScreenSharing, startScreenShare, stopScreenShare } = useScreenShare();
  const {
    isRecording: isLocalRecording,
    isPaused: isLocalRecordingPaused,
    formattedTime: localRecFormattedTime,
    recordingLabels: localRecordingLabels,
    startRecording: startLocalRecording,
    pauseRecording: pauseLocalRecording,
    resumeRecording: resumeLocalRecording,
    stopRecording: stopLocalRecording,
    cancelRecording: cancelLocalRecording,
  } = useLocalRecording();
  const {
    isRecording: isParticipantLocalRecording,
    isPaused: isParticipantLocalRecordingPaused,
    startRecording: startParticipantLocalRecording,
    pauseRecording: pauseParticipantLocalRecording,
    resumeRecording: resumeParticipantLocalRecording,
    stopRecording: stopParticipantLocalRecording,
  } = useLocalRecording();

  const effectiveAudioEnabled = audioEnabled && Boolean(localStream?.getAudioTracks()[0]?.enabled);
  const effectiveVideoEnabled = videoEnabled && Boolean(localStream?.getVideoTracks()[0]?.enabled);
  const isHostOrCoHost = isStudioOperator(myParticipant);
  const canUseOperatorControls = canUseAdmittedOperatorControls(myParticipant);
  const canControlRecording = canControlStudioRecording(myParticipant);
  const captionsAllowed = canUseOperatorControls;
  const sessionPeerConnectionParticipants = useMemo<SessionPeerHealthParticipant[]>(() => (
    Array.from(participants.entries()).map(([id, participant]) => ({
      id,
      name: participant.name,
      status: participant.status,
      health: peerBandwidthHealth.get(id) || null,
    }))
  ), [participants, peerBandwidthHealth]);
  const { health: mediaServerHealth, refresh: refreshMediaServerHealth } = useMediaServerHealth();
  const sessionHealth = useSessionHealth({
    localStream,
    connected,
    mediaError,
    audioDeviceCount: audioDevices.length,
    videoDeviceCount: videoDevices.length,
    participantCount: participants.size + (myParticipant ? 1 : 0),
    peerConnectionParticipants: sessionPeerConnectionParticipants,
    mediaServerHealth,
    isRecording: isRecording || isLocalRecording || Boolean(sessionRecordingStartedAt),
    isLive,
  });
  const meshCapacity = useMemo(() => {
    const onStageRemote = sessionPeerConnectionParticipants.filter(
      (participant) => participant.status === 'on-stage' || participant.status === 'backstage'
    );
    const onStageCount = onStageRemote.length + (myParticipant ? 1 : 0);
    let uplinkKbps: number | null = null;
    for (const participant of onStageRemote) {
      const available = participant.health?.availableOutgoingBitrateKbps;
      if (typeof available === 'number' && Number.isFinite(available)) {
        uplinkKbps = Math.max(uplinkKbps ?? 0, available);
      }
    }
    return planMeshCapacity({ participantCount: onStageCount, uplinkKbps });
  }, [myParticipant, sessionPeerConnectionParticipants]);
  const shouldConnectSfuMedia = useMemo(() => shouldUseSfuMedia({
    localParticipant: myParticipant,
    remoteParticipants: participants.values(),
    mediaServerReady: mediaServerHealth.status === 'ready',
  }), [mediaServerHealth.status, myParticipant, participants]);
  const recordingReadiness = useMemo(() => {
    const liveTracks = (tracks: MediaStreamTrack[] | undefined) => (
      (tracks || []).filter((track) => track.readyState === 'live')
    );
    const readinessParticipants: RecordingParticipantReadiness[] = [];

    if (myParticipant) {
      const localAudioTracks = liveTracks(localStream?.getAudioTracks());
      const localVideoTracks = liveTracks(localStream?.getVideoTracks());
      readinessParticipants.push({
        id: myParticipant.id,
        name: myParticipant.name,
        status: myParticipant.status,
        isLocal: true,
        hasStream: Boolean(localStream),
        hasAudio: localAudioTracks.length > 0,
        hasVideo: localVideoTracks.length > 0,
        screenSharing: isScreenSharing,
      });
    }

    for (const [id, participant] of participants) {
      const remoteStream = remoteStreams.get(id) || null;
      const remoteAudioTracks = liveTracks(remoteStream?.getAudioTracks());
      const remoteVideoTracks = liveTracks(remoteStream?.getVideoTracks());
      readinessParticipants.push({
        id,
        name: participant.name,
        status: participant.status,
        hasStream: Boolean(remoteStream),
        hasAudio: remoteAudioTracks.length > 0,
        hasVideo: remoteVideoTracks.length > 0,
        screenSharing: participant.screenSharing,
      });
    }

    return buildRecordingReadinessSummary({
      participants: readinessParticipants,
      screen: {
        active: isScreenSharing,
        hasVideo: liveTracks(screenStream?.getVideoTracks()).length > 0,
        hasAudio: liveTracks(screenStream?.getAudioTracks()).length > 0,
      },
      mediaRecorderSupported: typeof MediaRecorder !== 'undefined',
      encodingReadiness: sessionHealth.encoding,
      persistentStorageSupported: typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory),
      captionsEnabled: captionsAllowed && captionsEnabled,
      markerCount: recordingMarkers.length,
    });
  }, [
    captionsAllowed,
    captionsEnabled,
    isScreenSharing,
    localStream,
    myParticipant,
    participants,
    recordingMarkers.length,
    remoteStreams,
    screenStream,
    sessionHealth.encoding,
  ]);
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
  const activeStreamScreen = useMemo(() => {
    if (!activeStreamScreenState) return null;
    return buildActiveStreamScreen(
      activeStreamScreenState.kind,
      streamScreenConfig,
      { brandColor, logoUrl, stageBackground },
      activeStreamScreenState.activatedAtMs
    );
  }, [activeStreamScreenState, brandColor, logoUrl, stageBackground, streamScreenConfig]);
  const activeStreamScreenBackgroundStyle = useMemo(() => (
    activeStreamScreen ? getStageBackgroundStyle(activeStreamScreen.background) : {}
  ), [activeStreamScreen]);
  const onStreamScreenConfigChange = useCallback((next: StreamScreenConfig) => {
    setStreamScreenConfig(normalizeStreamScreenConfig(next));
  }, []);
  const onApplyStreamScreen = useCallback((kind: StreamScreenKind) => {
    setActiveStreamScreenState({ kind, activatedAtMs: Date.now() });
  }, []);
  const onClearStreamScreen = useCallback(() => {
    setActiveStreamScreenState(null);
  }, []);

  useEffect(() => {
    if (!roomId || !hostSession) return;
    if (hostSession.source === 'legacy') {
      persistLegacyHostSession({ roomId, hostName: hostSession.hostName });
      return;
    }
    persistHostSession({ roomId, hostName: hostSession.hostName, hostToken: hostSession.hostToken });
    if (hostSession.source === 'url') {
      clearUrlHostToken();
    }
  }, [roomId, hostSession?.hostName, hostSession?.hostToken, hostSession?.source]);

  const joinedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const myParticipantRef = useRef<Participant | null>(null);
  const mediaAssetsRef = useRef<StudioMediaAsset[]>(mediaAssets);
  const idCounters = useRef({ lt: 0, dest: 0, banner: 0, timer: 0, ticker: 0, widget: 0, qa: 0, poll: 0, media: 0 });
  const liveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveTokenRequestsRef = useRef<Map<string, PendingLiveTokenRequest>>(new Map());
  const recordingUploadTokenRequestsRef = useRef<Map<string, PendingRecordingUploadTokenRequest>>(new Map());
  const sfuTokenRequestsRef = useRef<Map<string, PendingLiveTokenRequest>>(new Map());
  const recordingUploadTokenRef = useRef<{ sessionId: string; token: string } | null>(null);
  const expectedDistributedUploadsRef = useRef(1);
  const guestInviteRequestsRef = useRef<Map<string, PendingGuestInviteRequest>>(new Map());
  const coHostInviteRequestsRef = useRef<Map<string, PendingCoHostInviteRequest>>(new Map());
  const popoutChatChannelRef = useRef<BroadcastChannel | null>(null);
  const popoutChatStateRef = useRef<PopoutChatState | null>(null);
  const chatTypingExpiryTimerRef = useRef<number | null>(null);
  const bannerAutoDismissTimersRef = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; durationSeconds: number }>>(new Map());
  const lowerThirdAutoDismissTimersRef = useRef<Map<string, { timer: ReturnType<typeof setTimeout>; durationSeconds: number }>>(new Map());
  const sceneTransitionTimerRef = useRef<number | null>(null);
  const sceneTransitionFrameRef = useRef<number | null>(null);
  const layoutTransitionSequenceRef = useRef(0);
  const layoutTransitionTimerRef = useRef<number | null>(null);
  const layoutTransitionFrameRef = useRef<number | null>(null);
  const lastAutoSpeakerLowerThirdRef = useRef<{ participantId: string; shownAt: number } | null>(null);
  const studioStateLoadedRef = useRef(false);
  const audioEnabledRef = useRef(audioEnabled);
  const videoEnabledRef = useRef(videoEnabled);
  const isScreenSharingRef = useRef(isScreenSharing);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const isLiveRef = useRef(isLive);
  const liveStartedAtRef = useRef<string | null>(liveStartedAt);
  const destinationsRef = useRef<StreamDestination[]>(destinations);
  const sessionRecordingStartedAtRef = useRef<string | null>(sessionRecordingStartedAt);
  const publishedTrackIdsRef = useRef<{ audio?: string; video?: string }>({});
  const publishedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const reactionSequenceRef = useRef(0);

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
  const publishedScreenShareCleanupRef = useRef<(() => void) | null>(null);
  const stopPublishedScreenShareRef = useRef<() => void>(() => {
    publishedScreenShareCleanupRef.current?.();
    publishedScreenShareCleanupRef.current = null;
    stopScreenShare();
  });
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
    widgets,
    activeMedia,
    activeMediaSlideIndex,
    highlightedComment,
    highlightedQA: qaQuestions.find((question) => question.highlighted) || null,
    highlightedPoll: polls.find((poll) => poll.highlighted) || null,
    floatingReactions,
    caption: broadcastCaption,
    stageBackground,
    brandColor,
    logoUrl,
    logoPlacement,
    logoPosition,
    logoSize,
    logoOpacity,
    streamScreen: activeStreamScreen,
  });

  const handleLogoPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!canUseOperatorControls || !stageRef.current) return;
    event.preventDefault();
    event.stopPropagation();

    const updateLogoPosition = (clientX: number, clientY: number) => {
      const nextPosition = stageRef.current
        ? getLogoPositionFromPointer(clientX, clientY, stageRef.current.getBoundingClientRect())
        : null;
      if (nextPosition) setLogoPosition(nextPosition);
    };

    updateLogoPosition(event.clientX, event.clientY);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      updateLogoPosition(moveEvent.clientX, moveEvent.clientY);
    };
    const cleanupPointerListeners = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', cleanupPointerListeners);
      window.removeEventListener('pointercancel', cleanupPointerListeners);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', cleanupPointerListeners, { once: true });
    window.addEventListener('pointercancel', cleanupPointerListeners, { once: true });
  }, [canUseOperatorControls]);

  const handleRelayDestinationStatus = useCallback((destinationId: string, status: RtmpRelayDestinationStatus, message?: string) => {
    setDestinations((prev) => prev.map((destination) => (
      destination.id === destinationId
        ? { ...destination, status, statusMessage: getDestinationStatusMessage(status, message) }
        : destination
    )));
  }, []);

  const showLiveSessionSummary = useCallback((
    startedAt: string | null,
    destinationSnapshot: StreamDestination[],
    options: { stoppedAt?: string; relayError?: boolean } = {},
  ) => {
    const enabledDestinations = destinationSnapshot.filter((destination) => destination.enabled);
    const statusErrorCount = enabledDestinations.filter((destination) => destination.status === 'error').length;
    const errorCount = options.relayError && enabledDestinations.length > 0
      ? Math.max(1, statusErrorCount)
      : statusErrorCount;
    setLiveSessionSummary(buildLiveSessionSummary({
      startedAt,
      stoppedAt: options.stoppedAt,
      destinationCount: enabledDestinations.length,
      errorCount,
      relayError: options.relayError,
      destinations: enabledDestinations,
    }));
  }, []);

  const handleRelayStopped = useCallback((message: string) => {
    const statusMessage = message.trim() || 'Media relay stopped unexpectedly.';
    const previousLiveStartedAt = liveStartedAtRef.current;
    showLiveSessionSummary(previousLiveStartedAt, destinationsRef.current, {
      stoppedAt: new Date().toISOString(),
      relayError: true,
    });
    isLiveRef.current = false;
    liveStartedAtRef.current = null;
    setIsLive(false);
    setLiveStartedAt(null);
    setActiveStreamScreenState(null);
    setRoom((prev) => prev ? { ...prev, status: getRoomActivityStatus(false, sessionRecordingStartedAtRef.current) } : prev);
    send({
      type: 'live-stream-state-changed',
      payload: {
        live: false,
        performedBy: myParticipantRef.current?.id || '',
      },
    });
    setDestinations((prev) => prev.map((destination) => (
      destination.enabled
        ? { ...destination, status: 'error', statusMessage }
        : { ...destination, status: 'idle', statusMessage: undefined }
    )));
  }, [send, showLiveSessionSummary]);

  const {
    startRelay,
    stopRelay,
    stats: relayStats,
    readiness: relayReadiness,
    backupRecording: relayBackupRecording,
    checkRelayReadiness,
  } = useRtmpRelay({
    compositeStreamRef,
    localStream,
    localParticipantId: myParticipant?.id || null,
    remoteStreams: broadcastRemoteStreams,
    screenStream,
    auxiliaryAudioStream: broadcastAudioBus.stream,
    ensureAuxiliaryAudioStream: broadcastAudioBus.ensureStream,
    participantVolumes,
    participantAudioLevels: stageAudioLevels,
    audioDuckingEnabled,
    readinessEnabled: canUseOperatorControls,
    onDestinationStatus: handleRelayDestinationStatus,
    onRelayStopped: handleRelayStopped,
  });

  useEffect(() => {
    if (relayBackupRecording) setLiveBackupRecording(relayBackupRecording);
  }, [relayBackupRecording]);

  const localStudioBrandingPayload = useMemo(() => buildStudioBrandingPayload({
    brandColor,
    logoUrl,
    stageBackground,
    waitingRoom: waitingRoomBranding,
    updatedBy: myParticipant?.id,
  }), [brandColor, logoUrl, myParticipant?.id, stageBackground, waitingRoomBranding]);

  useEffect(() => {
    if (!connected || !joined || !canUseOperatorControls || myParticipant?.role !== 'host') return;
    const timeout = window.setTimeout(() => {
      send({
        type: 'studio-branding-updated',
        payload: localStudioBrandingPayload,
      });
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [canUseOperatorControls, connected, joined, localStudioBrandingPayload, myParticipant?.role, send]);

  const handleParticipantVolumeChange = useCallback((participantId: string, volume: number) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
    setParticipantVolumes((current) => {
      if (current[participantId] === clamped) return current;
      return { ...current, [participantId]: clamped };
    });
  }, []);

  const handleStageAudioLevelChange = useCallback((participantId: string, level: number) => {
    const rounded = Math.max(0, Math.min(100, Math.round(Number.isFinite(level) ? level : 0)));
    setStageAudioLevels((current) => {
      if (current[participantId] === rounded) return current;
      return { ...current, [participantId]: rounded };
    });
  }, []);

  const handleSceneStingerClipChange = useCallback((clip: SceneStingerClip | null) => {
    setSceneStingerClip((current) => {
      if (current?.source === 'upload' && current.url.startsWith('blob:') && current.url !== clip?.url) {
        URL.revokeObjectURL(current.url);
      }
      return clip;
    });
  }, []);

  const clearLayoutTransitionTimers = useCallback(() => {
    if (layoutTransitionTimerRef.current !== null) {
      window.clearTimeout(layoutTransitionTimerRef.current);
      layoutTransitionTimerRef.current = null;
    }
    if (layoutTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutTransitionFrameRef.current);
      layoutTransitionFrameRef.current = null;
    }
  }, []);

  const startLayoutTransition = useCallback((from: LayoutMode, to: LayoutMode) => {
    if (!shouldStartLayoutTransition(from, to)) return;

    clearLayoutTransitionTimers();
    const id = ++layoutTransitionSequenceRef.current;
    setLayoutTransition({ id, from, to, visible: false });
    layoutTransitionFrameRef.current = window.requestAnimationFrame(() => {
      layoutTransitionFrameRef.current = window.requestAnimationFrame(() => {
        setLayoutTransition((current) => (
          current?.id === id ? { ...current, visible: true } : current
        ));
        layoutTransitionFrameRef.current = null;
      });
    });
    layoutTransitionTimerRef.current = window.setTimeout(() => {
      setLayoutTransition((current) => (current?.id === id ? null : current));
      layoutTransitionTimerRef.current = null;
    }, LAYOUT_SWITCH_TRANSITION_DURATION_MS);
  }, [clearLayoutTransitionTimers]);

  const applyLayout = useCallback((nextLayout: LayoutMode, options: { animate?: boolean } = {}) => {
    const currentLayout = layoutRef.current;
    if (currentLayout === nextLayout) return;
    if (options.animate !== false) startLayoutTransition(currentLayout, nextLayout);
    layoutRef.current = nextLayout;
    setLayout(nextLayout);
  }, [startLayoutTransition]);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const triggerSceneTransition = useCallback((scene: Pick<Scene, 'id' | 'name'>) => {
    if (sceneTransitionTimerRef.current !== null) {
      window.clearTimeout(sceneTransitionTimerRef.current);
      sceneTransitionTimerRef.current = null;
    }
    if (sceneTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(sceneTransitionFrameRef.current);
      sceneTransitionFrameRef.current = null;
    }

    const presetId = sceneTransitionPreset;
    const durationMs = presetId === 'stinger' ? STINGER_TRANSITION_DURATION_MS : SCENE_TRANSITION_DURATION_MS;
    const stingerClip = presetId === 'stinger' ? sceneStingerClip : null;
    setSceneTransition({ sceneId: scene.id, sceneName: scene.name, presetId, visible: true, durationMs, stingerClip });
    if (presetId !== 'stinger') {
      sceneTransitionFrameRef.current = window.requestAnimationFrame(() => {
        sceneTransitionFrameRef.current = window.requestAnimationFrame(() => {
          setSceneTransition((current) => (
            current?.sceneId === scene.id ? { ...current, visible: false } : current
          ));
          sceneTransitionFrameRef.current = null;
        });
      });
    }
    sceneTransitionTimerRef.current = window.setTimeout(() => {
      setSceneTransition((current) => (current?.sceneId === scene.id ? null : current));
      sceneTransitionTimerRef.current = null;
    }, durationMs);
  }, [sceneStingerClip, sceneTransitionPreset]);

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
      if (sceneTransitionTimerRef.current !== null) window.clearTimeout(sceneTransitionTimerRef.current);
      if (sceneTransitionFrameRef.current !== null) window.cancelAnimationFrame(sceneTransitionFrameRef.current);
      if (layoutTransitionTimerRef.current !== null) window.clearTimeout(layoutTransitionTimerRef.current);
      if (layoutTransitionFrameRef.current !== null) window.cancelAnimationFrame(layoutTransitionFrameRef.current);
      if (chatTypingExpiryTimerRef.current !== null) window.clearTimeout(chatTypingExpiryTimerRef.current);
      for (const request of liveTokenRequestsRef.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Studio closed before live stream authorization completed.'));
      }
      liveTokenRequestsRef.current.clear();
      for (const request of recordingUploadTokenRequestsRef.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Studio closed before recording upload authorization completed.'));
      }
      recordingUploadTokenRequestsRef.current.clear();
      for (const request of sfuTokenRequestsRef.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Studio closed before SFU authorization completed.'));
      }
      sfuTokenRequestsRef.current.clear();
      for (const request of guestInviteRequestsRef.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Studio closed before guest invite authorization completed.'));
      }
      guestInviteRequestsRef.current.clear();
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
          if (parsed.layout) applyLayout(parsed.layout, { animate: false });
          setStudioTheme(normalizeStudioThemeId(parsed.studioTheme));
          if (parsed.stageBackground) setStageBackground(parsed.stageBackground);
          if (parsed.brandColor) setBrandColor(parsed.brandColor);
          if (parsed.logoUrl !== undefined) setLogoUrl(parsed.logoUrl);
          if (parsed.waitingRoomBranding) setWaitingRoomBranding(normalizeWaitingRoomBranding(parsed.waitingRoomBranding));
          if (parsed.streamScreens) setStreamScreenConfig(normalizeStreamScreenConfig(parsed.streamScreens));
          if (parsed.logoPlacement) setLogoPlacement(parsed.logoPlacement);
          setLogoPosition(normalizeLogoPosition(parsed.logoPosition));
          if (parsed.logoSize) setLogoSize(parsed.logoSize);
          setLogoOpacity(normalizeLogoOpacity(parsed.logoOpacity));
          if (parsed.cameraShape) setCameraShape(parsed.cameraShape);
          if (parsed.nameTagStyle) setNameTagStyle(parsed.nameTagStyle);
          if (parsed.pipCorner) setPipCorner(parsed.pipCorner);
          if (Array.isArray(parsed.stageItemOrder)) setStageItemOrder(parsed.stageItemOrder.filter((id): id is string => typeof id === 'string'));
          if (Array.isArray(parsed.mediaAssets)) setMediaAssets(parsed.mediaAssets.filter((asset) => asset.source === 'url'));
          if (Array.isArray(parsed.scenes)) {
            setScenes(parsed.scenes);
            setActiveSceneId(parsed.activeSceneId && parsed.scenes.some((scene) => scene.id === parsed.activeSceneId) ? parsed.activeSceneId : null);
          }
          setSceneTransitionPreset(normalizeSceneTransitionPresetId(parsed.sceneTransitionPreset));
          handleSceneStingerClipChange(normalizeSceneStingerClip(parsed.sceneStingerClip));
          if (Array.isArray(parsed.lowerThirds)) setLowerThirds(parsed.lowerThirds);
          if (typeof parsed.autoSpeakerLowerThirds === 'boolean') setAutoSpeakerLowerThirds(parsed.autoSpeakerLowerThirds);
          if (typeof parsed.audioDuckingEnabled === 'boolean') setAudioDuckingEnabled(parsed.audioDuckingEnabled);
          if (Array.isArray(parsed.banners)) setBanners(parsed.banners);
          if (Array.isArray(parsed.timers)) setTimers(parsed.timers.map((timer) => ({ ...timer, isRunning: false })));
          if (Array.isArray(parsed.tickers)) setTickers(parsed.tickers);
          if (Array.isArray(parsed.widgets)) setWidgets(parsed.widgets);
          idCounters.current = {
            ...idCounters.current,
            lt: getMaxNumericSuffix(parsed.lowerThirds, 'lt'),
            banner: getMaxNumericSuffix(parsed.banners, 'banner'),
            timer: getMaxNumericSuffix(parsed.timers, 'timer'),
            ticker: getMaxNumericSuffix(parsed.tickers, 'ticker'),
            widget: getMaxNumericSuffix(parsed.widgets, 'widget'),
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
  }, [applyLayout, handleSceneStingerClipChange, roomId]);

  // Persist room setup locally without storing stream keys or transient media state.
  useEffect(() => {
    if (!roomId || !studioStateLoadedRef.current) return;
    const timeout = setTimeout(() => {
      const state: PersistedStudioState = {
        version: STUDIO_STATE_VERSION,
        layout,
        studioTheme,
        stageBackground: getPersistableStageBackground(stageBackground),
        brandColor,
        logoUrl: isPersistableLogoUrl(logoUrl) ? logoUrl : null,
        waitingRoomBranding: normalizeWaitingRoomBranding(waitingRoomBranding),
        streamScreens: normalizeStreamScreenConfig(streamScreenConfig),
        logoPlacement,
        logoPosition: normalizeLogoPosition(logoPosition),
        logoSize,
        logoOpacity,
        cameraShape,
        nameTagStyle,
        pipCorner,
        stageItemOrder,
        mediaAssets: mediaAssets.filter((asset) => asset.source === 'url'),
        scenes: getPersistableScenes(scenes, mediaAssets),
        activeSceneId: activeSceneId && scenes.some((scene) => scene.id === activeSceneId) ? activeSceneId : null,
        sceneTransitionPreset,
        sceneStingerClip: isPersistableSceneStingerClip(sceneStingerClip) ? sceneStingerClip : null,
        lowerThirds: lowerThirds.filter((lowerThird) => lowerThird.source !== 'auto-speaker'),
        autoSpeakerLowerThirds,
        audioDuckingEnabled,
        banners,
        timers: timers.map((timer) => ({ ...timer, isRunning: false })),
        tickers,
        widgets,
      };

      try {
        localStorage.setItem(getStudioStateKey(roomId), JSON.stringify(state));
      } catch (err) {
        console.warn('Failed to persist studio state:', err);
      }
    }, 250);

    return () => clearTimeout(timeout);
  }, [roomId, layout, studioTheme, stageBackground, brandColor, logoUrl, waitingRoomBranding, streamScreenConfig, logoPlacement, logoPosition, logoSize, logoOpacity, cameraShape, nameTagStyle, pipCorner, stageItemOrder, mediaAssets, scenes, activeSceneId, sceneTransitionPreset, sceneStingerClip, lowerThirds, autoSpeakerLowerThirds, audioDuckingEnabled, banners, timers, tickers, widgets]);

  // Keep refs in sync with state
  useEffect(() => {
    myParticipantRef.current = myParticipant;
  }, [myParticipant]);
  useEffect(() => { audioEnabledRef.current = effectiveAudioEnabled; }, [effectiveAudioEnabled]);
  useEffect(() => { videoEnabledRef.current = effectiveVideoEnabled; }, [effectiveVideoEnabled]);
  useEffect(() => { isScreenSharingRef.current = isScreenSharing; }, [isScreenSharing]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);
  useEffect(() => { liveStartedAtRef.current = liveStartedAt; }, [liveStartedAt]);
  useEffect(() => { destinationsRef.current = destinations; }, [destinations]);
  useEffect(() => { sessionRecordingStartedAtRef.current = sessionRecordingStartedAt; }, [sessionRecordingStartedAt]);

  useEffect(() => {
    if (canControlRecording || !isLocalRecording) return;
    setShowRecordingPanel(false);
    void stopLocalRecording().catch((err) => console.error('Failed to stop local recording after access changed:', err));
  }, [canControlRecording, isLocalRecording, stopLocalRecording]);

  // Keep function refs in sync
  useEffect(() => { connectToPeerRef.current = connectToPeer; }, [connectToPeer]);

  useEffect(() => () => {
    bannerAutoDismissTimersRef.current.forEach(({ timer }) => clearTimeout(timer));
    bannerAutoDismissTimersRef.current.clear();
    lowerThirdAutoDismissTimersRef.current.forEach(({ timer }) => clearTimeout(timer));
    lowerThirdAutoDismissTimersRef.current.clear();
  }, []);

  useEffect(() => {
    const autoDismissTimers = lowerThirdAutoDismissTimersRef.current;
    const activeTimedLowerThirdIds = new Set<string>();

    lowerThirds.forEach((lowerThird) => {
      const normalizedDuration = normalizeLowerThirdDurationSeconds(lowerThird.durationSeconds);
      if (!lowerThird.visible || normalizedDuration === null) return;

      activeTimedLowerThirdIds.add(lowerThird.id);
      const existing = autoDismissTimers.get(lowerThird.id);
      if (existing?.durationSeconds === normalizedDuration) return;

      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        autoDismissTimers.delete(lowerThird.id);
        setLowerThirds((prev) => prev.map((item) => (
          item.id === lowerThird.id && item.visible ? { ...item, visible: false } : item
        )));
      }, normalizedDuration * 1000);

      autoDismissTimers.set(lowerThird.id, { timer, durationSeconds: normalizedDuration });
    });

    autoDismissTimers.forEach(({ timer }, lowerThirdId) => {
      if (activeTimedLowerThirdIds.has(lowerThirdId)) return;
      clearTimeout(timer);
      autoDismissTimers.delete(lowerThirdId);
    });
  }, [lowerThirds]);

  useEffect(() => {
    if (!autoSpeakerLowerThirds || !isHostOrCoHost || myParticipant?.status === 'green-room') return;
    if (lowerThirds.some((lowerThird) => lowerThird.visible && lowerThird.source !== 'auto-speaker')) return;

    const candidates: AutoSpeakerLowerThirdCandidate[] = [];
    if (myParticipant) {
      candidates.push({
        participantId: myParticipant.id,
        name: myParticipant.name,
        title: getParticipantLowerThirdTitle(myParticipant.role),
        audioLevel: stageAudioLevels[myParticipant.id] || 0,
        eligible: myParticipant.status === 'on-stage' && effectiveAudioEnabled,
      });
    }

    participants.forEach((participant, participantId) => {
      candidates.push({
        participantId,
        name: participant.name,
        title: getParticipantLowerThirdTitle(participant.role),
        audioLevel: stageAudioLevels[participantId] || 0,
        eligible: participant.status === 'on-stage' && participant.audioEnabled && !participant.screenSharing,
      });
    });

    const speaker = selectAutoSpeakerLowerThirdCandidate(candidates);
    if (!speaker) return;

    const visibleAutoLowerThird = lowerThirds.find((lowerThird) => (
      lowerThird.visible
      && lowerThird.source === 'auto-speaker'
      && lowerThird.participantId === speaker.participantId
    ));
    if (visibleAutoLowerThird) return;

    const now = Date.now();
    const last = lastAutoSpeakerLowerThirdRef.current;
    const cooldownMs = (AUTO_SPEAKER_LOWER_THIRD_DURATION_SECONDS + 2) * 1000;
    if (last?.participantId === speaker.participantId && now - last.shownAt < cooldownMs) return;

    lastAutoSpeakerLowerThirdRef.current = { participantId: speaker.participantId, shownAt: now };
    setLowerThirds((prev) => upsertAutoSpeakerLowerThird(prev, speaker, `lt-${++idCounters.current.lt}`));
  }, [autoSpeakerLowerThirds, effectiveAudioEnabled, isHostOrCoHost, lowerThirds, myParticipant, participants, stageAudioLevels]);

  useEffect(() => {
    if (autoSpeakerLowerThirds) return;
    lastAutoSpeakerLowerThirdRef.current = null;
    setLowerThirds((prev) => {
      let changed = false;
      const next = prev.map((lowerThird) => {
        if (lowerThird.source !== 'auto-speaker' || !lowerThird.visible) return lowerThird;
        changed = true;
        return { ...lowerThird, visible: false };
      });
      return changed ? next : prev;
    });
  }, [autoSpeakerLowerThirds]);

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

    if (myParticipant.status === 'green-room') {
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
  useEffect(() => {
    stopPublishedScreenShareRef.current = () => {
      publishedScreenShareCleanupRef.current?.();
      publishedScreenShareCleanupRef.current = null;
      stopScreenShare();
    };
  }, [stopScreenShare]);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  useEffect(() => { replaceTrackRef.current = replaceTrack; }, [replaceTrack]);
  useEffect(() => { startScreenShareRef.current = startScreenShare; }, [startScreenShare]);
  useEffect(() => { sendRef.current = send; }, [send]);

  useEffect(() => {
    if (!liveStartedAt) {
      setLiveElapsed(0);
      return;
    }

    const updateElapsed = () => setLiveElapsed(getLiveStreamElapsedSeconds(liveStartedAt));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [liveStartedAt]);

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
    const audioProcessing = readPreferredAudioProcessing();
    const videoQuality = readPreferredVideoQuality();
    startMedia(undefined, undefined, {
      audioEnabled: sessionStorage.getItem('preferredAudioEnabled') !== 'false',
      videoEnabled: sessionStorage.getItem('preferredVideoEnabled') !== 'false',
      videoQuality,
      ...audioProcessing,
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
    if (connected && !missingHostAccess) {
      setConnectionError(null);
    }
  }, [connected, missingHostAccess]);

  useEffect(() => {
    if (missingHostAccess) {
      setConnectionError(HOST_ACCESS_MISSING_MESSAGE);
    }
  }, [missingHostAccess]);

  // Join room once connected
  useEffect(() => {
    if (connected && roomId && !joinedRef.current && (localStream || mediaError || mediaAttemptComplete)) {
      if (missingHostAccess) return;
      joinedRef.current = true;
      // Only present hostToken when claiming host — guests never have one to send.
      const hostToken = userRole === 'host'
        ? roomHostToken || undefined
        : undefined;
      const coHostInviteToken = userRole === 'co-host'
        ? sessionStorage.getItem(`coHostInviteToken:${roomId}`) || undefined
        : undefined;
      const guestInviteToken = userRole === 'guest'
        ? sessionStorage.getItem(`guestInviteToken:${roomId}`) || undefined
        : undefined;
      const roomPassword = userRole === 'host' || coHostInviteToken ? undefined : sessionStorage.getItem(`roomPassword:${roomId}`) || undefined;
      const joinSessionId = userRole === 'host' ? undefined : getGuestJoinSessionId();
      send({
        type: 'join-room',
        payload: { roomId, name: userName, role: userRole, hostToken, coHostInviteToken, guestInviteToken, roomPassword, joinSessionId },
      });
    }
  }, [connected, localStream, mediaError, mediaAttemptComplete, missingHostAccess, roomId, roomHostToken, userName, userRole, send]);

  useEffect(() => {
    if (!guestNotification) return;
    const timer = window.setTimeout(() => setGuestNotification(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [guestNotification]);

  useEffect(() => {
    if (!liveSessionSummary) return;
    if (liveBackupRecording && liveBackupRecording.status !== 'disabled') return;
    const timer = window.setTimeout(() => setLiveSessionSummary(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [liveBackupRecording, liveSessionSummary]);

  // Signaling message handler
  const handleSignalingMessage = useCallback(
    (message: SignalMessage) => {
      switch (message.type) {
        case 'room-joined': {
          const { room: roomData, participant, participants: existing, chatMessages: existingChatMessages = [], qaQuestions: existingQuestions = [], polls: existingPolls = [], recordingState, liveStreamState, studioBranding, features } = message.payload;
          const live = Boolean(liveStreamState?.live || roomData.status === 'live');
          const liveStartedAt = live ? liveStreamState?.startedAt || new Date().toISOString() : null;
          const recordingStartedAt = recordingState?.recording ? recordingState.startedAt || new Date().toISOString() : null;
          const recordingSessionId = recordingState?.recording ? recordingState.sessionId || null : null;
          isLiveRef.current = live;
          liveStartedAtRef.current = liveStartedAt;
          sessionRecordingStartedAtRef.current = recordingStartedAt;
          setRoom(roomData);
          setIsLive(live);
          setLiveStartedAt(liveStartedAt);
          setMyParticipant(participant);
          setJoined(true);
          setChatMessages(existingChatMessages);
          setChatTypingIndicators([]);
          setSupportsChatTyping(features?.chatTyping === true);
          setQAQuestions(existingQuestions);
          setPolls(existingPolls);
          setRemoteStudioBranding(studioBranding || null);
          setSessionRecordingStartedAt(recordingStartedAt);
          setSessionRecordingSessionId(recordingSessionId);
          setSessionRecordingPaused(Boolean(recordingState?.recording && recordingState.paused));
          setSupportsCoordinatedRecording(Boolean(recordingState?.sessionId));
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
        case 'external-chat-status':
          setExternalChatStatuses((prev) => ({
            ...prev,
            [message.payload.platform]: message.payload,
          }));
          break;
        case 'chat-typing':
          setChatTypingIndicators((prev) => upsertChatTypingIndicator(
            prev,
            message.payload,
            myParticipantRef.current?.id || ''
          ));
          if (chatTypingExpiryTimerRef.current !== null) {
            window.clearTimeout(chatTypingExpiryTimerRef.current);
          }
          chatTypingExpiryTimerRef.current = window.setTimeout(() => {
            setChatTypingIndicators((prev) => removeExpiredChatTypingIndicators(prev));
            chatTypingExpiryTimerRef.current = null;
          }, CHAT_TYPING_TTL_MS + 150);
          break;
        case 'chat-reaction': {
          const reaction = createFloatingReaction(
            message.payload.reaction,
            ++reactionSequenceRef.current
          );
          setFloatingReactions((prev) => [
            ...prev.filter((item) => Date.now() - item.createdAt < REACTION_OVERLAY_DURATION_MS + 500).slice(-17),
            reaction,
          ]);
          window.setTimeout(() => {
            setFloatingReactions((prev) => prev.filter((item) => item.id !== reaction.id));
          }, REACTION_OVERLAY_DURATION_MS + reaction.delayMs + 250);
          break;
        }
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
          stopPublishedScreenShareRef.current();
          disconnectRef.current();
          setConnectionError(message.payload.reason || 'You were removed from this session.');
          break;
        case 'participant-notification':
          setGuestNotification(message.payload);
          break;
        case 'studio-branding-updated':
          setRemoteStudioBranding(message.payload);
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
          sessionRecordingStartedAtRef.current = message.payload.recording ? message.payload.startedAt || new Date().toISOString() : null;
          setSessionRecordingStartedAt(sessionRecordingStartedAtRef.current);
          if (message.payload.sessionId) {
            setSessionRecordingSessionId(message.payload.sessionId);
            setSupportsCoordinatedRecording(true);
          }
          setSessionRecordingPaused(Boolean(message.payload.recording && message.payload.paused));
          setRoom((prev) => prev ? { ...prev, status: getRoomActivityStatus(isLiveRef.current, sessionRecordingStartedAtRef.current) } : prev);
          break;
        case 'live-stream-state-changed': {
          const previousLiveStartedAt = liveStartedAtRef.current;
          isLiveRef.current = message.payload.live;
          liveStartedAtRef.current = message.payload.live ? message.payload.startedAt || new Date().toISOString() : null;
          setIsLive(message.payload.live);
          setLiveStartedAt(liveStartedAtRef.current);
          setRoom((prev) => prev ? { ...prev, status: getRoomActivityStatus(message.payload.live, sessionRecordingStartedAtRef.current) } : prev);
          if (message.payload.live) {
            setLiveSessionSummary(null);
          }
          if (!message.payload.live) {
            if (previousLiveStartedAt) {
              showLiveSessionSummary(previousLiveStartedAt, destinationsRef.current, {
                stoppedAt: message.payload.stoppedAt,
              });
            }
            setActiveStreamScreenState(null);
            setDestinations((prev) => prev.map((destination) => ({ ...destination, status: 'idle', statusMessage: undefined })));
          }
          break;
        }
        case 'live-stream-token-issued': {
          const pending = liveTokenRequestsRef.current.get(message.payload.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            liveTokenRequestsRef.current.delete(message.payload.requestId);
            pending.resolve(message.payload.token);
          }
          break;
        }
        case 'recording-upload-token-issued': {
          const pending = recordingUploadTokenRequestsRef.current.get(message.payload.requestId);
          if (pending && pending.sessionId === message.payload.sessionId) {
            clearTimeout(pending.timer);
            recordingUploadTokenRequestsRef.current.delete(message.payload.requestId);
            recordingUploadTokenRef.current = {
              sessionId: message.payload.sessionId,
              token: message.payload.token,
            };
            pending.resolve(message.payload.token);
          }
          break;
        }
        case 'sfu-token-issued': {
          const pending = sfuTokenRequestsRef.current.get(message.payload.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            sfuTokenRequestsRef.current.delete(message.payload.requestId);
            pending.resolve(message.payload.token);
          }
          break;
        }
        case 'guest-invite-token-issued': {
          const pending = guestInviteRequestsRef.current.get(message.payload.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            guestInviteRequestsRef.current.delete(message.payload.requestId);
            pending.resolve({
              token: message.payload.token,
              expiresAt: message.payload.expiresAt,
            });
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
          stopPublishedScreenShareRef.current();
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
            message.payload.code === 'GUEST_INVITE_INVALID' ||
            message.payload.code === ROOM_NOT_OPEN_ERROR_CODE ||
            message.payload.code === 'PARTICIPANT_BANNED'
          ) {
            if (roomId) {
              sessionStorage.removeItem(`roomPassword:${roomId}`);
              if (message.payload.code === 'GUEST_INVITE_INVALID') {
                sessionStorage.removeItem(`guestInviteToken:${roomId}`);
              }
            }
            cleanupRef.current();
            stopMediaRef.current();
            stopPublishedScreenShareRef.current();
            disconnectRef.current();
            setConnectionError(message.payload.message);
          }
          if (message.payload.code === 'HOST_TOKEN_INVALID') {
            if (roomId) {
              sessionStorage.removeItem(`hostToken:${roomId}`);
              removeSavedHostStudio(roomId);
            }
            sessionStorage.setItem('userRole', 'guest');
            cleanupRef.current();
            stopMediaRef.current();
            stopPublishedScreenShareRef.current();
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
          if (
            recordingUploadTokenRequestsRef.current.size > 0 &&
            ['UNAUTHORIZED', 'LIVE_STREAM_NOT_CONFIGURED', 'PARTICIPANT_NOT_ADMITTED', 'RECORDING_SESSION_MISMATCH', 'VALIDATION_ERROR', 'UNKNOWN_TYPE'].includes(message.payload.code)
          ) {
            const error = new Error(message.payload.message);
            for (const [requestId, request] of recordingUploadTokenRequestsRef.current) {
              clearTimeout(request.timer);
              request.reject(error);
              recordingUploadTokenRequestsRef.current.delete(requestId);
            }
          }
          if (
            sfuTokenRequestsRef.current.size > 0 &&
            ['UNAUTHORIZED', 'SFU_NOT_CONFIGURED', 'PARTICIPANT_NOT_ADMITTED', 'VALIDATION_ERROR', 'UNKNOWN_TYPE'].includes(message.payload.code)
          ) {
            const error = new Error(message.payload.message);
            for (const [requestId, request] of sfuTokenRequestsRef.current) {
              clearTimeout(request.timer);
              request.reject(error);
              sfuTokenRequestsRef.current.delete(requestId);
            }
          }
          if (message.payload.code === 'CO_HOST_INVITE_INVALID') {
            if (roomId) sessionStorage.removeItem(`coHostInviteToken:${roomId}`);
            sessionStorage.setItem('userRole', 'guest');
            cleanupRef.current();
            stopMediaRef.current();
            stopPublishedScreenShareRef.current();
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
          if (
            guestInviteRequestsRef.current.size > 0 &&
            ['UNAUTHORIZED', 'PARTICIPANT_NOT_ADMITTED', 'VALIDATION_ERROR'].includes(message.payload.code)
          ) {
            const error = new Error(message.payload.message);
            for (const [requestId, request] of guestInviteRequestsRef.current) {
              clearTimeout(request.timer);
              request.reject(error);
              guestInviteRequestsRef.current.delete(requestId);
            }
          }
          break;
        // Client-to-server messages: not expected here but listed for exhaustive check
        case 'join-room':
        case 'stage-action':
        case 'chat-star-update':
        case 'chat-pin-update':
        case 'qa-question-submitted':
        case 'qa-question-update':
        case 'qa-question-upvote':
        case 'poll-create':
        case 'poll-vote':
        case 'poll-update':
        case 'live-stream-token-request':
        case 'recording-upload-token-request':
        case 'sfu-token-request':
        case 'external-chat-connect':
        case 'external-chat-disconnect':
        case 'guest-invite-token-request':
        case 'co-host-invite-token-request':
        case 'end-room':
          break;
        default:
          assertNever(message);
      }
    },
    [showLiveSessionSummary]
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
      sfuSessionRef.current?.setLocalAudioTrack(audioTrack || null);
    }

    if (!isScreenSharing && videoTrack?.id !== published.video) {
      published.video = videoTrack?.id;
      if (videoTrack) {
        publishedVideoTrackRef.current = videoTrack;
        replaceTrack(videoTrack).catch((err) => console.error('Failed to publish video track:', err));
        sfuSessionRef.current?.setLocalVideoTrack(videoTrack);
      } else {
        publishedVideoTrackRef.current = null;
        sfuSessionRef.current?.setLocalVideoTrack(null);
      }
    }
  }, [isScreenSharing, localStream, replaceTrack]);

  // Sync local tracks when remotely muted/unmuted
  useEffect(() => {
    if (!myParticipant || !localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack && audioTrack.enabled !== myParticipant.audioEnabled) {
      setAudioTrackEnabled(myParticipant.audioEnabled);
    }
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack && videoTrack.enabled !== myParticipant.videoEnabled) {
      setVideoTrackEnabled(myParticipant.videoEnabled);
    }
  }, [myParticipant?.audioEnabled, myParticipant?.videoEnabled, localStream, setAudioTrackEnabled, setVideoTrackEnabled]);

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
      cleanup(); stopMedia(); stopPublishedScreenShareRef.current(); navigate('/');
    }
  };

  const onAudioDeviceChange = async (id: string) => {
    try { const t = await switchAudioDevice(id, audioProcessing); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to switch audio device:', err); }
  };
  const onAudioProcessingChange = async (next: AudioProcessingPreferences) => {
    try { const t = await updateAudioProcessing(next); if (t) await replaceTrack(t); }
    catch (err) { console.error('Failed to update audio processing:', err); }
  };
  const onVideoDeviceChange = async (id: string) => {
    try {
      const t = await switchVideoDevice(id);
      if (t && !isScreenSharingRef.current) {
        publishedVideoTrackRef.current = t;
        await replaceTrack(t);
        sfuSessionRef.current?.setLocalVideoTrack(t);
      }
    }
    catch (err) { console.error('Failed to switch video device:', err); }
  };
  const onVideoQualityChange = async (next: VideoQualityPresetId) => {
    try {
      const t = await updateVideoQuality(next);
      if (t && !isScreenSharingRef.current) {
        publishedVideoTrackRef.current = t;
        await replaceTrack(t);
        sfuSessionRef.current?.setLocalVideoTrack(t);
      }
    }
    catch (err) { console.error('Failed to update video quality:', err); }
  };
  // Screen sharing publishes a screen+camera PiP track when possible so remote
  // viewers keep seeing the presenter while screen content is shared.
  const onToggleScreenShare = useCallback(async () => {
    if (isScreenSharingRef.current) {
      stopPublishedScreenShareRef.current();
      const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
      if (cameraTrack) {
        publishedVideoTrackRef.current = cameraTrack;
        await replaceTrackRef.current(cameraTrack);
        sfuSessionRef.current?.setLocalVideoTrack(cameraTrack);
        publishedTrackIdsRef.current.video = cameraTrack.id;
      } else {
        publishedVideoTrackRef.current = null;
        sfuSessionRef.current?.setLocalVideoTrack(null);
      }
      if (myParticipantRef.current) sendRef.current({ type: 'media-state-changed', payload: { participantId: myParticipantRef.current.id, audioEnabled: audioEnabledRef.current, videoEnabled: videoEnabledRef.current, screenSharing: false } });
    } else {
      try {
        const stream = await startScreenShareRef.current();
        if (stream && myParticipantRef.current) {
          const screenTrack = stream.getVideoTracks()[0];
          if (screenTrack) {
            const screenPip = createScreenPictureInPictureStream({
              screenStream: stream,
              cameraStream: localStreamRef.current,
              frameRate: 30,
            });
            publishedScreenShareCleanupRef.current?.();
            publishedScreenShareCleanupRef.current = screenPip?.cleanup || null;
            const publishedVideoTrack = screenPip?.videoTrack || screenTrack;
            publishedVideoTrackRef.current = publishedVideoTrack;
            await replaceTrackRef.current(publishedVideoTrack);
            sfuSessionRef.current?.setLocalVideoTrack(publishedVideoTrack);
            publishedTrackIdsRef.current.video = publishedVideoTrack.id;
            screenTrack.addEventListener('ended', async () => {
              stopPublishedScreenShareRef.current();
              const camTrack = localStreamRef.current?.getVideoTracks()[0];
              if (camTrack) {
                publishedVideoTrackRef.current = camTrack;
                await replaceTrackRef.current(camTrack);
                sfuSessionRef.current?.setLocalVideoTrack(camTrack);
                publishedTrackIdsRef.current.video = camTrack.id;
              } else {
                publishedVideoTrackRef.current = null;
                sfuSessionRef.current?.setLocalVideoTrack(null);
              }
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
  const onToggleRecordingPause = useCallback(() => {
    if (!myParticipantRef.current || !canControlRecording || !isRecording) return;
    const nextPaused = !isRecordingPaused;
    if (isRecordingPaused) {
      resumeRecording();
    } else {
      pauseRecording();
    }
    setSessionRecordingPaused(nextPaused);
    send({
      type: 'recording-state-changed',
      payload: {
        recording: true,
        sessionId: sessionRecordingSessionId || undefined,
        paused: nextPaused,
        startedAt: sessionRecordingStartedAt || undefined,
        performedBy: myParticipantRef.current.id,
      },
    });
  }, [canControlRecording, isRecording, isRecordingPaused, pauseRecording, resumeRecording, send, sessionRecordingSessionId, sessionRecordingStartedAt]);

  const onToggleRecording = async () => {
    if (!myParticipant || !canControlRecording) return;
    if (isRecording) {
      const stoppedAt = new Date();
      const timestamp = formatRecordingTimestamp(stoppedAt);
      const recordingSessionId = sessionRecordingSessionId || `recording-${stoppedAt.getTime()}`;
      const expectedUploads = supportsCoordinatedRecording ? expectedDistributedUploadsRef.current : 1;
      send({
        type: 'recording-state-changed',
        payload: {
          recording: false,
          sessionId: recordingSessionId,
          performedBy: myParticipant.id,
        },
      });
      setSessionRecordingStartedAt(null);
      setSessionRecordingPaused(false);
      try {
        const recordings = await stopRecording();
        if (recordings.size > 0) {
          const files = buildToolbarRecordingUploadFiles(recordings, timestamp);
          if (files.length === 0) {
            throw new Error('No finished recording tracks were available to export.');
          }

          try {
            if (mediaServerHealth.status === 'unavailable') {
              throw new Error(mediaServerHealth.message || 'Media-server is unavailable.');
            }
            addToast('Finalizing MP4 recording export...', 'info');
            const token = await requestLiveStreamToken();
            const exportBasename = `${room?.name || 'Studio'} Recording ${timestamp}`;
            await uploadRecordingToMediaServer({
              token,
              roomId: roomId || '',
              sessionId: recordingSessionId,
              participantId: myParticipant.id,
              participantName: `${myParticipant.name} program`,
              files,
              startExport: false,
            });
            const distributed = await waitForDistributedRecordingSession({
              token,
              roomId: roomId || '',
              sessionId: recordingSessionId,
              expectedUploads,
              timeoutMs: 120_000,
              intervalMs: 1_500,
            });
            if (distributed.completedUploadCount < expectedUploads) {
              addToast(
                `Exporting ${distributed.completedUploadCount}/${expectedUploads} available local recordings.`,
                'warning'
              );
            }
            const exportJob = await exportDistributedRecordingSession({
              token,
              roomId: roomId || '',
              sessionId: recordingSessionId,
              basename: exportBasename,
              exportVideoCodec: 'h264',
              includeAudioStems: true,
              pollTimeoutMs: 180_000,
            });
            const mp4Artifact = getReadyMp4Artifact(exportJob);
            if (!mp4Artifact) throw new Error(exportJob.error || 'MP4 export did not finish.');
            const download = await downloadRecordingExportArtifact({
              token,
              uploadId: exportJob.uploadId,
              exportId: exportJob.exportId,
              artifactId: mp4Artifact.id,
              artifactLabel: mp4Artifact.label,
              format: mp4Artifact.format,
            });
            downloadBlobFile(download.blob, download.fileName);
            addToast('MP4 recording export downloaded.', 'success');
          } catch (err) {
            console.warn('MP4 recording export failed, saving original tracks:', err);
            await downloadToolbarRecordingFallbackFiles(files, timestamp);
            addToast(getToolbarRecordingFallbackToast(files), 'warning');
          }
        }
      } catch (err) {
        console.error('Failed to stop recording:', err);
        addToast(err instanceof Error ? err.message : 'Failed to stop recording.', 'error');
      }
    } else {
      const streams = new Map<string, RecordingStreamInput>();
      const programSource = createProgramRecordingSource({
        compositeStream: compositeStreamRef.current,
        localStream,
        localParticipant: myParticipant,
        participants,
        remoteStreams,
        screenStream,
        auxiliaryAudioStream: broadcastAudioBus.ensureStream() ?? broadcastAudioBus.stream,
        participantVolumes,
        participantAudioLevels: stageAudioLevels,
        audioDuckingEnabled,
      });

      if (programSource) {
        streams.set(programSource.id, {
          stream: programSource.stream,
          name: programSource.label,
          isLocal: true,
          kind: programSource.kind,
          cleanup: programSource.cleanup,
        });
      } else {
        if (localStream && myParticipant.status === 'on-stage') {
          streams.set(myParticipant.id, { stream: localStream, name: myParticipant.name, isLocal: true, kind: 'iso' });
        }
        for (const [id, participant] of participants) {
          if (participant.status !== 'on-stage') continue;
          const rs = remoteStreams.get(id);
          if (rs) streams.set(id, { stream: rs, name: participant.name, isLocal: false, kind: 'iso' });
        }
      }
      if (streams.size === 0) return;
      const started = startRecording(streams);
      if (!started) return;
      const startedAt = new Date().toISOString();
      const recordingSessionId = `recording-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const localCaptureCount = myParticipant.status === 'on-stage' && (myParticipant.audioEnabled || myParticipant.videoEnabled) ? 1 : 0;
      const remoteCaptureCount = Array.from(participants.values()).filter((participant) => (
        participant.status === 'on-stage' && (participant.audioEnabled || participant.videoEnabled)
      )).length;
      expectedDistributedUploadsRef.current = Math.max(1, localCaptureCount + remoteCaptureCount + 1);
      setSessionRecordingStartedAt(startedAt);
      setSessionRecordingSessionId(recordingSessionId);
      setSessionRecordingPaused(false);
      send({
        type: 'recording-state-changed',
        payload: {
          recording: true,
          sessionId: recordingSessionId,
          paused: false,
          startedAt,
          performedBy: myParticipant.id,
        },
      });
    }
  };

  // Local recording (separate on-stage tracks)
  const onStartLocalRecording = useCallback(async () => {
    if (!myParticipant || !canControlRecording || !recordingReadiness.canStart) return;
    const programSource = createProgramRecordingSource({
      compositeStream: compositeStreamRef.current,
      localStream,
      localParticipant: myParticipant,
      participants,
      remoteStreams,
      screenStream,
      auxiliaryAudioStream: broadcastAudioBus.ensureStream() ?? broadcastAudioBus.stream,
      participantVolumes,
      participantAudioLevels: stageAudioLevels,
      audioDuckingEnabled,
    });
    const sources = buildLocalRecordingSources({
      localParticipant: myParticipant,
      localStream,
      participants,
      remoteStreams,
      screenStream,
      isScreenSharing,
      programSource,
      createScreenPictureInPictureSource: createScreenPictureInPictureRecordingSource,
    });

    if (sources.length === 0) return;
    await startLocalRecording(sources);
  }, [
    audioDuckingEnabled,
    broadcastAudioBus,
    canControlRecording,
    createScreenPictureInPictureRecordingSource,
    isScreenSharing,
    localStream,
    myParticipant,
    participantVolumes,
    participants,
    recordingReadiness.canStart,
    remoteStreams,
    screenStream,
    stageAudioLevels,
    startLocalRecording,
  ]);

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
  const onSendChat = (content: string, isBackstage = false, recipientId?: string) => {
    if (!myParticipant) return;
    const recipient = recipientId
      ? participants.get(recipientId) || (myParticipant.id === recipientId ? myParticipant : undefined)
      : undefined;
    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      senderId: myParticipant.id,
      senderName: myParticipant.name,
      content,
      timestamp: new Date().toISOString(),
      isBackstage: recipient ? false : isBackstage,
      ...(recipient
        ? {
            recipientId: recipient.id,
            recipientName: recipient.name,
          }
        : {}),
    };

    // Keep public messages optimistic. Backstage and direct messages are echoed
    // back by the server to their scoped audience, which avoids local-only leaks.
    if (!isBackstage && !recipient) {
      setChatMessages((prev) => {
        const next = [...prev, msg];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }

    send({ type: 'chat-message', payload: msg });
  };

  const onChatTypingChange = (typing: boolean, isBackstage = false, recipientId?: string) => {
    if (!supportsChatTyping || !myParticipant) return;
    const recipient = recipientId
      ? participants.get(recipientId) || (myParticipant.id === recipientId ? myParticipant : undefined)
      : undefined;
    if (recipientId && !recipient) return;

    const payload: ChatTypingPayload = {
      participantId: myParticipant.id,
      participantName: myParticipant.name,
      typing,
      timestamp: new Date().toISOString(),
      isBackstage: recipient ? false : isBackstage,
      ...(recipient
        ? {
            recipientId: recipient.id,
            recipientName: recipient.name,
          }
        : {}),
    };

    send({ type: 'chat-typing', payload });
  };

  const onReactChat = (messageId: string, reaction: ChatReactionType) => {
    send({ type: 'chat-reaction', payload: { messageId, reaction } });
  };

  const onToggleChatStar = (messageId: string, starred: boolean) => {
    send({ type: 'chat-star-update', payload: { messageId, starred } });
  };

  const onToggleChatPin = (messageId: string, pinned: boolean) => {
    send({ type: 'chat-pin-update', payload: { messageId, pinned } });
  };

  const onConnectExternalChat = (platform: ExternalChatPlatform, liveChatId: string) => {
    if (!isHostOrCoHost) return;
    send({ type: 'external-chat-connect', payload: { platform, liveChatId } });
  };

  const onDisconnectExternalChat = (platform: ExternalChatPlatform) => {
    if (!isHostOrCoHost) return;
    send({ type: 'external-chat-disconnect', payload: { platform } });
  };

  const popoutSendChatRef = useRef(onSendChat);
  const popoutReactChatRef = useRef(onReactChat);
  const popoutToggleChatStarRef = useRef(onToggleChatStar);
  const popoutToggleChatPinRef = useRef(onToggleChatPin);

  useEffect(() => {
    popoutSendChatRef.current = onSendChat;
    popoutReactChatRef.current = onReactChat;
    popoutToggleChatStarRef.current = onToggleChatStar;
    popoutToggleChatPinRef.current = onToggleChatPin;
  });

  const postPopoutChatState = useCallback(() => {
    const channel = popoutChatChannelRef.current;
    const state = popoutChatStateRef.current;
    if (!channel || !state) return;
    channel.postMessage(state);
  }, []);

  useEffect(() => {
    popoutChatStateRef.current = roomId
      ? {
          type: 'state',
          roomId,
          roomName: room?.name || 'Studio Chat',
          senderName: userName,
          connected,
          messages: chatMessages,
          updatedAt: new Date().toISOString(),
        }
      : null;
    postPopoutChatState();
  }, [chatMessages, connected, postPopoutChatState, room?.name, roomId, userName]);

  useEffect(() => {
    if (!roomId || !popoutChatSessionId || !isHostOrCoHost || typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(getPopoutChatChannelName(roomId, popoutChatSessionId));
    popoutChatChannelRef.current = channel;

    channel.onmessage = (event) => {
      if (!isPopoutChatCommand(event.data)) return;
      const message = event.data;
      if (message.type === 'ready' || message.type === 'request-state') {
        postPopoutChatState();
        return;
      }
      if (message.type === 'send-message') {
        const content = message.payload.content.trim();
        if (content.length > 0 && content.length <= 2000) {
          popoutSendChatRef.current(content, message.payload.isBackstage);
        }
        return;
      }
      if (message.type === 'react') {
        popoutReactChatRef.current(message.payload.messageId, message.payload.reaction);
        return;
      }
      if (message.type === 'toggle-star') {
        popoutToggleChatStarRef.current(message.payload.messageId, message.payload.starred);
        return;
      }
      if (message.type === 'toggle-pin') {
        popoutToggleChatPinRef.current(message.payload.messageId, message.payload.pinned);
      }
    };

    postPopoutChatState();

    return () => {
      if (popoutChatChannelRef.current === channel) popoutChatChannelRef.current = null;
      channel.close();
    };
  }, [isHostOrCoHost, popoutChatSessionId, postPopoutChatState, roomId]);

  const onOpenPopoutChat = useCallback(() => {
    if (!roomId || !popoutChatSessionId) return;
    if (typeof BroadcastChannel === 'undefined') {
      addToast('Pop-out chat is not supported in this browser.', 'warning');
      return;
    }

    const url = buildPopoutChatUrl(window.location.origin, roomId, popoutChatSessionId);
    const popup = window.open(
      url,
      `studio-popout-chat-${roomId}`,
      'popup,width=420,height=720,menubar=no,toolbar=no,location=no,status=no'
    );
    if (!popup) {
      addToast('Pop-out chat was blocked by the browser.', 'warning');
      return;
    }
    popup.focus();
  }, [addToast, popoutChatSessionId, roomId]);

  // Lower thirds
  const onAddLowerThird = (lt: LowerThirdDraft) => {
    setLowerThirds((prev) => addLowerThird(prev, lt, `lt-${++idCounters.current.lt}`));
  };
  const onToggleLowerThird = (id: string) => {
    setLowerThirds((prev) => toggleLowerThirdVisibility(prev, id));
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
    buildGuestInviteUrl(INVITE_BASE_URL, roomId || '', room?.name || 'Studio')
  ), [room?.name, roomId]);

  const requestSfuToken = useCallback((): Promise<string> => {
    const requestId = `sfu-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sfuTokenRequestsRef.current.delete(requestId);
        reject(new Error('Timed out while authorizing the SFU media connection.'));
      }, 10_000);

      sfuTokenRequestsRef.current.set(requestId, { resolve, reject, timer });
      send({
        type: 'sfu-token-request',
        payload: { requestId },
      });
    });
  }, [send]);

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

  const requestRecordingUploadToken = useCallback((sessionId: string): Promise<string> => {
    if (recordingUploadTokenRef.current?.sessionId === sessionId) {
      return Promise.resolve(recordingUploadTokenRef.current.token);
    }
    const requestId = `recording-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        recordingUploadTokenRequestsRef.current.delete(requestId);
        reject(new Error('Timed out while authorizing participant recording upload.'));
      }, 10_000);

      recordingUploadTokenRequestsRef.current.set(requestId, { resolve, reject, timer, sessionId });
      send({
        type: 'recording-upload-token-request',
        payload: { requestId, sessionId },
      });
    });
  }, [send]);

  useEffect(() => {
    let cancelled = false;
    let session: SfuSocketSession | null = null;
    let retryTimer: number | null = null;

    const restoreMeshMedia = () => {
      void setAudioForwardingEnabled(true);
      void setVideoForwardingEnabled(true);
      setSfuRemoteStreams(new Map());
    };
    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        setSfuReconnectNonce((value) => value + 1);
      }, 5_000);
    };

    if (!shouldConnectSfuMedia) {
      sfuSessionRef.current?.close();
      sfuSessionRef.current = null;
      setSfuTransportStatus('idle');
      restoreMeshMedia();
      return () => {
        cancelled = true;
      };
    }

    setSfuTransportStatus('connecting');
    setSfuRemoteStreams(new Map());
    void requestSfuToken().then(async (token) => {
      const iceConfiguration = await fetchIceConfig().catch(() => DEFAULT_ICE_CONFIG);
      if (cancelled) return;
      const localVideoTrack = publishedVideoTrackRef.current || localStreamRef.current?.getVideoTracks()[0] || null;
      const localAudioTrack = localStreamRef.current?.getAudioTracks()[0] || null;
      let remoteMediaReady = false;
      let localPublishReady = localVideoTrack === null && localAudioTrack === null;
      const activateSfuMedia = () => {
        if (cancelled || sfuSessionRef.current !== session || !remoteMediaReady || !localPublishReady) return;
        setSfuTransportStatus('active');
        void setAudioForwardingEnabled(false);
        void setVideoForwardingEnabled(false);
      };

      const failToMesh = (message: string) => {
        if (cancelled || sfuSessionRef.current !== session) return;
        console.warn(`SFU media: ${message}`);
        sfuSessionRef.current = null;
        setSfuTransportStatus('fallback');
        restoreMeshMedia();
        session?.close();
        scheduleRetry();
      };

      session = new SfuSocketSession({
        token,
        localVideoTrack,
        localAudioTrack,
        downlinkKbps: 6_000,
        iceConfiguration,
        onReady: () => {
          if (!cancelled && sfuSessionRef.current === session) setSfuTransportStatus('ready');
        },
        onPublishStart: () => {
          if (cancelled || sfuSessionRef.current !== session) return;
          localPublishReady = false;
          setSfuTransportStatus('ready');
          void setAudioForwardingEnabled(true);
          void setVideoForwardingEnabled(true);
        },
        onPublishReady: () => {
          localPublishReady = true;
          activateSfuMedia();
        },
        onRemoteStream: (producerId, stream) => {
          if (cancelled || sfuSessionRef.current !== session) return;
          setSfuRemoteStreams((current) => {
            const next = new Map(current);
            next.set(producerId, stream);
            return next;
          });
        },
        onRemoteStreamRemoved: (producerId) => {
          if (cancelled || sfuSessionRef.current !== session) return;
          setSfuRemoteStreams((current) => {
            if (!current.has(producerId)) return current;
            const next = new Map(current);
            next.delete(producerId);
            return next;
          });
        },
        onRemoteMediaReady: () => {
          remoteMediaReady = true;
          activateSfuMedia();
        },
        onRemoteMediaPending: () => {
          remoteMediaReady = false;
          if (cancelled || sfuSessionRef.current !== session) return;
          setSfuTransportStatus('ready');
          void setAudioForwardingEnabled(true);
          void setVideoForwardingEnabled(true);
        },
        onError: failToMesh,
        onClose: () => {
          if (cancelled || sfuSessionRef.current !== session) return;
          sfuSessionRef.current = null;
          setSfuTransportStatus('fallback');
          restoreMeshMedia();
          scheduleRetry();
        },
      });
      sfuSessionRef.current = session;
      session.connect();
    }).catch((error) => {
      if (cancelled) return;
      console.warn('SFU media startup failed; keeping mesh media:', error);
      if (sfuSessionRef.current === session) sfuSessionRef.current = null;
      session?.close();
      setSfuTransportStatus('fallback');
      restoreMeshMedia();
      scheduleRetry();
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (sfuSessionRef.current === session) sfuSessionRef.current = null;
      session?.close();
      void setAudioForwardingEnabled(true);
      void setVideoForwardingEnabled(true);
    };
  }, [requestSfuToken, setAudioForwardingEnabled, setVideoForwardingEnabled, sfuReconnectNonce, shouldConnectSfuMedia]);

  useEffect(() => {
    if (
      !sessionRecordingStartedAt ||
      !sessionRecordingSessionId ||
      !supportsCoordinatedRecording ||
      !myParticipant ||
      myParticipant.status !== 'on-stage' ||
      isParticipantLocalRecording ||
      participantRecordingFinalizing
    ) return;

    const sources = buildParticipantRecordingSources({
      localParticipant: myParticipant,
      localStream,
      screenStream,
      isScreenSharing,
    });
    if (sources.length === 0) return;

    void startParticipantLocalRecording(sources)
      .then(() => requestRecordingUploadToken(sessionRecordingSessionId))
      .catch((err) => {
        console.warn('Participant local recording could not start or authorize upload:', err);
      });
  }, [
    isParticipantLocalRecording,
    isScreenSharing,
    localStream,
    myParticipant,
    participantRecordingFinalizing,
    requestRecordingUploadToken,
    screenStream,
    sessionRecordingSessionId,
    sessionRecordingStartedAt,
    startParticipantLocalRecording,
    supportsCoordinatedRecording,
  ]);

  useEffect(() => {
    if (!isParticipantLocalRecording) return;
    const shouldPause = sessionRecordingPaused || myParticipant?.status !== 'on-stage';
    if (shouldPause && !isParticipantLocalRecordingPaused) {
      void pauseParticipantLocalRecording();
    } else if (!shouldPause && isParticipantLocalRecordingPaused) {
      void resumeParticipantLocalRecording();
    }
  }, [
    isParticipantLocalRecording,
    isParticipantLocalRecordingPaused,
    myParticipant?.status,
    pauseParticipantLocalRecording,
    resumeParticipantLocalRecording,
    sessionRecordingPaused,
  ]);

  useEffect(() => {
    if (
      sessionRecordingStartedAt ||
      !sessionRecordingSessionId ||
      !isParticipantLocalRecording ||
      participantRecordingFinalizing
    ) return;

    const sessionId = sessionRecordingSessionId;
    const participant = myParticipant;
    if (!participant || !roomId) return;
    setParticipantRecordingFinalizing(true);

    void (async () => {
      try {
        const result = await stopParticipantLocalRecording();
        const timestamp = formatRecordingTimestamp(new Date());
        const files = result.files
          .filter((file) => file.blob.size > 0)
          .map((file, index) => ({
            label: file.label,
            blob: file.blob,
            kind: file.kind,
            capture: file.capture,
            fileName: `${participant.name.replace(/[^a-z0-9_-]+/gi, '_') || 'participant'}_${file.kind}_${index + 1}_${timestamp}.${getRecordingFileExtension(file.blob.type)}`,
          }));
        if (files.length === 0) return;

        await persistRecordingSession({
          roomName: `${room?.name || 'Studio'} - ${participant.name}`,
          durationSeconds: result.files[0]?.capture?.durationMs
            ? Math.round(result.files[0].capture.durationMs / 1000)
            : null,
          files,
        });

        try {
          const token = await requestRecordingUploadToken(sessionId);
          await uploadRecordingToMediaServer({
            token,
            roomId,
            sessionId,
            participantId: participant.id,
            participantName: participant.name,
            files,
            startExport: false,
          });
          addToast(`${participant.name}'s local recording uploaded.`, 'success');
        } catch (err) {
          console.warn('Participant local recording upload failed:', err);
          addToast('Local recording saved in this browser; cloud upload is unavailable.', 'warning');
        }
      } catch (err) {
        console.error('Participant local recording finalization failed:', err);
        addToast('Participant local recording could not be finalized.', 'error');
      } finally {
        setParticipantRecordingFinalizing(false);
      }
    })();
  }, [
    addToast,
    isParticipantLocalRecording,
    myParticipant,
    participantRecordingFinalizing,
    requestRecordingUploadToken,
    room?.name,
    roomId,
    sessionRecordingSessionId,
    sessionRecordingStartedAt,
    stopParticipantLocalRecording,
  ]);

  const uploadLocalRecordingToMediaServer = useCallback(async (input: RecordingServerUploadInput) => {
    if (!roomId) throw new Error('Room id is required for recording upload.');
    const token = await requestLiveStreamToken();
    return uploadRecordingToMediaServer({
      token,
      roomId,
      sessionId: input.sessionId,
      files: input.files,
      exportBasename: `${room?.name || 'Studio'} ${input.sessionId}`,
      exportVideoCodec: input.exportVideoCodec,
      normalizeAudio: input.normalizeAudio,
    });
  }, [requestLiveStreamToken, room?.name, roomId]);

  const downloadMediaServerRecordingArtifact = useCallback(async (
    input: RecordingServerExportArtifactInput
  ): Promise<BlobExportDownload> => {
    const token = await requestLiveStreamToken();
    const download = await downloadRecordingExportArtifact({
      token,
      uploadId: input.uploadId,
      exportId: input.exportId,
      artifactId: input.artifact.id,
      artifactLabel: input.artifact.label,
      format: input.artifact.format,
    });
    return {
      blob: download.blob,
      fileName: download.fileName,
    };
  }, [requestLiveStreamToken]);

  const refreshMediaServerRecordingExport = useCallback(async (
    input: RecordingServerExportRefreshInput
  ) => {
    const token = await requestLiveStreamToken();
    return getRecordingExportJob({
      token,
      uploadId: input.uploadId,
      exportId: input.exportId,
    });
  }, [requestLiveStreamToken]);

  const requestMediaServerClipExport = useCallback(async (
    input: RecordingServerClipExportInput
  ) => {
    const token = await requestLiveStreamToken();
    return requestRecordingClipExport({
      token,
      uploadId: input.uploadId,
      clip: input.clip,
      edl: input.edl,
      basename: input.basename,
      exportVideoCodec: input.exportVideoCodec,
      normalizeAudio: input.normalizeAudio,
    });
  }, [requestLiveStreamToken]);

  const syncLocalRecordingCatalog = useCallback(async (session: LocalRecordingSession) => {
    if (!roomId || !roomHostToken) return;
    await syncRecordingCatalogEntry({
      roomId,
      hostToken: roomHostToken,
      session,
    });
  }, [roomHostToken, roomId]);

  const finalizeLiveBackupRecording = useCallback(async () => {
    if (!roomId || !isHostOrCoHost) return;
    if (liveBackupRecording?.status === 'disabled') return;
    setLiveBackupRecording((current) => (
      current
        ? { ...current, status: current.status === 'recording' ? 'finalizing' : current.status }
        : {
            backupId: '',
            roomId,
            fileName: '',
            startedAt: new Date().toISOString(),
            status: 'finalizing',
          }
    ));
    try {
      const token = await requestLiveStreamToken();
      const backup = await pollRtmpBackupRecording({ token, roomId });
      if (backup) {
        setLiveBackupRecording(backup);
      } else {
        setLiveBackupRecording({
          backupId: '',
          roomId,
          fileName: '',
          startedAt: new Date().toISOString(),
          status: 'error',
          error: 'No server backup recording was found.',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Server backup recording status failed.';
      setLiveBackupRecording({
        backupId: '',
        roomId,
        fileName: '',
        startedAt: new Date().toISOString(),
        status: 'error',
        error: message,
      });
      console.error('Failed to finalize live backup recording:', err);
    }
  }, [isHostOrCoHost, liveBackupRecording?.status, requestLiveStreamToken, roomId]);

  const onDownloadLiveBackupRecording = useCallback(async () => {
    if (!liveBackupRecording || liveBackupRecording.status !== 'ready') return;
    setLiveBackupDownloading(true);
    try {
      const token = await requestLiveStreamToken();
      const download = await downloadRtmpBackupRecording({
        token,
        backup: liveBackupRecording,
      });
      downloadBlobFile(download.blob, download.fileName);
    } catch (err) {
      console.error('Failed to download live backup recording:', err);
      addToast(err instanceof Error ? err.message : 'Failed to download live backup recording.', 'error');
    } finally {
      setLiveBackupDownloading(false);
    }
  }, [addToast, liveBackupRecording, requestLiveStreamToken]);

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

  const requestGuestInvite = useCallback(async (): Promise<{ inviteUrl: string; expiresAt: string }> => {
    const requestId = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const { token, expiresAt } = await new Promise<{ token: string; expiresAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        guestInviteRequestsRef.current.delete(requestId);
        reject(new Error('Timed out while creating secure guest invite.'));
      }, 10_000);

      guestInviteRequestsRef.current.set(requestId, { resolve, reject, timer });
      send({
        type: 'guest-invite-token-request',
        payload: { requestId },
      });
    });

    return {
      inviteUrl: buildSecureGuestInviteUrl(inviteUrl, token),
      expiresAt,
    };
  }, [inviteUrl, send]);

  // Stream destinations
  const onAddDestination = (dest: Omit<StreamDestination, 'id' | 'status' | 'statusMessage'>) => {
    setDestinations((prev) => [...prev, { ...dest, id: `dest-${++idCounters.current.dest}`, status: 'idle', statusMessage: undefined }]);
  };
  const onUpdateDestination = (id: string, dest: Omit<StreamDestination, 'id' | 'status' | 'statusMessage'>) => {
    setDestinations((prev) => prev.map((destination) => (
      destination.id === id ? { ...destination, ...dest, status: 'idle', statusMessage: undefined } : destination
    )));
  };
  const onRemoveDestination = (id: string) => {
    setDestinations((prev) => prev.filter((d) => d.id !== id));
  };
  const onToggleDestination = (id: string) => {
    setDestinations((prev) => prev.map((d) => (
      d.id === id ? { ...d, enabled: !d.enabled, status: 'idle', statusMessage: undefined } : d
    )));
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
      setDestinations((prev) => prev.map((d) => (
        d.enabled
          ? { ...d, status: 'error', statusMessage: getStreamDestinationIssue(d) || 'Check destination settings before going live.' }
          : { ...d, status: 'idle', statusMessage: undefined }
      )));
      return;
    }

    const readiness = await checkRelayReadiness();
    if (readiness.status !== 'ready') {
      setDestinations((prev) => prev.map((d) => (
        d.enabled
          ? { ...d, status: 'error', statusMessage: readiness.message }
          : { ...d, status: 'idle', statusMessage: undefined }
      )));
      return;
    }

    setIsLive(true);
    setLiveStartedAt(null);
    setLiveSessionSummary(null);
    setLiveBackupRecording(null);
    setDestinations((prev) => prev.map((d) => (
      d.enabled
        ? { ...d, status: 'connecting', statusMessage: 'Starting relay session...' }
        : { ...d, status: 'idle', statusMessage: undefined }
    )));
    try {
      const token = await requestLiveStreamToken();
      await startRelay({
        token,
        refreshToken: requestLiveStreamToken,
        orientation: broadcastOrientation,
        outputPreset: rtmpRelayOutputPreset,
        destinations: enabledDestinations.map((destination) => ({
          id: destination.id,
          name: destination.name,
          rtmpUrl: destination.rtmpUrl,
          streamKey: destination.streamKey,
        })),
      });
      send({
        type: 'live-stream-state-changed',
        payload: {
          live: true,
          performedBy: myParticipantRef.current?.id || '',
        },
      });
    } catch (err) {
      console.error('Failed to start live stream:', err);
      stopRelay();
      setIsLive(false);
      setLiveStartedAt(null);
      setActiveStreamScreenState(null);
      const message = err instanceof Error ? err.message : 'Failed to start live stream.';
      setDestinations((prev) => prev.map((d) => (
        d.enabled
          ? { ...d, status: 'error', statusMessage: message }
          : { ...d, status: 'idle', statusMessage: undefined }
      )));
    }
  };
  const onStopLive = () => {
    if (liveStatusTimerRef.current) {
      clearTimeout(liveStatusTimerRef.current);
      liveStatusTimerRef.current = null;
    }
    stopRelay();
    const previousLiveStartedAt = liveStartedAtRef.current;
    if (previousLiveStartedAt) {
      showLiveSessionSummary(previousLiveStartedAt, destinationsRef.current, {
        stoppedAt: new Date().toISOString(),
      });
    }
    void finalizeLiveBackupRecording();
    liveStartedAtRef.current = null;
    setIsLive(false);
    setLiveStartedAt(null);
    setActiveStreamScreenState(null);
    send({
      type: 'live-stream-state-changed',
      payload: {
        live: false,
        performedBy: myParticipantRef.current?.id || '',
      },
    });
    setDestinations((prev) => prev.map((d) => ({ ...d, status: 'idle', statusMessage: undefined })));
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
  const onUploadMedia = async (files: FileList | File[]) => {
    const uploads = Array.from(files).map((file) => {
      const type = detectMediaType(file);
      const isDeck = type === 'presentation' || type === 'pdf';
      const asset: StudioMediaAsset = {
        id: `media-${++idCounters.current.media}`,
        name: file.name,
        url: URL.createObjectURL(file),
        type,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        createdAt: new Date().toISOString(),
        source: 'upload' as const,
        ...(isDeck ? {
          processingStatus: 'processing' as const,
          processingMessage: getDeckPreparationMessage(type),
        } : {}),
      };
      return { file, type, isDeck, asset };
    });

    if (uploads.length > 0) {
      setMediaAssets((prev) => [...uploads.map((upload) => upload.asset), ...prev].slice(0, 80));
    }

    await Promise.all(uploads.map(async ({ file, type, isDeck, asset }) => {
      if (!isDeck) return;

      try {
        let serverRenderFailure: PresentationServerRenderFailure | undefined;
        const powerPointRenderStrategy = type === 'presentation'
          ? getPowerPointRenderStrategy(file)
          : null;
        const skipUnavailableServerRender = type === 'presentation' && (
          mediaServerHealth.status === 'unavailable' ||
          mediaServerHealth.presentationRenderer?.ready === false
        );
        if (skipUnavailableServerRender) {
          serverRenderFailure = getUnavailableMediaServerPresentationFailure(type, mediaServerHealth);
        }
        const preview = await buildPresentationPreview(file, {
          requireRenderedSlides: true,
          requireServerRenderedPowerPoint: powerPointRenderStrategy?.requireServerRenderedPowerPoint,
          allowBrowserPowerPointRenderFallback: powerPointRenderStrategy?.allowBrowserPowerPointRenderFallback,
          skipServerRender: skipUnavailableServerRender,
          onServerRenderFailure: (failure) => {
            serverRenderFailure = failure;
          },
        });
        const nextState = preview
          ? {
              preview,
              processingStatus: 'ready' as const,
              processingMessage: undefined,
            }
          : {
              processingStatus: 'error' as const,
              processingMessage: getDeckRenderFailureMessage(type, serverRenderFailure),
            };

        setMediaAssets((prev) => prev.map((item) => (
          item.id === asset.id ? { ...item, ...nextState } : item
        )));
      } catch (err) {
        console.error('Failed to render presentation media:', err);
        setMediaAssets((prev) => prev.map((item) => (
          item.id === asset.id
            ? {
                ...item,
                processingStatus: 'error',
                processingMessage: getDeckRenderFailureMessage(type),
              }
            : item
        )));
      }
    }));
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
    if (!canPlayMediaAsset(asset)) {
      setMediaAssets((prev) => prev.map((item) => (
        item.id === asset.id
          ? item.processingStatus === 'processing'
            ? {
                ...item,
                processingMessage: item.processingMessage || getDeckPreparationMessage(item.type),
              }
            : {
                ...item,
                processingStatus: 'error',
                processingMessage: item.processingMessage || getDeckRenderFailureMessage(item.type),
              }
          : item
      )));
      return;
    }
    setActiveMedia({
      assetId: asset.id,
      type: asset.type,
      url: asset.url,
      name: asset.name,
      preview: asset.preview,
    });
    setActiveMediaSlideIndex(0);
  };

  const onRemoveMediaAsset = (assetId: string) => {
    const removedActiveMedia = activeMedia?.assetId === assetId;
    setMediaAssets((prev) => {
      const asset = prev.find((item) => item.id === assetId);
      if (asset?.url.startsWith('blob:')) URL.revokeObjectURL(asset.url);
      return prev.filter((item) => item.id !== assetId);
    });
    setActiveMedia((current) => current?.assetId === assetId ? null : current);
    if (removedActiveMedia) setActiveMediaSlideIndex(0);
  };

  const onStopMedia = () => {
    setActiveMedia(null);
    setActiveMediaSlideIndex(0);
  };

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

  const getPersistedSceneLogoUrl = async (): Promise<string | null> => {
    if (!logoUrl) return null;
    if (!logoUrl.startsWith('blob:')) return logoUrl;

    try {
      return await blobToDataUrl(logoUrl);
    } catch {
      return logoUrl;
    }
  };

  const getPersistedSceneBackground = async (): Promise<StageBackground> => {
    if (stageBackground.type === 'image' && stageBackground.value.startsWith('blob:')) {
      try {
        return { ...stageBackground, value: await blobToDataUrl(stageBackground.value) };
      } catch {
        return stageBackground;
      }
    }
    return stageBackground;
  };

  // Scenes
  const buildCurrentSceneSnapshot = async (id: string, name: string): Promise<Scene> => {
    const persistedLogoUrl = await getPersistedSceneLogoUrl();
    const persistedBackground = await getPersistedSceneBackground();

    return {
      id,
      name,
      layout,
      background: persistedBackground,
      brandColor,
      logoUrl: persistedLogoUrl,
      cameraShape,
      nameTagStyle,
      logoPlacement,
      logoPosition: normalizeLogoPosition(logoPosition),
      logoSize,
      logoOpacity,
      pipCorner,
      focusedVideoItemId,
      stageItemOrder: normalizeStageItemOrder(stageItemOrder, availableStageItemIds),
      activeMedia: getSceneActiveMediaSnapshot(activeMedia, activeMediaSlideIndex),
      visibleOverlayIds: [
        ...lowerThirds.filter(o => o.visible).map(o => o.id),
        ...banners.filter(b => b.visible).map(b => b.id),
        ...timers.filter(t => t.visible).map(t => t.id),
        ...tickers.filter(t => t.visible).map(t => t.id),
        ...widgets.filter(widget => widget.visible).map(widget => widget.id),
      ],
    };
  };

  const onSaveScene = async (name: string) => {
    if (scenes.length >= MAX_STUDIO_SCENES) return;

    const newScene = await buildCurrentSceneSnapshot(
      `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name
    );
    setScenes(prev => [...prev, newScene]);
    setActiveSceneId(newScene.id);
  };

  const buildProductionSceneDraft = async (template: ProductionSceneTemplate): Promise<ProductionSceneDraft> => {
    const [persistedLogoUrl, persistedBackground] = await Promise.all([
      getPersistedSceneLogoUrl(),
      getPersistedSceneBackground(),
    ]);
    const config = getProductionSceneTemplateConfig(template, {
      brandColor,
      background: persistedBackground,
    });
    const visibleOverlayIds: string[] = [];
    let lowerThird: LowerThirdData | null = null;
    let banner: BannerData | null = null;
    let ticker: TickerData | null = null;
    let timer: TimerData | null = null;

    if (config.lowerThird) {
      lowerThird = { ...config.lowerThird, id: `lt-${++idCounters.current.lt}` };
      if (lowerThird.visible) visibleOverlayIds.push(lowerThird.id);
    }
    if (config.banner) {
      banner = { ...config.banner, id: `banner-${++idCounters.current.banner}` };
      if (banner.visible) visibleOverlayIds.push(banner.id);
    }
    if (config.ticker) {
      ticker = { ...config.ticker, id: `ticker-${++idCounters.current.ticker}` };
      if (ticker.visible) visibleOverlayIds.push(ticker.id);
    }
    if (config.timer) {
      timer = { ...config.timer, id: `timer-${++idCounters.current.timer}` };
      if (timer.visible) visibleOverlayIds.push(timer.id);
    }

    const scene: Scene = {
      id: `scene-template-${template}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: config.name,
      layout: config.layout,
      background: config.background,
      brandColor: config.brandColor,
      logoUrl: persistedLogoUrl,
      cameraShape: config.cameraShape,
      nameTagStyle: config.nameTagStyle,
      logoPlacement,
      logoPosition: normalizeLogoPosition(logoPosition),
      logoSize,
      logoOpacity,
      pipCorner: 'BR',
      focusedVideoItemId: null,
      stageItemOrder: [],
      activeMedia: null,
      visibleOverlayIds,
    };

    return { scene, config, lowerThird, banner, ticker, timer };
  };

  const applyProductionSceneDrafts = (drafts: ProductionSceneDraft[], activeDraft: ProductionSceneDraft) => {
    const activeVisibleIds = new Set(activeDraft.scene.visibleOverlayIds);
    const nextLowerThirds = drafts.flatMap((draft) => (
      draft.lowerThird ? [{ ...draft.lowerThird, visible: activeVisibleIds.has(draft.lowerThird.id) }] : []
    ));
    const nextBanners = drafts.flatMap((draft) => (
      draft.banner ? [{ ...draft.banner, visible: activeVisibleIds.has(draft.banner.id) }] : []
    ));
    const nextTimers = drafts.flatMap((draft) => (
      draft.timer
        ? [{
          ...draft.timer,
          visible: activeVisibleIds.has(draft.timer.id),
          isRunning: activeVisibleIds.has(draft.timer.id) ? draft.timer.isRunning : false,
        }]
        : []
    ));
    const nextTickers = drafts.flatMap((draft) => (
      draft.ticker ? [{ ...draft.ticker, visible: activeVisibleIds.has(draft.ticker.id) }] : []
    ));

    applyLayout(activeDraft.config.layout);
    setStageBackground(activeDraft.scene.background);
    setBrandColor(activeDraft.scene.brandColor || activeDraft.config.brandColor);
    setLogoUrl(activeDraft.scene.logoUrl || null);
    setCameraShape(activeDraft.config.cameraShape);
    setNameTagStyle(activeDraft.config.nameTagStyle);
    setLogoPlacement(activeDraft.scene.logoPlacement || 'top-right');
    setLogoPosition(normalizeLogoPosition(activeDraft.scene.logoPosition));
    setLogoSize(activeDraft.scene.logoSize || 'medium');
    setLogoOpacity(normalizeLogoOpacity(activeDraft.scene.logoOpacity));
    setPipCorner('BR');
    setFocusedVideoItemId(null);
    setStageItemOrder([]);
    setActiveMedia(null);
    setActiveMediaSlideIndex(0);
    setLowerThirds(prev => [...prev.map(o => ({ ...o, visible: false })), ...nextLowerThirds]);
    setBanners(prev => [...prev.map(b => ({ ...b, visible: false })), ...nextBanners]);
    setTimers(prev => [...prev.map(t => ({ ...t, visible: false, isRunning: false })), ...nextTimers]);
    setTickers(prev => [...prev.map(t => ({ ...t, visible: false })), ...nextTickers]);
    setWidgets(prev => prev.map(widget => ({ ...widget, visible: false })));
    setActiveSceneId(activeDraft.scene.id);
    triggerSceneTransition(activeDraft.scene);
  };

  const onCreateTemplateScene = async (template: ProductionSceneTemplate) => {
    if (scenes.length >= MAX_STUDIO_SCENES) return;
    const draft = await buildProductionSceneDraft(template);

    setScenes(prev => prev.length >= MAX_STUDIO_SCENES ? prev : [...prev, draft.scene]);
    applyProductionSceneDrafts([draft], draft);
    setScenePackMessage(null);
  };

  const onCreateProductionScenePack = async () => {
    const templateIds = getProductionScenePackTemplateIds(MAX_STUDIO_SCENES - scenes.length);
    if (templateIds.length === 0) {
      setScenePackMessage('Maximum scenes reached.');
      return;
    }

    const drafts = await Promise.all(templateIds.map((template) => buildProductionSceneDraft(template)));
    const activeDraft = drafts[0];
    setScenes(prev => {
      const slots = Math.max(0, MAX_STUDIO_SCENES - prev.length);
      return slots === 0 ? prev : [...prev, ...drafts.slice(0, slots).map((draft) => draft.scene)];
    });
    applyProductionSceneDrafts(drafts, activeDraft);
    setScenePackMessage(`Added ${drafts.length} production scene${drafts.length === 1 ? '' : 's'}.`);
  };

  const onApplyScene = (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return;
    applyLayout(scene.layout);
    setStageBackground(scene.background);
    setBrandColor(scene.brandColor || '#a78bfa');
    setLogoUrl(scene.logoUrl || null);
    setCameraShape(scene.cameraShape || 'rectangle');
    setNameTagStyle(scene.nameTagStyle || 'classic');
    setLogoPlacement(scene.logoPlacement || 'top-right');
    setLogoPosition(normalizeLogoPosition(scene.logoPosition));
    setLogoSize(scene.logoSize || 'medium');
    setLogoOpacity(normalizeLogoOpacity(scene.logoOpacity));
    setPipCorner(getScenePipCornerForApply(scene));
    setStageItemOrder(getSceneStageItemOrderForApply(scene, availableStageItemIds));
    setFocusedVideoItemId(
      scene.focusedVideoItemId && availableStageItemIds.includes(scene.focusedVideoItemId)
        ? scene.focusedVideoItemId
        : null
    );
    const nextSceneMedia = getSceneActiveMediaForApply(scene, mediaAssets);
    setActiveMedia(nextSceneMedia.activeMedia);
    setActiveMediaSlideIndex(nextSceneMedia.slideIndex);
    // Restore overlay visibility from saved scene
    const visibleIds = new Set(scene.visibleOverlayIds);
    setLowerThirds(prev => prev.map(o => ({ ...o, visible: visibleIds.has(o.id) })));
    setBanners(prev => prev.map(b => ({ ...b, visible: visibleIds.has(b.id) })));
    setTimers(prev => prev.map(t => ({ ...t, visible: visibleIds.has(t.id), isRunning: visibleIds.has(t.id) ? t.isRunning : false })));
    setTickers(prev => prev.map(t => ({ ...t, visible: visibleIds.has(t.id) })));
    setWidgets(prev => prev.map(widget => ({ ...widget, visible: visibleIds.has(widget.id) })));
    setActiveSceneId(sceneId);
    triggerSceneTransition(scene);
  };
  const onDeleteScene = (sceneId: string) => {
    setScenes(prev => prev.filter(s => s.id !== sceneId));
    if (activeSceneId === sceneId) setActiveSceneId(null);
  };
  const onRenameScene = (sceneId: string, newName: string) => {
    setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, name: newName } : s));
  };
  const onUpdateScene = async (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return;
    const updatedScene = await buildCurrentSceneSnapshot(sceneId, scene.name);
    setScenes(prev => {
      const currentScene = prev.find(s => s.id === sceneId);
      if (!currentScene) return prev;
      return replaceSceneInOrder(prev, sceneId, { ...updatedScene, name: currentScene.name });
    });
  };
  const onDuplicateScene = (sceneId: string) => {
    if (scenes.length >= MAX_STUDIO_SCENES) return;
    const duplicateId = `scene-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setScenes(prev => (
      prev.length >= MAX_STUDIO_SCENES
        ? prev
        : duplicateSceneInOrder(prev, sceneId, duplicateId)
    ));
  };
  const onReorderScene = (sceneId: string, direction: SceneOrderDirection) => {
    setScenes(prev => moveSceneInOrder(prev, sceneId, direction));
  };
  const onExportScenePack = () => {
    if (scenes.length === 0) {
      setScenePackMessage('Save a scene before exporting.');
      return;
    }

    const pack = buildScenePack({
      scenes: getPersistableScenes(scenes, mediaAssets),
      lowerThirds,
      banners,
      timers,
      tickers,
      widgets,
    });

    downloadJsonFile(
      buildScenePackFilename(room?.name || 'Studio'),
      JSON.stringify(pack, null, 2)
    );
    setScenePackMessage(`Exported ${pack.scenes.length} scene${pack.scenes.length === 1 ? '' : 's'}.`);
  };
  const onImportScenePack = async (file: File) => {
    if (file.size > MAX_SCENE_PACK_BYTES) {
      setScenePackMessage('Scene pack file is too large.');
      return;
    }

    try {
      const text = await file.text();
      if (text.length > MAX_SCENE_PACK_BYTES) {
        setScenePackMessage('Scene pack file is too large.');
        return;
      }

      const pack = parseScenePackJson(text);
      const imported = importScenePack(pack, {
        existingScenes: scenes,
        maxScenes: MAX_STUDIO_SCENES,
        sceneIdFactory: (_scene, index) => `scene-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        overlayIdFactory: (kind: ScenePackOverlayKind) => {
          switch (kind) {
            case 'lowerThird':
              return `lt-${++idCounters.current.lt}`;
            case 'banner':
              return `banner-${++idCounters.current.banner}`;
            case 'timer':
              return `timer-${++idCounters.current.timer}`;
            case 'ticker':
              return `ticker-${++idCounters.current.ticker}`;
            case 'widget':
              return `widget-${++idCounters.current.widget}`;
            default:
              return assertNever(kind);
          }
        },
      });

      if (imported.importedScenes === 0) {
        setScenePackMessage('Maximum scenes reached.');
        return;
      }

      setLowerThirds(prev => [...prev, ...imported.lowerThirds]);
      setBanners(prev => [...prev, ...imported.banners]);
      setTimers(prev => [...prev, ...imported.timers]);
      setTickers(prev => [...prev, ...imported.tickers]);
      setWidgets(prev => [...prev, ...imported.widgets]);
      setScenes(prev => [...prev, ...imported.scenes].slice(0, MAX_STUDIO_SCENES));
      setScenePackMessage(
        `Imported ${imported.importedScenes} scene${imported.importedScenes === 1 ? '' : 's'}${imported.skippedScenes ? `, skipped ${imported.skippedScenes}` : ''}.`
      );
    } catch (err) {
      setScenePackMessage(err instanceof Error ? err.message : 'Could not import scene pack.');
    }
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

  // Widget overlays
  const onAddWidget = (widget: Omit<WidgetOverlayData, 'id' | 'visible'> & { visible?: boolean }) => {
    setWidgets(prev => [...prev, { ...widget, id: `widget-${++idCounters.current.widget}`, visible: widget.visible ?? false }]);
  };
  const onToggleWidget = (id: string) => {
    setWidgets(prev => prev.map(widget => ({ ...widget, visible: widget.id === id ? !widget.visible : widget.visible })));
  };
  const onRemoveWidget = (id: string) => {
    setWidgets(prev => prev.filter(widget => widget.id !== id));
  };

  // Comment highlighting
  const onHighlightComment = (comment: HighlightedComment) => {
    setHighlightedComment({
      ...comment,
      displayMode: 'featured',
    });
  };
  const onFlashComment = (comment: HighlightedComment) => {
    setHighlightedComment({
      ...comment,
      displayMode: 'flash',
    });
  };
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
    const items: StageVideoItem[] = [];
    if (myParticipant && myParticipant.status === 'on-stage') {
      items.push({ id: myParticipant.id, name: myParticipant.name, stream: localStream, isLocal: true, audioEnabled: effectiveAudioEnabled, videoEnabled: effectiveVideoEnabled, volume: participantVolumes[myParticipant.id] ?? 1 });
      // Add local screen share as a separate tile
      if (isScreenSharing && screenStream) {
        items.push({ id: `${myParticipant.id}-screen`, name: `${myParticipant.name}'s Screen`, stream: screenStream, isLocal: true, audioEnabled: false, videoEnabled: true, volume: 1, isScreenShare: true });
      }
    }
    for (const [id, p] of participants) {
      if (p.status === 'on-stage') {
        items.push({ id, name: p.screenSharing ? `${p.name}'s screen` : p.name, stream: remoteStreams.get(id) || null, isLocal: false, audioEnabled: p.screenSharing ? false : p.audioEnabled, videoEnabled: p.screenSharing ? true : p.videoEnabled, volume: participantVolumes[id] ?? 1, isScreenShare: p.screenSharing || false, connectionHealth: peerBandwidthHealth.get(id) || null });
      }
    }
    return items;
  }, [myParticipant, participants, localStream, effectiveAudioEnabled, effectiveVideoEnabled, remoteStreams, isScreenSharing, screenStream, participantVolumes, peerBandwidthHealth]);

  const localPresenterCameraItem = useMemo((): StageVideoItem | null => {
    if (!myParticipant || !isStudioOperator(myParticipant) || myParticipant.status === 'green-room') return null;
    return {
      id: myParticipant.id,
      name: myParticipant.name,
      stream: localStream,
      isLocal: true,
      audioEnabled: effectiveAudioEnabled,
      videoEnabled: effectiveVideoEnabled,
      volume: participantVolumes[myParticipant.id] ?? 1,
    };
  }, [myParticipant, localStream, effectiveAudioEnabled, effectiveVideoEnabled, participantVolumes]);

  const localPresenterScreenItem = useMemo((): StageVideoItem | null => {
    if (!myParticipant || !isStudioOperator(myParticipant) || myParticipant.status === 'green-room') return null;
    if (!isScreenSharing || !screenStream) return null;
    return {
      id: `${myParticipant.id}-screen`,
      name: `${myParticipant.name}'s Screen`,
      stream: screenStream,
      isLocal: true,
      audioEnabled: false,
      videoEnabled: true,
      volume: 1,
      isScreenShare: true,
    };
  }, [myParticipant, isScreenSharing, screenStream]);

  const backstagePrivateItems = useMemo(() => {
    if (!myParticipant || myParticipant.status === 'green-room') return [];

    const items: StageVideoItem[] = [];
    if (myParticipant.status === 'backstage') {
      items.push({
        id: myParticipant.id,
        name: myParticipant.name,
        stream: localStream,
        isLocal: true,
        audioEnabled: effectiveAudioEnabled,
        videoEnabled: effectiveVideoEnabled,
        volume: participantVolumes[myParticipant.id] ?? 1,
      });
    }

    for (const [id, participant] of participants) {
      if (!canExchangeStudioMedia(myParticipant, participant)) continue;
      if (participant.status !== 'backstage' && !isStudioOperator(participant)) continue;

      items.push({
        id,
        name: participant.status === 'backstage' ? participant.name : `${participant.name} (${participant.role})`,
        stream: remoteStreams.get(id) || null,
        isLocal: false,
        audioEnabled: participant.screenSharing ? false : participant.audioEnabled,
        videoEnabled: participant.videoEnabled || participant.screenSharing,
        volume: participantVolumes[id] ?? 1,
        isScreenShare: participant.screenSharing || false,
        connectionHealth: peerBandwidthHealth.get(id) || null,
      });
    }

    return items;
  }, [myParticipant, participants, localStream, effectiveAudioEnabled, effectiveVideoEnabled, remoteStreams, participantVolumes, peerBandwidthHealth]);

  const availableStageItemIds = useMemo(() => videoItems.map((item) => item.id), [videoItems]);

  useEffect(() => {
    setStageItemOrder((current) => normalizeStageItemOrder(current, availableStageItemIds));
  }, [availableStageItemIds]);

  useEffect(() => {
    const activeIds = new Set(availableStageItemIds);
    setStageAudioLevels((current) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [participantId, level] of Object.entries(current)) {
        if (activeIds.has(participantId)) {
          next[participantId] = level;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [availableStageItemIds]);

  const orderedVideoItems = useMemo(() => (
    applyStageItemOrder(videoItems, stageItemOrder, focusedVideoItemId)
  ), [videoItems, stageItemOrder, focusedVideoItemId]);

  const displayedStageVideoItems = useMemo(() => {
    if (activeMedia && localPresenterCameraItem) {
      return mergeSharedMediaParticipantItems(orderedVideoItems, [localPresenterCameraItem], 1);
    }

    if (isScreenSharing) {
      const fallbackItems = [localPresenterCameraItem, localPresenterScreenItem].filter(
        (item): item is StageVideoItem => Boolean(item)
      );
      return mergeSharedMediaParticipantItems(orderedVideoItems, fallbackItems, 2);
    }

    return orderedVideoItems;
  }, [activeMedia, orderedVideoItems, localPresenterCameraItem, isScreenSharing, localPresenterScreenItem]);

  const [stagePresenceItems, setStagePresenceItems] = useState<Array<StagePresenceTrackedItem<StageVideoItem>>>([]);
  const displayedStageVideoItemsRef = useRef<StageVideoItem[]>([]);

  useEffect(() => {
    displayedStageVideoItemsRef.current = displayedStageVideoItems;
    setStagePresenceItems((current) => reconcileStagePresenceItems(displayedStageVideoItems, current, Date.now()));
  }, [displayedStageVideoItems]);

  useEffect(() => {
    const delayMs = getStagePresenceTransitionDelayMs(stagePresenceItems, Date.now());
    if (!delayMs) return;

    const timer = window.setTimeout(() => {
      setStagePresenceItems((current) => reconcileStagePresenceItems(displayedStageVideoItemsRef.current, current, Date.now()));
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [stagePresenceItems]);

  const renderedVideoItems = useMemo(() => (
    stagePresenceItems.map((presence) => presence.item)
  ), [stagePresenceItems]);

  const screenShareStageSplit = useMemo(() => {
    let screenShareItem: StagePresenceTrackedItem<StageVideoItem> | null = null;
    const participantItems: Array<StagePresenceTrackedItem<StageVideoItem>> = [];

    for (const presence of stagePresenceItems) {
      if (presence.item.isScreenShare) {
        screenShareItem = screenShareItem || presence;
        continue;
      }
      participantItems.push(presence);
    }

    return { screenShareItem, participantItems };
  }, [stagePresenceItems]);

  const sharedContentScreenShare = !activeMedia ? screenShareStageSplit.screenShareItem : null;
  const sharedContentParticipantPresenceItems = activeMedia || sharedContentScreenShare
    ? screenShareStageSplit.participantItems
    : stagePresenceItems;
  const sharedContentIsActive = Boolean(activeMedia || sharedContentScreenShare);
  const sharedContentStageItemCount = sharedContentParticipantPresenceItems.length + (sharedContentIsActive ? 1 : 0);

  useEffect(() => {
    if (focusedVideoItemId && !videoItems.some((item) => item.id === focusedVideoItemId)) {
      setFocusedVideoItemId(null);
    }
  }, [focusedVideoItemId, videoItems]);

  const moveStageItem = useCallback((itemId: string, direction: StageItemOrderDirection) => {
    setStageItemOrder((current) => moveStageItemInOrder(current, availableStageItemIds, itemId, direction));
  }, [availableStageItemIds]);

  const onStageTileDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, itemId: string) => {
    if (!isHostOrCoHost || !availableStageItemIds.includes(itemId)) return;
    setDraggedStageItemId(itemId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', itemId);
  }, [availableStageItemIds, isHostOrCoHost]);

  const onStageTileDragOver = useCallback((event: React.DragEvent<HTMLDivElement>, targetItemId: string) => {
    if (!draggedStageItemId || draggedStageItemId === targetItemId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setStageDropTargetId(targetItemId);
  }, [draggedStageItemId]);

  const clearStageDragState = useCallback(() => {
    setDraggedStageItemId(null);
    setStageDropTargetId(null);
  }, []);

  const onStageTileDrop = useCallback((event: React.DragEvent<HTMLDivElement>, targetItemId: string) => {
    const draggedItemId = event.dataTransfer.getData('text/plain') || draggedStageItemId;
    if (!draggedItemId || draggedItemId === targetItemId) {
      clearStageDragState();
      return;
    }

    event.preventDefault();
    setStageItemOrder((current) => reorderStageItemBefore(current, availableStageItemIds, draggedItemId, targetItemId));
    clearStageDragState();
  }, [availableStageItemIds, clearStageDragState, draggedStageItemId]);

  const onSpotlightParticipant = useCallback((participantId: string | null) => {
    if (!participantId) {
      setFocusedVideoItemId(null);
      return;
    }
    if (!availableStageItemIds.includes(participantId)) return;

    setStageItemOrder((current) => moveStageItemInOrder(current, availableStageItemIds, participantId, 'first'));
    setFocusedVideoItemId(participantId);
    applyLayout(availableStageItemIds.length > 1 ? 'spotlight' : 'single');
  }, [applyLayout, availableStageItemIds]);

  const [autoDirectorEnabled, setAutoDirectorEnabled] = useState(false);
  const activeSpeakerTrackerRef = useRef(createActiveSpeakerTracker());
  const stageAudioLevelsRef = useRef<Record<string, number>>({});
  const autoDirectorTargetsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    stageAudioLevelsRef.current = stageAudioLevels;
  }, [stageAudioLevels]);

  useEffect(() => {
    autoDirectorTargetsRef.current = new Set(availableStageItemIds);
  }, [availableStageItemIds]);

  useEffect(() => {
    if (!autoDirectorEnabled || !isHostOrCoHost) return;
    activeSpeakerTrackerRef.current.reset();
    const interval = window.setInterval(() => {
      const targets = autoDirectorTargetsRef.current;
      if (targets.size < 2) return;
      const levels = stageAudioLevelsRef.current;
      const scoped: Record<string, number> = {};
      for (const id of targets) {
        scoped[id] = levels[id] || 0;
      }
      const nextActive = activeSpeakerTrackerRef.current.update(scoped, Date.now());
      if (nextActive) onSpotlightParticipant(nextActive);
    }, 300);
    return () => window.clearInterval(interval);
  }, [autoDirectorEnabled, isHostOrCoHost, onSpotlightParticipant]);

  const [showShortcutHelp, setShowShortcutHelp] = useState(false);

  useEffect(() => {
    if (!isHostOrCoHost) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (shouldIgnoreShortcutTarget(event.target as { tagName?: string; isContentEditable?: boolean } | null)) return;
      const shortcutId = resolveShortcutId(event);
      if (!shortcutId) return;
      switch (shortcutId) {
        case 'layout-grid': applyLayout('grid'); break;
        case 'layout-spotlight': applyLayout('spotlight'); break;
        case 'layout-side-by-side': applyLayout('side-by-side'); break;
        case 'layout-pip': applyLayout('pip'); break;
        case 'layout-single': applyLayout('single'); break;
        case 'toggle-auto-director': setAutoDirectorEnabled((current) => !current); break;
        case 'toggle-mic': onToggleAudio(); break;
        case 'toggle-camera': onToggleVideo(); break;
        case 'show-shortcuts': setShowShortcutHelp((current) => !current); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [applyLayout, isHostOrCoHost, onToggleAudio, onToggleVideo]);

  const onStageTilePrimaryClick = useCallback((itemId: string, action: ReturnType<typeof getStageTilePrimaryClickAction>) => {
    if (action === 'cycle-pip-corner') {
      setPipCorner((prev) => {
        const order: Array<'TL' | 'TR' | 'BR' | 'BL'> = ['TL', 'TR', 'BR', 'BL'];
        return order[(order.indexOf(prev) + 1) % 4];
      });
      return;
    }

    if (action === 'spotlight') {
      onSpotlightParticipant(itemId);
      return;
    }

    if (action === 'clear-spotlight') {
      onSpotlightParticipant(null);
    }
  }, [onSpotlightParticipant]);

  // Auto-switch layout when participant count changes
  useEffect(() => {
    // Layouts requiring >= 2 participants
    if (sharedContentStageItemCount < 2 && (layout === 'spotlight' || layout === 'featured' || layout === 'side-by-side' || layout === 'pip')) {
      applyLayout(sharedContentStageItemCount === 1 ? 'single' : 'grid');
    }
    // Single layout with multiple participants should switch to grid
    if (!sharedContentIsActive && displayedStageVideoItems.length > 1 && layout === 'single') {
      applyLayout('grid');
    }
  }, [applyLayout, displayedStageVideoItems.length, layout, sharedContentIsActive, sharedContentStageItemCount]);

  // All participants for the manager - memoized
  const allParticipantsMap = useMemo(() => {
    const map = new Map<string, Participant>();
    if (myParticipant) map.set(myParticipant.id, myParticipant);
    for (const [id, p] of participants) {
      map.set(id, p);
    }
    return map;
  }, [myParticipant, participants]);
  const publicChatTypingNames = useMemo(
    () => getChatTypingNames(chatTypingIndicators, 'public'),
    [chatTypingIndicators]
  );
  const directChatTypingNames = useMemo(
    () => getChatTypingNames(chatTypingIndicators, 'direct'),
    [chatTypingIndicators]
  );
  const backstageChatTypingNames = useMemo(
    () => getChatTypingNames(chatTypingIndicators, 'backstage'),
    [chatTypingIndicators]
  );
  const guestChatTypingNames = useMemo(
    () => Array.from(new Set([...publicChatTypingNames, ...directChatTypingNames])),
    [directChatTypingNames, publicChatTypingNames]
  );

  // Stage background style - memoized
  const stageBackgroundStyle = useMemo((): React.CSSProperties => {
    return getStageBackgroundStyle(stageBackground);
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

  type MediaShareLayoutResult = {
    containerStyle: React.CSSProperties;
    mediaStyle: React.CSSProperties;
    participantStyles: React.CSSProperties[];
    visibleParticipantCount: number;
    placement: MediaShareParticipantPlacement;
    usesFloatingParticipant: boolean;
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

  const getMediaShareLayout = useCallback((count: number, selectedLayout: LayoutMode): MediaShareLayoutResult => {
    const plan = getMediaShareLayoutPlan(selectedLayout, count);
    const visibleCount = plan.visibleParticipantCount;
    const fullMediaStyle: React.CSSProperties = {
      width: '100%',
      height: '100%',
      minWidth: 0,
      minHeight: 0,
    };

    if (visibleCount <= 0) {
      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: '1fr',
          gridTemplateRows: '1fr',
          gap: GAP,
          alignItems: 'stretch',
          justifyItems: 'stretch',
        },
        mediaStyle: {
          ...fullMediaStyle,
          gridColumn: '1',
          gridRow: '1',
        },
        participantStyles: [],
        visibleParticipantCount: 0,
        placement: plan.placement,
        usesFloatingParticipant: false,
      };
    }

    if (plan.placement === 'pip') {
      const getPipPosition = (index: number): React.CSSProperties => {
        const tileOffset = visibleCount >= 3 ? '18%' : visibleCount === 2 ? '21%' : '24%';
        const clusterGap = '12px';
        const column = visibleCount >= 3 ? index % 2 : 0;
        const row = visibleCount >= 3 ? Math.floor(index / 2) : index;
        const inlineOffset = column === 0 ? 20 : `calc(20px + ${tileOffset} + ${clusterGap})`;
        const blockOffset = row === 0 ? 20 : `calc(20px + ${tileOffset} + ${clusterGap})`;
        switch (pipCorner) {
          case 'TL':
            return { top: blockOffset, left: inlineOffset };
          case 'TR':
            return { top: blockOffset, right: inlineOffset };
          case 'BL':
            return { bottom: blockOffset, left: inlineOffset };
          case 'BR':
            return { bottom: blockOffset, right: inlineOffset };
        }
      };
      const tileWidth = visibleCount >= 3 ? '18%' : visibleCount > 1 ? '21%' : '24%';

      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: '1fr',
          gridTemplateRows: '1fr',
          gap: GAP,
          position: 'relative' as const,
          overflow: 'hidden',
          alignItems: 'stretch',
          justifyItems: 'stretch',
        },
        mediaStyle: {
          ...fullMediaStyle,
          gridColumn: '1',
          gridRow: '1',
        },
        participantStyles: Array.from({ length: visibleCount }, (_, i) => ({
          position: 'absolute' as const,
          ...getPipPosition(i),
          width: tileWidth,
          aspectRatio: '16 / 9',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.5)',
          border: '2px solid rgba(255, 255, 255, 0.15)',
          zIndex: 6,
          flexShrink: 0,
          flexGrow: 0,
          cursor: 'pointer',
          transition: 'top 0.3s ease, bottom 0.3s ease, left 0.3s ease, right 0.3s ease',
        })),
        visibleParticipantCount: visibleCount,
        placement: plan.placement,
        usesFloatingParticipant: true,
      };
    }

    if (plan.placement === 'floating-stack') {
      const spacing = visibleCount <= 1 ? 0 : Math.min(19, 64 / visibleCount);
      const start = 50 - ((visibleCount - 1) * spacing) / 2;
      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: '1fr',
          gridTemplateRows: '1fr',
          gap: GAP,
          position: 'relative' as const,
          overflow: 'hidden',
          alignItems: 'stretch',
          justifyItems: 'stretch',
        },
        mediaStyle: {
          ...fullMediaStyle,
          gridColumn: '1',
          gridRow: '1',
        },
        participantStyles: Array.from({ length: visibleCount }, (_, i) => ({
          position: 'absolute' as const,
          right: 22,
          top: `${start + i * spacing}%`,
          transform: 'translateY(-50%)',
          width: visibleCount > 2 ? '18%' : '22%',
          aspectRatio: '16 / 9',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 6px 28px rgba(0, 0, 0, 0.52)',
          border: '2px solid rgba(255, 255, 255, 0.16)',
          zIndex: 6,
          flexShrink: 0,
          flexGrow: 0,
          cursor: 'pointer',
          transition: 'top 0.3s ease, right 0.3s ease, transform 0.3s ease',
        })),
        visibleParticipantCount: visibleCount,
        placement: plan.placement,
        usesFloatingParticipant: true,
      };
    }

    if (plan.placement === 'side-by-side') {
      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(220px, 0.52fr)',
          gridTemplateRows: `repeat(${visibleCount}, minmax(0, 1fr))`,
          gap: GAP,
          alignItems: 'stretch',
          justifyItems: 'stretch',
        },
        mediaStyle: {
          ...fullMediaStyle,
          gridColumn: '1',
          gridRow: `1 / ${visibleCount + 1}`,
        },
        participantStyles: Array.from({ length: visibleCount }, (_, i) => ({
          gridColumn: '2',
          gridRow: `${i + 1}`,
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
        })),
        visibleParticipantCount: visibleCount,
        placement: plan.placement,
        usesFloatingParticipant: false,
      };
    }

    if (plan.placement === 'bottom-strip') {
      return {
        containerStyle: {
          ...containerBase,
          display: 'grid',
          gridTemplateColumns: `repeat(${visibleCount}, minmax(0, 1fr))`,
          gridTemplateRows: 'minmax(0, 1fr) minmax(82px, 0.22fr)',
          gap: GAP,
          alignItems: 'stretch',
          justifyItems: 'stretch',
        },
        mediaStyle: {
          ...fullMediaStyle,
          gridColumn: `1 / ${visibleCount + 1}`,
          gridRow: '1',
        },
        participantStyles: Array.from({ length: visibleCount }, (_, i) => ({
          gridColumn: `${i + 1}`,
          gridRow: '2',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
        })),
        visibleParticipantCount: visibleCount,
        placement: plan.placement,
        usesFloatingParticipant: false,
      };
    }

    return {
      containerStyle: {
        ...containerBase,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(160px, 0.28fr)',
        gridTemplateRows: `repeat(${visibleCount}, minmax(0, 1fr))`,
        gap: GAP,
        alignItems: 'center',
        justifyItems: 'stretch',
      },
      mediaStyle: {
        ...fullMediaStyle,
        gridColumn: '1',
        gridRow: `1 / ${visibleCount + 1}`,
      },
      participantStyles: Array.from({ length: visibleCount }, (_, i) => ({
        gridColumn: '2',
        gridRow: `${i + 1}`,
        width: '100%',
        aspectRatio: '16 / 9',
        alignSelf: 'center',
        minWidth: 0,
        minHeight: 0,
      })),
      visibleParticipantCount: visibleCount,
      placement: plan.placement,
      usesFloatingParticipant: false,
    };
  }, [pipCorner]);

  const layoutResult = useMemo((): LayoutResult => {
    const count = renderedVideoItems.length;
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
  }, [layout, renderedVideoItems.length, getAutoGridLayout, getSpotlightLayout, getFeaturedLayout]);

  const sharedContentLayoutResult = useMemo(() => (
    sharedContentIsActive
      ? getMediaShareLayout(sharedContentParticipantPresenceItems.length, layout)
      : null
  ), [getMediaShareLayout, layout, sharedContentIsActive, sharedContentParticipantPresenceItems.length]);

  // These must be called before any conditional returns to satisfy Rules of Hooks
  const visibleBanners = useMemo(() => banners.filter(b => b.visible), [banners]);
  const visibleTimers = useMemo(() => timers.filter(t => t.visible), [timers]);
  const visibleTickers = useMemo(() => tickers.filter(t => t.visible), [tickers]);
  const visibleWidgets = useMemo(() => widgets.filter(widget => widget.visible), [widgets]);
  const visibleLowerThird = useMemo(() => lowerThirds.find((lt) => lt.visible) || null, [lowerThirds]);
  const [displayedLowerThird, setDisplayedLowerThird] = useState<LowerThirdData | null>(null);
  const displayedLowerThirdRef = useRef<LowerThirdData | null>(null);
  const highlightedQA = useMemo(() => qaQuestions.find(q => q.highlighted) || null, [qaQuestions]);
  const highlightedPoll = useMemo(() => polls.find((poll) => poll.highlighted) || null, [polls]);
  const showCompositorDebug = import.meta.env.DEV && isLive;
  const recordingStatus = getStudioRecordingStatus({
    mixRecording: isRecording,
    mixPaused: isRecordingPaused,
    mixFormattedTime: formattedTime,
    localRecording: isLocalRecording,
    localPaused: isLocalRecordingPaused,
    localFormattedTime: localRecFormattedTime,
    sessionStartedAt: sessionRecordingStartedAt,
    sessionElapsedSeconds: sessionRecordingElapsed,
  });
  const liveStatus = getLiveStreamStatus({
    live: isLive,
    startedAt: liveStartedAt,
    elapsedSeconds: liveElapsed,
  });
  const productionExitGuard = useMemo(() => getProductionExitGuardDecision({
    isLive,
    isMixedRecording: isRecording,
    isLocalRecording,
    isSessionRecording: Boolean(sessionRecordingStartedAt),
  }), [isLive, isRecording, isLocalRecording, sessionRecordingStartedAt]);

  useEffect(() => {
    if (!productionExitGuard.shouldBlock) return undefined;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = productionExitGuard.message;
      return productionExitGuard.message;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [productionExitGuard]);

  useEffect(() => {
    displayedLowerThirdRef.current = displayedLowerThird;
  }, [displayedLowerThird]);

  useEffect(() => {
    if (visibleLowerThird) {
      setDisplayedLowerThird(visibleLowerThird);
      return;
    }

    const outgoing = displayedLowerThirdRef.current;
    if (!outgoing) return;

    setDisplayedLowerThird({ ...outgoing, visible: false });
    const timer = window.setTimeout(() => {
      setDisplayedLowerThird((current) => current && !current.visible ? null : current);
    }, LOWER_THIRD_ANIMATION_EXIT_MS);

    return () => window.clearTimeout(timer);
  }, [visibleLowerThird]);

  // Connection error
  if (connectionError) {
    const passwordError = connectionError === 'This room requires a password' || connectionError === 'Incorrect room password';
    const hostAccessError = connectionError.includes('Host access is missing or expired');
    const joinRecoverableError =
      passwordError ||
      hostAccessError ||
      connectionError === 'Co-host invite link is invalid or expired' ||
      connectionError === 'Guest invite link is invalid or expired';
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
  const effectiveStudioBranding = remoteStudioBranding;
  const effectiveWaitingRoomBranding = normalizeWaitingRoomBranding(effectiveStudioBranding?.waitingRoom || waitingRoomBranding);
  const waitingBrandColor = effectiveStudioBranding?.brandColor || brandColor;
  const waitingStageBackground = effectiveStudioBranding?.stageBackground || stageBackground;
  const waitingLogoUrl = effectiveWaitingRoomBranding.showLogo ? (effectiveStudioBranding?.logoUrl ?? logoUrl) : null;
  const waitingRoomBackgroundStyle = getWaitingRoomBackgroundStyle(
    effectiveWaitingRoomBranding.backgroundMode,
    waitingStageBackground,
    waitingBrandColor
  );
  const holdTitle = offStageGuestStatus === 'backstage' ? "You're backstage" : effectiveWaitingRoomBranding.headline;
  const holdText = offStageGuestStatus === 'backstage'
    ? 'You are off the broadcast stage. The host can bring you back live when ready.'
    : effectiveWaitingRoomBranding.message;

  if (isHeldOffStageGuest) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <div style={styles.logoMark}>
              {waitingLogoUrl ? (
                <img src={waitingLogoUrl} alt="" style={styles.waitingLogoMarkImg} />
              ) : (
                <span style={{ ...styles.waitingLogoFallback, background: waitingBrandColor }} />
              )}
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

        <div style={{ ...styles.waitingMain, ...waitingRoomBackgroundStyle }}>
          <div style={styles.waitingStack}>
            <div style={styles.waitingShell}>
              <div style={{ ...styles.waitingPreview, borderColor: `${waitingBrandColor}55` }}>
                <VideoTile
                  stream={localStream}
                  name={myParticipant?.name || userName}
                  isLocal
                  audioEnabled={effectiveAudioEnabled}
                  videoEnabled={effectiveVideoEnabled}
                  brandColor={waitingBrandColor}
                  cameraShape={cameraShape}
                  nameTagStyle={nameTagStyle}
                />
              </div>
              <div style={styles.waitingCopy}>
                {waitingLogoUrl && <img src={waitingLogoUrl} alt="" style={styles.waitingHeroLogo} />}
                <span style={{ ...styles.waitingKicker, color: waitingBrandColor }}>{holdKicker}</span>
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

            {offStageGuestStatus === 'backstage' && backstagePrivateItems.length > 1 && (
              <BackstagePrivateRoom
                items={backstagePrivateItems}
                brandColor={waitingBrandColor}
                cameraShape={cameraShape}
                nameTagStyle={nameTagStyle}
              />
            )}
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
          roomName={room?.name || 'Studio'}
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
            onTypingChange={(typing) => onChatTypingChange(typing, true)}
            onClose={() => setShowGuestChat(false)}
            senderName={userName}
            typingUsers={backstageChatTypingNames}
            title="Backstage Chat"
            placeholder="Send a backstage note..."
            emptyText="No backstage notes yet"
            emptyHint="Coordinate with the host and backstage guests."
          />
        )}

        {showHealthPanel && (
          <SessionHealthPanel
            summary={sessionHealth}
            meshCapacity={meshCapacity}
            sfuMediaStatus={sfuTransportStatus}
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
            audioProcessing={audioProcessing}
            onAudioProcessingChange={onAudioProcessingChange}
            videoQuality={videoQuality}
            recommendedVideoQuality={recommendedVideoQuality}
            onVideoQualityChange={onVideoQualityChange}
            onClose={() => setShowDeviceSettings(false)}
            virtualBackground={vbConfig}
            onVirtualBackgroundChange={onVirtualBackgroundChange}
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
          {recordingStatus.active && (
            <span style={styles.recBadge}>
              <span style={styles.recDot} />
              {recordingStatus.paused ? 'PAUSED' : 'REC'} {recordingStatus.formattedTime}
            </span>
          )}
          {liveStatus.active && (
            <span style={styles.liveBadge}>
              <span style={styles.liveBadgeDot} />
              LIVE {liveStatus.formattedTime}
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

      {(guestNotification || (isHostOrCoHost && liveSessionSummary)) && (
        <div style={styles.studioNoticeWrap} role="status" aria-live="polite">
          {guestNotification && (
            <div style={{
              ...styles.waitingNotice,
              ...styles.studioNotice,
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
          {isHostOrCoHost && liveSessionSummary && (
            <div style={{
              ...styles.waitingNotice,
              ...styles.studioNotice,
              ...(liveSessionSummary.tone === 'warning' ? styles.waitingNoticeWarning : styles.waitingNoticeSuccess),
            }}>
              <span style={styles.waitingNoticeIcon}>
                {liveSessionSummary.tone === 'warning' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                    <path d="M12 9v4" />
                    <path d="M12 17h.01" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
              <span style={styles.waitingNoticeCopy}>
                <strong style={styles.waitingNoticeTitle}>{liveSessionSummary.title}</strong>
                <span style={styles.waitingNoticeText}>{liveSessionSummary.message}</span>
                {liveSessionSummary.destinationOutcomes.length > 0 && (
                  <span style={styles.liveSummaryDestinations}>
                    {liveSessionSummary.destinationOutcomes.map((outcome) => (
                      <span key={outcome.id} style={styles.liveSummaryDestinationRow}>
                        <span
                          style={{
                            ...styles.liveSummaryDestinationDot,
                            ...(outcome.status === 'success'
                              ? styles.liveSummaryDestinationDotSuccess
                              : outcome.status === 'error'
                                ? styles.liveSummaryDestinationDotError
                                : styles.liveSummaryDestinationDotWarning),
                          }}
                        />
                        <span style={styles.liveSummaryDestinationName}>{outcome.name}</span>
                        <span style={{
                          ...styles.liveSummaryDestinationStatus,
                          ...(outcome.status === 'success'
                            ? styles.liveSummaryDestinationStatusSuccess
                            : outcome.status === 'error'
                              ? styles.liveSummaryDestinationStatusError
                              : styles.liveSummaryDestinationStatusWarning),
                        }}>
                          {outcome.label}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
                {liveBackupRecording && (
                  <span style={styles.waitingNoticeText}>{getLiveBackupNoticeText(liveBackupRecording)}</span>
                )}
              </span>
              {liveBackupRecording?.status === 'ready' && liveBackupRecording.downloadPath && (
                <button
                  type="button"
                  style={styles.noticeActionBtn}
                  onClick={onDownloadLiveBackupRecording}
                  disabled={liveBackupDownloading}
                >
                  {liveBackupDownloading ? 'Preparing...' : 'Download Backup'}
                </button>
              )}
              <button
                type="button"
                style={styles.noticeDismissBtn}
                onClick={() => setLiveSessionSummary(null)}
                aria-label="Dismiss stream summary"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

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
              {stageBackground.type === 'video' && stageBackground.value && (
                <video
                  key={stageBackground.value}
                  className="studio-stage-background-video"
                  src={stageBackground.value}
                  style={styles.stageBackgroundVideo}
                  autoPlay
                  muted
                  loop
                  playsInline
                  crossOrigin="anonymous"
                />
              )}
              <div
                style={{
                  ...styles.gridBase,
                  ...(sharedContentLayoutResult?.containerStyle || layoutResult.containerStyle),
                  ...getStageLayoutTransitionStyle(layoutTransition),
                  position: 'relative',
                }}
              >
                {activeMedia && (
                  <div
                    className="studio-active-media"
                    style={{
                      ...styles.mediaOverlay,
                      ...(sharedContentLayoutResult?.mediaStyle || {}),
                    }}
                  >
                    {activeMedia.preview?.kind === 'presentation-slides' ? (
                      <PresentationDeckStage
                        media={activeMedia}
                        slideIndex={activeMediaSlideIndex}
                        onSlideIndexChange={setActiveMediaSlideIndex}
                      />
                    ) : activeMedia.type === 'video' ? (
                      <video src={activeMedia.url} style={styles.mediaContent} autoPlay controls />
                    ) : activeMedia.type === 'image' ? (
                      <img src={activeMedia.url} alt={activeMedia.name} style={styles.mediaContent} />
                    ) : activeMedia.type === 'pdf' ? (
                      <object data={`${activeMedia.url}#view=FitH`} type="application/pdf" style={styles.mediaContent}>
                        <iframe src={`${activeMedia.url}#view=FitH`} style={styles.mediaContent} title={activeMedia.name} />
                      </object>
                    ) : (
                      <MediaDocumentCard media={activeMedia} />
                    )}
                    <button className="panel-close-btn" style={styles.mediaCloseBtn} onClick={onStopMedia} aria-label="Close shared media">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}
                {!activeMedia && sharedContentScreenShare && (
                  <div
                    className="studio-active-media"
                    style={{
                      ...styles.mediaOverlay,
                      ...(sharedContentLayoutResult?.mediaStyle || {}),
                      ...getStagePresenceWrapperStyle(sharedContentScreenShare.phase),
                    }}
                  >
                    <VideoTile
                      participantId={sharedContentScreenShare.item.id}
                      stream={sharedContentScreenShare.item.stream}
                      name={sharedContentScreenShare.item.name}
                      isLocal={sharedContentScreenShare.item.isLocal}
                      isScreenShare
                      audioEnabled={false}
                      videoEnabled={sharedContentScreenShare.item.videoEnabled}
                      volume={sharedContentScreenShare.item.volume}
                      brandColor={brandColor}
                      cameraShape={cameraShape}
                      nameTagStyle={nameTagStyle}
                      connectionHealth={sharedContentScreenShare.item.connectionHealth}
                    />
                  </div>
                )}

                {/* Render tiles based on layout engine */}
                {(() => {
                  const stageItemsForLayout = sharedContentIsActive
                    ? sharedContentParticipantPresenceItems
                    : stagePresenceItems;
                  const itemsToRender = selectVisibleStageItems(stageItemsForLayout, layout, {
                    mediaVisibleParticipantCount: sharedContentLayoutResult?.visibleParticipantCount,
                  });

                  return itemsToRender.map((presence, i) => {
                    const item = presence.item;
                    const isLeavingTile = presence.phase === 'leaving';
                    const isPipSmallTile = sharedContentLayoutResult?.usesFloatingParticipant || (layout === 'pip' && i === 1);
                    const isFocusedTile = !isLeavingTile && focusedVideoItemId === item.id;
                    const canFocusTile = !isLeavingTile && isHostOrCoHost && orderedVideoItems.length > 1;
                    const orderedIndex = orderedVideoItems.findIndex((orderedItem) => orderedItem.id === item.id);
                    const canMoveEarlier = canFocusTile && orderedIndex > 0;
                    const canMoveLater = canFocusTile && orderedIndex >= 0 && orderedIndex < orderedVideoItems.length - 1;
                    const canDragStageTile = canFocusTile && availableStageItemIds.includes(item.id);
                    const isDraggedStageTile = draggedStageItemId === item.id;
                    const isStageDropTarget = Boolean(draggedStageItemId && stageDropTargetId === item.id && draggedStageItemId !== item.id);
                    const primaryClickAction = getStageTilePrimaryClickAction({
                      canFocusTile,
                      isFocusedTile,
                      isPipSmallTile,
                      isLeavingTile,
                    });
                    return (
                      <div
                        key={item.id}
                        data-stage-item-id={item.id}
                        draggable={canDragStageTile}
                        style={{
                          ...styles.tileWrapper,
                          ...(isFocusedTile ? styles.tileWrapperFocused : {}),
                          ...(canDragStageTile ? styles.tileWrapperDraggable : {}),
                          ...(isDraggedStageTile ? styles.tileWrapperDragging : {}),
                          ...(isStageDropTarget ? styles.tileWrapperDropTarget : {}),
                          ...((sharedContentLayoutResult?.participantStyles[i] || layoutResult.tileStyles[i]) || {}),
                          ...getStagePresenceWrapperStyle(presence.phase),
                        }}
                        onDragStart={canDragStageTile ? (event) => onStageTileDragStart(event, item.id) : undefined}
                        onDragOver={canDragStageTile ? (event) => onStageTileDragOver(event, item.id) : undefined}
                        onDrop={canDragStageTile ? (event) => onStageTileDrop(event, item.id) : undefined}
                        onDragEnd={canDragStageTile ? clearStageDragState : undefined}
                        onDragLeave={canDragStageTile ? () => {
                          setStageDropTargetId((current) => current === item.id ? null : current);
                        } : undefined}
                        onClick={primaryClickAction !== 'none' ? () => onStageTilePrimaryClick(item.id, primaryClickAction) : undefined}
                        title={canDragStageTile
                          ? (isPipSmallTile ? 'Drag to reorder; click to move PiP position' : 'Click to spotlight; drag to reorder')
                          : isPipSmallTile && !isLeavingTile ? 'Click to move PiP position' : undefined}
                        aria-label={canDragStageTile ? `${item.name} stage tile. Click to spotlight or drag to reorder.` : undefined}
                      >
                        {canFocusTile && (
                          <div style={styles.tileControls}>
                            <button
                              type="button"
                              style={{ ...styles.focusTileBtn, ...(isFocusedTile ? styles.focusTileBtnActive : {}) }}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (isFocusedTile) {
                                  onSpotlightParticipant(null);
                                  return;
                                }
                                onSpotlightParticipant(item.id);
                              }}
                              aria-label={isFocusedTile ? `Clear main stage focus for ${item.name}` : `Make ${item.name} the main stage tile`}
                              title={isFocusedTile ? 'Clear main stage focus' : 'Make main stage tile'}
                            >
                              <svg width="15" height="15" viewBox="0 0 24 24" fill={isFocusedTile ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                              </svg>
                            </button>
                            {canMoveEarlier && (
                              <button
                                type="button"
                                style={styles.stageOrderBtn}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  moveStageItem(item.id, 'left');
                                }}
                                aria-label={`Move ${item.name} earlier in the stage order`}
                                title="Move earlier"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="m15 18-6-6 6-6" />
                                </svg>
                              </button>
                            )}
                            {canMoveLater && (
                              <button
                                type="button"
                                style={styles.stageOrderBtn}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  moveStageItem(item.id, 'right');
                                }}
                                aria-label={`Move ${item.name} later in the stage order`}
                                title="Move later"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="m9 18 6-6-6-6" />
                                </svg>
                              </button>
                            )}
                          </div>
                        )}
                        <VideoTile
                          participantId={item.id}
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
                          connectionHealth={item.connectionHealth}
                          onAudioLevelChange={isLeavingTile ? undefined : handleStageAudioLevelChange}
                        />
                      </div>
                    );
                  });
                })()}

                {/* Lower Third Overlay */}
                {displayedLowerThird && <LowerThirdOverlay key={displayedLowerThird.id} data={displayedLowerThird} />}

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

                {/* Widget Overlays */}
                {visibleWidgets.map((widget) => (
                  <WidgetOverlayDisplay key={widget.id} data={widget} />
                ))}

                {/* Comment Highlight Overlay */}
                <CommentHighlightOverlay comment={highlightedComment} onExpired={onDismissComment} />

                {/* Webinar Q&A Overlay */}
                <WebinarQAOverlay question={highlightedQA} />

                {/* Live Poll Overlay */}
                <LivePollOverlay poll={highlightedPoll} />

                {/* Floating Reaction Overlay */}
                <ReactionOverlay reactions={floatingReactions} />

                {/* Live Caption Overlay */}
                <LiveCaptionOverlay
                  caption={broadcastCaption}
                  brandColor={brandColor}
                  bottomOffset={captionBottomOffset}
                />
              </div>

              {/* Logo watermark */}
              {logoUrl && (
                <div
                  onPointerDown={handleLogoPointerDown}
                  style={{
                    ...styles.logoWatermark,
                    ...(logoPosition ? getCustomLogoPositionStyle(logoPosition) : getLogoPlacementStyle(logoPlacement)),
                    opacity: logoOpacity,
                    ...(canUseOperatorControls ? styles.logoWatermarkDraggable : {}),
                  }}
                >
                  <img src={logoUrl} alt="Logo" style={{ ...styles.logoWatermarkImg, ...getLogoSizeStyle(logoSize) }} />
                </div>
              )}

              {activeStreamScreen && (
                <div style={{ ...styles.streamScreenOverlay, ...activeStreamScreenBackgroundStyle }}>
                  <div style={styles.streamScreenScrim} />
                  <div style={styles.streamScreenContent}>
                    {activeStreamScreen.logoUrl && (
                      <img src={activeStreamScreen.logoUrl} alt="" style={styles.streamScreenLogo} />
                    )}
                    <span style={{ ...styles.streamScreenKicker, borderColor: `${activeStreamScreen.brandColor}99` }}>
                      {activeStreamScreen.kind === 'starting' ? 'Starting Soon' : 'Stream Ending'}
                    </span>
                    <h1 style={styles.streamScreenTitle}>{activeStreamScreen.headline}</h1>
                    <p style={styles.streamScreenMessage}>{activeStreamScreen.message}</p>
                    <span style={{ ...styles.streamScreenAccent, background: activeStreamScreen.brandColor }} />
                  </div>
                </div>
              )}

              {sceneTransition && (
                <div
                  data-testid="scene-transition-overlay"
                  role="status"
                  aria-live="polite"
                  aria-label={`Scene transition: ${sceneTransition.sceneName}`}
                  style={{
                    ...styles.sceneTransitionOverlay,
                    ...getSceneTransitionOverlayStyle({
                      presetId: sceneTransition.presetId,
                      visible: sceneTransition.visible,
                      durationMs: sceneTransition.durationMs,
                      brandColor,
                    }),
                  }}
                >
                  {sceneTransition.presetId === 'stinger' && sceneTransition.stingerClip ? (
                    <video
                      key={`${sceneTransition.sceneId}-${sceneTransition.stingerClip.url}`}
                      src={sceneTransition.stingerClip.url}
                      style={styles.sceneTransitionVideo}
                      autoPlay
                      muted
                      playsInline
                    />
                  ) : (
                    <span style={styles.sceneTransitionLabel}>{sceneTransition.sceneName}</span>
                  )}
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

          {isHostOrCoHost && backstagePrivateItems.length > 0 && (
            <BackstagePrivateRoom
              items={backstagePrivateItems}
              brandColor={brandColor}
              cameraShape={cameraShape}
              nameTagStyle={nameTagStyle}
              compact
            />
          )}

          {/* Floating layout switcher (like StreamYard) — below canvas */}
          {isHostOrCoHost && (
            <div style={styles.layoutBar}>
              <LayoutSwitcher
                currentLayout={layout}
                onLayoutChange={applyLayout}
                participantCount={sharedContentIsActive ? sharedContentStageItemCount : displayedStageVideoItems.length}
                isMediaActive={sharedContentIsActive}
                mediaParticipantCount={sharedContentIsActive ? sharedContentParticipantPresenceItems.length : undefined}
              />
              <button
                type="button"
                onClick={() => setAutoDirectorEnabled((current) => !current)}
                title="Auto-spotlight whoever is speaking"
                aria-pressed={autoDirectorEnabled}
                style={{
                  ...styles.autoDirectorBtn,
                  ...(autoDirectorEnabled ? styles.autoDirectorBtnActive : {}),
                }}
              >
                <span
                  style={{
                    ...styles.autoDirectorDot,
                    ...(autoDirectorEnabled ? styles.autoDirectorDotActive : {}),
                  }}
                />
                Auto
              </button>
              <button
                type="button"
                onClick={() => setShowShortcutHelp((current) => !current)}
                title="Keyboard shortcuts (press ?)"
                aria-label="Keyboard shortcuts"
                style={styles.shortcutHelpBtn}
              >
                ?
              </button>
            </div>
          )}

          {showShortcutHelp && isHostOrCoHost && (
            <div
              style={styles.shortcutOverlay}
              role="dialog"
              aria-label="Keyboard shortcuts"
              onClick={() => setShowShortcutHelp(false)}
            >
              <div style={styles.shortcutCard} onClick={(event) => event.stopPropagation()}>
                <div style={styles.shortcutCardHeader}>
                  <span style={styles.shortcutCardTitle}>Keyboard shortcuts</span>
                  <button type="button" style={styles.shortcutCloseBtn} onClick={() => setShowShortcutHelp(false)}>
                    Close
                  </button>
                </div>
                {groupShortcutsByCategory().map((group) => (
                  <div key={group.category} style={styles.shortcutGroup}>
                    <span style={styles.shortcutGroupTitle}>{group.category}</span>
                    {group.shortcuts.map((shortcut) => (
                      <div key={shortcut.id} style={styles.shortcutRow}>
                        <span style={styles.shortcutLabel}>{shortcut.label}</span>
                        <kbd style={styles.shortcutKey}>{shortcut.key === '?' ? '?' : shortcut.key.toUpperCase()}</kbd>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
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
              relayOutputPreset={rtmpRelayOutputPreset}
              onRelayOutputPresetChange={setRtmpRelayOutputPreset}
              isLive={isLive}
              relayStats={relayStats}
              relayReadiness={relayReadiness}
              sessionHealth={sessionHealth}
              sceneCount={scenes.length}
              streamScreenConfig={streamScreenConfig}
              activeStreamScreenKind={activeStreamScreenState?.kind || null}
              onStreamScreenConfigChange={onStreamScreenConfigChange}
              onApplyStreamScreen={onApplyStreamScreen}
              onClearStreamScreen={onClearStreamScreen}
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
            onSend={(content, recipientId) => onSendChat(content, false, recipientId)}
            onReact={onReactChat}
            onTypingChange={(typing, recipientId) => onChatTypingChange(typing, false, recipientId)}
            onClose={() => setShowGuestChat(false)}
            senderName={userName}
            typingUsers={guestChatTypingNames}
            directRecipients={Array.from(allParticipantsMap.values())
              .filter((participant) => (
                participant.id !== myParticipant?.id &&
                (participant.role === 'host' || participant.role === 'co-host')
              ))
              .map((participant) => ({
                id: participant.id,
                name: participant.name,
                role: participant.role,
              }))}
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
            autoSpeakerLowerThirds={autoSpeakerLowerThirds}
            onAutoSpeakerLowerThirdsChange={setAutoSpeakerLowerThirds}
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
            studioTheme={studioTheme}
            onStudioThemeChange={setStudioTheme}
            brandColor={brandColor}
            onBrandColorChange={setBrandColor}
            logoUrl={logoUrl}
            onLogoUrlChange={setLogoUrl}
            waitingRoomBranding={waitingRoomBranding}
            onWaitingRoomBrandingChange={(next) => setWaitingRoomBranding(normalizeWaitingRoomBranding(next))}
            logoPlacement={logoPlacement}
            onLogoPlacementChange={setLogoPlacement}
            logoPosition={logoPosition}
            onLogoPositionChange={setLogoPosition}
            logoSize={logoSize}
            onLogoSizeChange={setLogoSize}
            logoOpacity={logoOpacity}
            onLogoOpacityChange={setLogoOpacity}
            cameraShape={cameraShape}
            onCameraShapeChange={setCameraShape}
            nameTagStyle={nameTagStyle}
            onNameTagStyleChange={setNameTagStyle}
            brandKitCatalogRoomId={roomId || ''}
            brandKitCatalogHostToken={roomHostToken}
            mediaAssets={mediaAssets}
            activeMedia={activeMedia}
            activeMediaSlideIndex={activeMediaSlideIndex}
            onActiveMediaSlideIndexChange={setActiveMediaSlideIndex}
            onUploadMedia={onUploadMedia}
            onAddMediaUrl={onAddMediaUrl}
            onPlayMediaAsset={onPlayMediaAsset}
            onRemoveMediaAsset={onRemoveMediaAsset}
            onStopMedia={onStopMedia}
            mediaServerHealth={mediaServerHealth}
            onRefreshMediaServerHealth={refreshMediaServerHealth}
            scenes={scenes}
            activeSceneId={activeSceneId}
            sceneTransitionPreset={sceneTransitionPreset}
            sceneStingerClip={sceneStingerClip}
            onSceneTransitionPresetChange={setSceneTransitionPreset}
            onSceneStingerClipChange={handleSceneStingerClipChange}
            onSaveScene={onSaveScene}
            onCreateTemplateScene={onCreateTemplateScene}
            onCreateProductionScenePack={onCreateProductionScenePack}
            onApplyScene={onApplyScene}
            onDeleteScene={onDeleteScene}
            onRenameScene={onRenameScene}
            onUpdateScene={onUpdateScene}
            onDuplicateScene={onDuplicateScene}
            onReorderScene={onReorderScene}
            onExportScenePack={onExportScenePack}
            onImportScenePack={onImportScenePack}
            scenePackMessage={scenePackMessage}
            tickers={tickers}
            onAddTicker={onAddTicker}
            onToggleTicker={onToggleTicker}
            onRemoveTicker={onRemoveTicker}
            onUpdateTicker={onUpdateTicker}
            widgets={widgets}
            onAddWidget={onAddWidget}
            onToggleWidget={onToggleWidget}
            onRemoveWidget={onRemoveWidget}
            chatMessages={chatMessages}
            highlightedComment={highlightedComment}
            onHighlightComment={onHighlightComment}
            onFlashComment={onFlashComment}
            onDismissComment={onDismissComment}
            chatPanelMessages={chatMessages}
            onSendChat={onSendChat}
            onReactChat={onReactChat}
            onToggleChatStar={onToggleChatStar}
            onToggleChatPin={onToggleChatPin}
            externalChatStatuses={externalChatStatuses}
            onConnectExternalChat={onConnectExternalChat}
            onDisconnectExternalChat={onDisconnectExternalChat}
            chatSenderName={userName}
            chatTypingNames={{
              public: publicChatTypingNames,
              direct: directChatTypingNames,
              backstage: backstageChatTypingNames,
            }}
            onChatTypingChange={onChatTypingChange}
            onOpenPopoutChat={onOpenPopoutChat}
            allParticipants={allParticipantsMap}
            myParticipantId={myParticipant?.id || ''}
            myRole={myParticipant?.role || 'guest'}
            onStageAction={onStageAction}
            focusedParticipantId={focusedVideoItemId}
            onSpotlightParticipant={onSpotlightParticipant}
            remoteStreams={remoteStreams}
            peerBandwidthHealth={peerBandwidthHealth}
            localStream={localStream}
            participantVolumes={participantVolumes}
            onParticipantVolumeChange={handleParticipantVolumeChange}
            audioDuckingEnabled={audioDuckingEnabled}
            onAudioDuckingEnabledChange={setAudioDuckingEnabled}
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
              onCreateGuestInvite={requestGuestInvite}
              onCreateCoHostInvite={requestCoHostInvite}
              onClose={() => setShowInvitePanel(false)}
            />
          </Suspense>
        )}

        {/* Recording Panel */}
        {canControlRecording && showRecordingPanel && (
          <Suspense fallback={<LazyPanelFallback />}>
            <RecordingPanel
              isRecording={isLocalRecording}
              isRecordingPaused={isLocalRecordingPaused}
              formattedTime={localRecFormattedTime}
              recordingTrackLabels={localRecordingLabels}
              recordingMarkers={recordingMarkers}
              recordingReadiness={recordingReadiness}
              onStartRecording={onStartLocalRecording}
              onPauseRecording={pauseLocalRecording}
              onResumeRecording={resumeLocalRecording}
              onStopRecording={stopLocalRecording}
              onCancelRecording={cancelLocalRecording}
              onUploadRecording={uploadLocalRecordingToMediaServer}
              onDownloadRecordingExportArtifact={downloadMediaServerRecordingArtifact}
              onRefreshRecordingExport={refreshMediaServerRecordingExport}
              onRequestRecordingClipExport={requestMediaServerClipExport}
              onSyncRecordingCatalog={syncLocalRecordingCatalog}
              mediaServerHealth={mediaServerHealth}
              onRefreshMediaServerHealth={refreshMediaServerHealth}
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
        roomName={room?.name || 'Studio'}
        isHost={isHostOrCoHost}
        isRecording={recordingStatus.active}
        recordingPaused={recordingStatus.paused}
        formattedTime={recordingStatus.formattedTime}
        onToggleRecording={canControlRecording ? onToggleRecording : undefined}
        onToggleRecordingPause={canControlRecording && isRecording ? onToggleRecordingPause : undefined}
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
        onOpenRecordingPanel={canControlRecording ? () => setShowRecordingPanel(!showRecordingPanel) : undefined}
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
            isRecording={recordingStatus.active}
            formattedTime={recordingStatus.formattedTime}
            currentLayout={layout}
            onLayoutChange={applyLayout}
            focusedParticipantId={focusedVideoItemId}
            onSpotlightParticipant={onSpotlightParticipant}
            onClose={() => setShowProducerPanel(false)}
          />
        </Suspense>
      )}

      {/* Sound Board Modal */}
      {showSoundBoard && (
        <Suspense fallback={<LazyPanelFallback />}>
          <SoundBoard
            onClose={() => setShowSoundBoard(false)}
            broadcastAudio={broadcastAudioBus}
          />
        </Suspense>
      )}

      {/* Background Music Modal */}
      {showBackgroundMusic && (
        <Suspense fallback={<LazyPanelFallback />}>
          <BackgroundMusic
            onClose={() => setShowBackgroundMusic(false)}
            broadcastAudio={broadcastAudioBus}
          />
        </Suspense>
      )}

      {/* Session Health Panel */}
      {showHealthPanel && (
        <SessionHealthPanel
          summary={sessionHealth}
          meshCapacity={meshCapacity}
          sfuMediaStatus={sfuTransportStatus}
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
          audioProcessing={audioProcessing}
          onAudioProcessingChange={onAudioProcessingChange}
          videoQuality={videoQuality}
          recommendedVideoQuality={recommendedVideoQuality}
          onVideoQualityChange={onVideoQualityChange}
          onClose={() => setShowDeviceSettings(false)}
          virtualBackground={vbConfig}
          onVirtualBackgroundChange={onVirtualBackgroundChange}
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

function BackstagePrivateRoom({
  items,
  brandColor,
  cameraShape,
  nameTagStyle,
  compact = false,
}: {
  items: StageVideoItem[];
  brandColor: string;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  compact?: boolean;
}) {
  return (
    <section
      data-testid="backstage-private-room"
      style={{
        ...styles.backstageRoom,
        ...(compact ? styles.backstageRoomCompact : {}),
      }}
      aria-label="Backstage private room"
    >
      <div style={styles.backstageRoomHeader}>
        <span style={styles.backstageRoomTitle}>
          <span style={styles.backstageRoomDot} />
          Backstage
        </span>
        <span style={styles.backstageRoomMeta}>{items.length} private</span>
      </div>
      <div style={styles.backstageRoomGrid}>
        {items.map((item) => (
          <div
            key={item.id}
            style={{
              ...styles.backstageRoomTile,
              ...(compact ? styles.backstageRoomTileCompact : {}),
            }}
          >
            <VideoTile
              participantId={item.id}
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
              connectionHealth={item.connectionHealth}
            />
          </div>
        ))}
      </div>
    </section>
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
  waitingLogoMarkImg: {
    width: 28,
    height: 28,
    borderRadius: 8,
    objectFit: 'contain',
    background: 'rgba(255, 255, 255, 0.08)',
    padding: 3,
  },
  waitingLogoFallback: {
    width: 28,
    height: 28,
    display: 'block',
    borderRadius: 8,
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18)',
  },
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
    textTransform: 'uppercase' as const, letterSpacing: 0,
    fontFamily: 'monospace',
    fontVariantNumeric: 'tabular-nums',
    minWidth: 78,
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
  waitingStack: {
    width: 'min(960px, 100%)',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
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
  waitingHeroLogo: {
    maxWidth: 160,
    maxHeight: 56,
    objectFit: 'contain',
    marginBottom: 4,
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
  studioNoticeWrap: {
    position: 'fixed',
    top: 58,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 80,
    width: 'min(420px, calc(100vw - 32px))',
    pointerEvents: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  studioNotice: {
    width: '100%',
    pointerEvents: 'auto',
    background: 'rgba(15, 23, 42, 0.94)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
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
  liveSummaryDestinations: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginTop: 5,
    maxHeight: 104,
    overflowY: 'auto',
  },
  liveSummaryDestinationRow: {
    display: 'grid',
    gridTemplateColumns: '8px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 7,
    minHeight: 24,
    padding: '4px 6px',
    borderRadius: 7,
    background: 'rgba(15, 23, 42, 0.56)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
  },
  liveSummaryDestinationDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
  },
  liveSummaryDestinationDotSuccess: {
    background: '#22c55e',
  },
  liveSummaryDestinationDotWarning: {
    background: '#f59e0b',
  },
  liveSummaryDestinationDotError: {
    background: '#ef4444',
  },
  liveSummaryDestinationName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text-primary)',
    fontSize: 11,
    fontWeight: 800,
  },
  liveSummaryDestinationStatus: {
    fontSize: 10,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  liveSummaryDestinationStatusSuccess: {
    color: '#86efac',
  },
  liveSummaryDestinationStatusWarning: {
    color: '#fbbf24',
  },
  liveSummaryDestinationStatusError: {
    color: '#fca5a5',
  },
  noticeActionBtn: {
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.16)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: 'currentColor',
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: 'nowrap',
    padding: '6px 9px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  noticeDismissBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: 'currentColor',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
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
  backstageRoom: {
    width: 'min(760px, 100%)',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    border: '1px solid rgba(245, 158, 11, 0.28)',
    background: 'rgba(15, 23, 42, 0.78)',
    boxShadow: '0 14px 34px rgba(0, 0, 0, 0.24)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  backstageRoomCompact: {
    width: 'min(720px, 100%)',
    padding: 8,
  },
  backstageRoomHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  backstageRoomTitle: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    color: '#fde68a',
    fontSize: 12,
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  backstageRoomDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#f59e0b',
    boxShadow: '0 0 0 4px rgba(245, 158, 11, 0.14)',
  },
  backstageRoomMeta: {
    color: 'var(--text-muted)',
    fontSize: 11,
    fontWeight: 700,
  },
  backstageRoomGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))',
    gap: 8,
  },
  backstageRoomTile: {
    minWidth: 0,
    height: 132,
    borderRadius: 8,
    overflow: 'hidden',
  },
  backstageRoomTileCompact: {
    height: 92,
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
  stageBackgroundVideo: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    zIndex: 0,
    pointerEvents: 'none',
  },
  sceneTransitionOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 70,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    background: 'rgba(2, 6, 23, 0.38)',
    backdropFilter: 'blur(2px)',
    WebkitBackdropFilter: 'blur(2px)',
    transition: `opacity ${SCENE_TRANSITION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
    willChange: 'opacity',
  },
  sceneTransitionLabel: {
    maxWidth: 'min(70%, 520px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '10px 16px',
    borderRadius: 999,
    border: '1px solid rgba(255, 255, 255, 0.22)',
    background: 'rgba(15, 23, 42, 0.72)',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
  },
  sceneTransitionVideo: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  // Base grid container — actual layout props are merged from layoutResult.containerStyle
  gridBase: {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box' as const,
    position: 'relative',
    zIndex: 1,
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
  tileWrapperDraggable: {
    cursor: 'grab',
  },
  tileWrapperDragging: {
    opacity: 0.58,
    transform: 'scale(0.985)',
    cursor: 'grabbing',
  },
  tileWrapperDropTarget: {
    outline: '3px solid #67e8f9',
    outlineOffset: -3,
    boxShadow: '0 0 0 4px rgba(103, 232, 249, 0.18), 0 14px 34px rgba(0, 0, 0, 0.34)',
  },
  tileControls: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  focusTileBtn: {
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
  stageOrderBtn: {
    width: 30,
    height: 28,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.16)',
    background: 'rgba(15, 23, 42, 0.64)',
    color: 'rgba(255, 255, 255, 0.78)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0, 0, 0, 0.2)',
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
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  autoDirectorBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 32,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  autoDirectorBtnActive: {
    borderColor: 'var(--accent)',
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
  },
  autoDirectorDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--text-muted)',
  },
  autoDirectorDotActive: {
    background: 'var(--accent)',
    boxShadow: '0 0 6px var(--accent)',
  },
  shortcutHelpBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 14,
    fontWeight: 800,
    cursor: 'pointer',
  },
  shortcutOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.55)',
    padding: 20,
  },
  shortcutCard: {
    width: 'min(420px, 100%)',
    maxHeight: '80vh',
    overflowY: 'auto',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  shortcutCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shortcutCardTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  shortcutCloseBtn: {
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    padding: '5px 12px',
    cursor: 'pointer',
  },
  shortcutGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  shortcutGroupTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  shortcutRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  shortcutLabel: {
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  shortcutKey: {
    minWidth: 26,
    textAlign: 'center',
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: 'inherit',
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
  // Shared media tile
  mediaOverlay: {
    position: 'relative',
    background: '#000',
    borderRadius: 'var(--radius-lg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box' as const,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    border: '1px solid rgba(255, 255, 255, 0.10)',
    boxShadow: '0 18px 44px rgba(0, 0, 0, 0.28)',
    transition: 'width 0.3s ease, height 0.3s ease, opacity 0.3s ease, border-radius 0.3s ease, transform 0.3s ease',
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
  presentationRenderMissingCard: {
    width: 'min(86%, 760px)',
    minHeight: 220,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 28,
    borderRadius: 18,
    background: 'linear-gradient(135deg, rgba(15,23,42,0.94), rgba(2,6,23,0.96))',
    border: '1px solid rgba(248,113,113,0.45)',
    boxShadow: '0 28px 80px rgba(0,0,0,0.38)',
    color: '#f8fafc',
    textAlign: 'center',
  },
  presentationRenderMissingTitle: {
    fontSize: 18,
    fontWeight: 900,
    color: '#fecaca',
  },
  presentationRenderMissingText: {
    maxWidth: 520,
    fontSize: 13,
    lineHeight: 1.5,
    color: 'rgba(226,232,240,0.82)',
  },
  presentationStage: {
    position: 'relative',
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4%',
    background: 'linear-gradient(135deg, #0f172a 0%, #020617 100%)',
  },
  presentationSlide: {
    width: 'min(86%, 980px)',
    aspectRatio: '16 / 9',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 18,
    background: '#f8fafc',
    color: '#0f172a',
    border: '1px solid rgba(255,255,255,0.24)',
    boxShadow: '0 28px 80px rgba(0,0,0,0.42)',
    overflow: 'hidden',
  },
  presentationSlideVisualFrame: {
    position: 'relative',
    width: 'min(92%, 1180px)',
    aspectRatio: '16 / 9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    background: '#050816',
    border: '1px solid rgba(255,255,255,0.24)',
    boxShadow: '0 28px 80px rgba(0,0,0,0.42)',
    overflow: 'hidden',
  },
  presentationSlideImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    background: '#ffffff',
  },
  presentationSlideBadge: {
    position: 'absolute',
    top: 12,
    right: 12,
    minWidth: 92,
    height: 30,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 12px',
    borderRadius: 999,
    background: 'rgba(2,6,23,0.72)',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: 900,
    boxShadow: '0 10px 26px rgba(0,0,0,0.28)',
  },
  presentationFilePill: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    maxWidth: 'min(70%, 620px)',
    minHeight: 32,
    display: 'flex',
    alignItems: 'center',
    padding: '0 13px',
    borderRadius: 999,
    background: 'rgba(2,6,23,0.72)',
    border: '1px solid rgba(255,255,255,0.18)',
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: 900,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    boxShadow: '0 10px 26px rgba(0,0,0,0.28)',
  },
  presentationSlideHeader: {
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    padding: '0 28px',
    borderBottom: '1px solid #e2e8f0',
    background: '#ffffff',
  },
  presentationDeckLabel: {
    minWidth: 0,
    color: '#4338ca',
    fontSize: 13,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  presentationSlideCount: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: 800,
    whiteSpace: 'nowrap',
  },
  presentationSlideBody: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 20,
    padding: '34px 56px',
  },
  presentationTitle: {
    margin: 0,
    color: '#0f172a',
    fontSize: 34,
    lineHeight: 1.12,
    fontWeight: 900,
  },
  presentationLines: {
    margin: 0,
    paddingLeft: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    color: '#334155',
    fontSize: 18,
    lineHeight: 1.35,
    fontWeight: 650,
  },
  presentationLine: {
    paddingLeft: 4,
  },
  presentationEmptyLine: {
    margin: 0,
    color: '#64748b',
    fontSize: 17,
    fontWeight: 700,
  },
  presentationFileName: {
    height: 42,
    display: 'flex',
    alignItems: 'center',
    padding: '0 28px',
    borderTop: '1px solid #e2e8f0',
    color: '#64748b',
    fontSize: 12,
    fontWeight: 800,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  presentationControls: {
    position: 'absolute',
    left: '50%',
    bottom: 18,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 5,
    borderRadius: 999,
    background: 'rgba(2,6,23,0.82)',
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: '0 14px 34px rgba(0,0,0,0.28)',
  },
  presentationControlBtn: {
    minWidth: 58,
    height: 28,
    borderRadius: 999,
    border: '1px solid rgba(167,139,250,0.48)',
    background: 'rgba(167,139,250,0.18)',
    color: '#ede9fe',
    fontSize: 11,
    fontWeight: 900,
    cursor: 'pointer',
  },
  presentationControlBtnDisabled: {
    opacity: 0.42,
    cursor: 'not-allowed',
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
  streamScreenOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 66,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    pointerEvents: 'none',
    color: 'white',
    background: '#020617',
  },
  streamScreenScrim: {
    position: 'absolute',
    inset: 0,
    background: 'radial-gradient(circle at 50% 42%, rgba(255,255,255,0.05), rgba(2,6,23,0.58) 78%)',
  },
  streamScreenContent: {
    position: 'relative',
    zIndex: 1,
    width: 'min(76%, 760px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    textAlign: 'center',
  },
  streamScreenLogo: {
    maxWidth: 180,
    maxHeight: 58,
    objectFit: 'contain',
    marginBottom: 4,
  },
  streamScreenKicker: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 30,
    maxWidth: '100%',
    padding: '5px 13px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(15,23,42,0.58)',
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: 900,
    textTransform: 'uppercase',
    letterSpacing: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  streamScreenTitle: {
    margin: 0,
    maxWidth: '100%',
    color: '#fff',
    fontSize: 34,
    lineHeight: 1.08,
    fontWeight: 900,
    letterSpacing: 0,
    overflowWrap: 'anywhere',
    textShadow: '0 14px 36px rgba(0,0,0,0.38)',
  },
  streamScreenMessage: {
    margin: 0,
    maxWidth: 520,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 15,
    lineHeight: 1.45,
    fontWeight: 600,
    overflowWrap: 'anywhere',
  },
  streamScreenAccent: {
    width: 180,
    height: 5,
    borderRadius: 999,
    marginTop: 4,
    boxShadow: '0 0 22px rgba(255,255,255,0.22)',
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
    pointerEvents: 'none',
  },
  logoWatermarkDraggable: {
    pointerEvents: 'auto',
    cursor: 'grab',
    touchAction: 'none',
  },
  logoWatermarkImg: {
    objectFit: 'contain',
    userSelect: 'none',
  },
};
