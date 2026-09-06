import { StudioChat } from './StudioChat.tsx';
import '../styles/overlay-panel.css';
import '../styles/media-library.css';
import { useState, useRef, useEffect } from 'react';
import type { ActiveMedia, LogoPlacement, LogoPosition, LogoSize, StageBackground, Scene, ChatMessage, ChatReactionType, Participant, StageActionPayload, CameraShape, NameTagStyle, StudioMediaAsset, WaitingRoomBranding, ExternalChatStatusPayload, ExternalChatPlatform } from '@studio/shared';
import { LowerThirdManager, type LowerThirdData } from './LowerThird.tsx';
import { BannerManager, type BannerData } from './BannerOverlay.tsx';
import { TimerManager, type TimerData } from './TimerOverlay.tsx';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { SceneManager, type ProductionSceneTemplate } from './SceneManager.tsx';
import { TickerManager, type TickerData } from './TickerOverlay.tsx';
import { WidgetOverlayManager, type WidgetOverlayData } from './WidgetOverlay.tsx';
import {
  CommentHighlightManager,
  type HighlightedComment,
} from './CommentHighlight.tsx';
import { MediaLibrary } from './MediaLibrary.tsx';
import { AudioLevelMeter } from './AudioLevelMeter.tsx';
import {
  BRAND_KIT_STORAGE_KEY,
  MAX_SAVED_BRAND_KITS,
  createSavedBrandKit,
  parseSavedBrandKits,
  serializeSavedBrandKits,
  type BrandKitVisuals,
  type SavedBrandKit,
} from '../utils/brandKits.ts';
import {
  deleteBrandKitCatalogEntry,
  syncBrandKitCatalogEntry,
} from '../utils/brandKitCatalog.ts';
import type { SceneOrderDirection } from '../utils/sceneOrder.ts';
import type { SceneStingerClip, SceneTransitionPresetId } from '../utils/sceneTransitions.ts';
import {
  STUDIO_THEME_PRESETS,
  getStudioThemeLabel,
  type StudioThemeId,
} from '../utils/studioThemes.ts';
import { normalizeLogoOpacity } from '../utils/logoWatermark.ts';
import { getLogoPositionFromPlacement, normalizeLogoPosition } from '../utils/logoPosition.ts';
import {
  MAX_WAITING_ROOM_HEADLINE_LENGTH,
  MAX_WAITING_ROOM_MESSAGE_LENGTH,
} from '../utils/waitingRoomBranding.ts';
import {
  formatPeerBandwidthHealthTitle,
  formatPeerBandwidthQualityLabel,
} from '../utils/peerBandwidthDisplay.ts';
import type { PeerBandwidthHealth, PeerBandwidthQuality } from '../utils/webrtcBandwidthAdaptation.ts';
import type { MediaServerHealth } from '../utils/mediaServerHealth.ts';

// ---------------------------------------------------------------------------
// Tab type — matches StreamYard / Riverside vertical icon pattern
// ---------------------------------------------------------------------------
export type SidebarTab = 'people' | 'chat' | 'media' | 'overlays' | 'brand' | 'scenes';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface SidebarProps {
  activeTab?: SidebarTab | null;
  onActiveTabChange?: (tab: SidebarTab | null) => void;
  // Overlay props
  lowerThirds: LowerThirdData[];
  onAddLowerThird: (lt: Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleLowerThird: (id: string) => void;
  onRemoveLowerThird: (id: string) => void;
  onUpdateLowerThird?: (id: string, updates: Partial<LowerThirdData>) => void;
  autoSpeakerLowerThirds: boolean;
  onAutoSpeakerLowerThirdsChange: (enabled: boolean) => void;
  banners: BannerData[];
  onAddBanner: (banner: Omit<BannerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleBanner: (id: string) => void;
  onRemoveBanner: (id: string) => void;
  onUpdateBanner?: (id: string, updates: Partial<BannerData>) => void;
  timers: TimerData[];
  onAddTimer: (timer: Omit<TimerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleTimer: (id: string) => void;
  onRemoveTimer: (id: string) => void;
  onUpdateTimer: (id: string, updates: Partial<TimerData>) => void;
  tickers: TickerData[];
  onAddTicker: (ticker: Omit<TickerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleTicker: (id: string) => void;
  onRemoveTicker: (id: string) => void;
  onUpdateTicker: (id: string, updates: Partial<TickerData>) => void;
  widgets: WidgetOverlayData[];
  onAddWidget: (widget: Omit<WidgetOverlayData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleWidget: (id: string) => void;
  onRemoveWidget: (id: string) => void;
  onUpdateWidget?: (id: string, updates: Partial<WidgetOverlayData>) => void;
  // Comment highlight
  chatMessages: ChatMessage[];
  highlightedComment: HighlightedComment | null;
  onHighlightComment: (comment: HighlightedComment) => void;
  onFlashComment: (comment: HighlightedComment) => void;
  onDismissComment: () => void;
  // Brand props
  studioTheme: StudioThemeId;
  onStudioThemeChange: (theme: StudioThemeId) => void;
  stageBackground: StageBackground;
  onStageBackgroundChange: (bg: StageBackground) => void;
  brandColor: string;
  onBrandColorChange: (color: string) => void;
  logoUrl: string | null;
  onLogoUrlChange: (url: string | null) => void;
  waitingRoomBranding: WaitingRoomBranding;
  onWaitingRoomBrandingChange: (config: WaitingRoomBranding) => void;
  logoPlacement: LogoPlacement;
  onLogoPlacementChange: (placement: LogoPlacement) => void;
  logoPosition: LogoPosition | null;
  onLogoPositionChange: (position: LogoPosition | null) => void;
  logoSize: LogoSize;
  onLogoSizeChange: (size: LogoSize) => void;
  logoOpacity: number;
  onLogoOpacityChange: (opacity: number) => void;
  cameraShape: CameraShape;
  onCameraShapeChange: (shape: CameraShape) => void;
  nameTagStyle: NameTagStyle;
  onNameTagStyleChange: (style: NameTagStyle) => void;
  brandKitCatalogRoomId?: string;
  brandKitCatalogHostToken?: string;
  // Media props
  mediaAssets: StudioMediaAsset[];
  activeMedia: ActiveMedia | null;
  activeMediaSlideIndex: number;
  onActiveMediaSlideIndexChange: (index: number) => void;
  onUploadMedia: (files: FileList | File[]) => void;
  onAddMediaUrl: (url: string, type: 'video' | 'image') => void | Promise<void>;
  onPlayMediaAsset: (asset: StudioMediaAsset) => void;
  onRemoveMediaAsset: (assetId: string) => void;
  onStopMedia: () => void;
  mediaServerHealth?: MediaServerHealth | null;
  onRefreshMediaServerHealth?: () => void | Promise<MediaServerHealth>;
  // Scene props
  scenes: Scene[];
  activeSceneId: string | null;
  sceneTransitionPreset: SceneTransitionPresetId;
  sceneStingerClip: SceneStingerClip | null;
  onSceneTransitionPresetChange: (presetId: SceneTransitionPresetId) => void;
  onSceneStingerClipChange: (clip: SceneStingerClip | null) => void;
  onSaveScene: (name: string) => void | Promise<void>;
  onCreateTemplateScene: (template: ProductionSceneTemplate) => void | Promise<void>;
  onCreateProductionScenePack: () => void | Promise<void>;
  onApplyScene: (sceneId: string) => void;
  onDeleteScene: (sceneId: string) => void;
  onRenameScene: (sceneId: string, newName: string) => void;
  onUpdateScene: (sceneId: string) => void | Promise<void>;
  onDuplicateScene: (sceneId: string) => void;
  onReorderScene: (sceneId: string, direction: SceneOrderDirection) => void;
  onExportScenePack: () => void;
  onImportScenePack: (file: File) => void | Promise<void>;
  scenePackMessage?: string | null;
  // Chat props
  chatPanelMessages: ChatMessage[];
  onSendChat: (content: string, isBackstage?: boolean, recipientId?: string) => void;
  onReactChat: (messageId: string, reaction: ChatReactionType) => void;
  onToggleChatStar: (messageId: string, starred: boolean) => void;
  onToggleChatPin: (messageId: string, pinned: boolean) => void;
  externalChatStatuses: Partial<Record<ExternalChatPlatform, ExternalChatStatusPayload>>;
  onConnectExternalChat: (platform: ExternalChatPlatform, liveChatId: string) => void;
  onDisconnectExternalChat: (platform: ExternalChatPlatform) => void;
  chatSenderName: string;
  chatTypingNames?: {
    public: string[];
    direct: string[];
    backstage: string[];
  };
  onChatTypingChange?: (typing: boolean, isBackstage?: boolean, recipientId?: string) => void;
  onOpenPopoutChat?: () => void;
  // People props
  allParticipants: Map<string, Participant>;
  myParticipantId: string;
  myRole: 'host' | 'co-host' | 'guest';
  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;
  focusedParticipantId: string | null;
  onSpotlightParticipant: (participantId: string | null) => void;
  // Streams for live previews in People tab
  remoteStreams: Map<string, MediaStream>;
  peerBandwidthHealth: Map<string, PeerBandwidthHealth>;
  localStream: MediaStream | null;
  participantVolumes: Record<string, number>;
  onParticipantVolumeChange: (participantId: string, volume: number) => void;
  audioDuckingEnabled: boolean;
  onAudioDuckingEnabledChange: (enabled: boolean) => void;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------
const tabDefs: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'people',
    label: 'People',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    id: 'chat',
    label: 'Chat',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'media',
    label: 'Media',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9l5 3-5 3V9z" />
      </svg>
    ),
  },
  {
    id: 'overlays',
    label: 'Overlays',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="15" x2="21" y2="15" />
      </svg>
    ),
  },
  {
    id: 'brand',
    label: 'Brand',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
      </svg>
    ),
  },
  {
    id: 'scenes',
    label: 'Scenes',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" />
        <path d="M16 3h-8l-2 4h12l-2-4z" />
      </svg>
    ),
  },
];

function loadSavedBrandKits(): SavedBrandKit[] {
  try {
    return parseSavedBrandKits(localStorage.getItem(BRAND_KIT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function getBackgroundStyleValue(background: StageBackground, fallbackColor: string): string {
  if (background.type === 'image' && background.value) {
    return `url(${background.value}) center / cover no-repeat`;
  }
  if (background.type === 'gradient' || background.type === 'color') {
    return background.value || fallbackColor;
  }
  return `linear-gradient(135deg, #0f172a 0%, ${fallbackColor} 100%)`;
}

function getCameraShapeRadius(shape: CameraShape): number | string {
  if (shape === 'circle') return '50%';
  if (shape === 'rounded') return 10;
  if (shape === 'square') return 6;
  return 3;
}

type BrandKitPreset = Omit<BrandKitVisuals, 'logoUrl' | 'logoPlacement' | 'logoPosition'> & {
  name: string;
  logoUrl?: string | null;
  logoPlacement?: LogoPlacement;
  logoPosition?: LogoPosition | null;
};

// ---------------------------------------------------------------------------
// Main Sidebar component
// ---------------------------------------------------------------------------
export function Sidebar(props: SidebarProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<SidebarTab | null>('people');
  const [savedBrandKits, setSavedBrandKits] = useState<SavedBrandKit[]>(loadSavedBrandKits);
  const [brandKitName, setBrandKitName] = useState('');
  const [brandKitMessage, setBrandKitMessage] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const activeTab = props.activeTab !== undefined ? props.activeTab : internalActiveTab;
  const setActiveTab = props.onActiveTabChange || setInternalActiveTab;

  const handleTabClick = (tabId: SidebarTab) => {
    setActiveTab(activeTab === tabId ? null : tabId);
  };

  const brandPresets = [
    { name: 'Purple', color: '#7c3aed' },
    { name: 'Blue', color: '#3b82f6' },
    { name: 'Green', color: '#22c55e' },
    { name: 'Red', color: '#ef4444' },
    { name: 'Orange', color: '#f97316' },
    { name: 'Pink', color: '#ec4899' },
    { name: 'Cyan', color: '#06b6d4' },
    { name: 'Amber', color: '#f59e0b' },
  ];

  const brandKits: BrandKitPreset[] = [
    { name: 'Broadcast', studioTheme: 'dark', brandColor: '#ef4444', stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #7f1d1d 100%)' }, cameraShape: 'rounded', nameTagStyle: 'block', logoSize: 'medium', logoOpacity: 0.85 },
    { name: 'Webinar', studioTheme: 'light', brandColor: '#2563eb', stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)' }, cameraShape: 'rounded', nameTagStyle: 'classic', logoSize: 'small', logoOpacity: 0.75 },
    { name: 'Podcast', studioTheme: 'colorful', brandColor: '#db2777', stageBackground: { type: 'gradient', value: 'linear-gradient(135deg, #18181b 0%, #831843 100%)' }, cameraShape: 'circle', nameTagStyle: 'minimal', logoSize: 'medium', logoOpacity: 0.65 },
    { name: 'Executive', studioTheme: 'dark', brandColor: '#059669', stageBackground: { type: 'color', value: '#111827' }, cameraShape: 'rectangle', nameTagStyle: 'classic', logoSize: 'large', logoOpacity: 0.55 },
  ];

  useEffect(() => {
    try {
      localStorage.setItem(BRAND_KIT_STORAGE_KEY, serializeSavedBrandKits(savedBrandKits));
    } catch {
      // Browser storage can be unavailable in private modes; the current session still works.
    }
  }, [savedBrandKits]);

  const applyBrandKit = (kit: BrandKitPreset | SavedBrandKit) => {
    props.onStudioThemeChange(kit.studioTheme);
    props.onBrandColorChange(kit.brandColor);
    props.onStageBackgroundChange(kit.stageBackground);
    props.onCameraShapeChange(kit.cameraShape);
    props.onNameTagStyleChange(kit.nameTagStyle);
    props.onLogoSizeChange(kit.logoSize);
    props.onLogoOpacityChange(kit.logoOpacity);
    if (kit.logoPlacement !== undefined) props.onLogoPlacementChange(kit.logoPlacement);
    props.onLogoPositionChange(normalizeLogoPosition(kit.logoPosition));
    if (kit.logoUrl !== undefined) props.onLogoUrlChange(kit.logoUrl);
    setBrandKitMessage(null);
  };

  const saveCurrentBrandKit = async () => {
    if (savedBrandKits.length >= MAX_SAVED_BRAND_KITS) {
      setBrandKitMessage(`Maximum of ${MAX_SAVED_BRAND_KITS} saved kits reached.`);
      return;
    }
    const nextKit = createSavedBrandKit(
      brandKitName || `Brand Kit ${savedBrandKits.length + 1}`,
      {
        studioTheme: props.studioTheme,
        brandColor: props.brandColor,
        stageBackground: props.stageBackground,
        logoUrl: props.logoUrl,
        logoPlacement: props.logoPlacement,
        logoPosition: props.logoPosition,
        logoSize: props.logoSize,
        logoOpacity: props.logoOpacity,
        cameraShape: props.cameraShape,
        nameTagStyle: props.nameTagStyle,
      },
      savedBrandKits.map((kit) => kit.name)
    );
    setSavedBrandKits((current) => [nextKit, ...current].slice(0, MAX_SAVED_BRAND_KITS));
    setBrandKitName('');
    setBrandKitMessage(`Saved ${nextKit.name}.`);

    if (props.brandKitCatalogRoomId && props.brandKitCatalogHostToken) {
      try {
        await syncBrandKitCatalogEntry({
          roomId: props.brandKitCatalogRoomId,
          hostToken: props.brandKitCatalogHostToken,
          brandKit: nextKit,
        });
        setBrandKitMessage(`Saved ${nextKit.name} and synced to this studio.`);
      } catch {
        setBrandKitMessage(`Saved ${nextKit.name} locally. Cloud sync failed.`);
      }
    }
  };

  const deleteSavedBrandKit = async (kitId: string) => {
    const kit = savedBrandKits.find((item) => item.id === kitId);
    setSavedBrandKits((current) => current.filter((item) => item.id !== kitId));
    if (kit) setBrandKitMessage(`Deleted ${kit.name}.`);
    if (kit && props.brandKitCatalogRoomId && props.brandKitCatalogHostToken) {
      try {
        await deleteBrandKitCatalogEntry(props.brandKitCatalogRoomId, props.brandKitCatalogHostToken, kit.id);
      } catch {
        setBrandKitMessage(`Deleted ${kit.name} locally. Cloud delete failed.`);
      }
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (props.logoUrl?.startsWith('blob:')) URL.revokeObjectURL(props.logoUrl);
      if (file.size <= 2_000_000) {
        const reader = new FileReader();
        reader.onloadend = () => props.onLogoUrlChange(reader.result as string);
        reader.readAsDataURL(file);
      } else {
        props.onLogoUrlChange(URL.createObjectURL(file));
      }
    }
    e.target.value = '';
  };

  return (
    <div className="studio-sidebar" style={st.wrapper}>
      {/* Content panel — only visible when a tab is active */}
      {activeTab && (
        <div className="studio-sidebar-panel" style={st.contentPanel}>
          <div className="studio-panel-heading"><span>{tabDefs.find(tab => tab.id === activeTab)?.label}</span><button aria-label="Close sidebar panel" onClick={() => setActiveTab(null)}>×</button></div>
          {activeTab === 'people' && (
            <PeopleContent
              participants={props.allParticipants}
              myParticipantId={props.myParticipantId}
              myRole={props.myRole}
              onStageAction={props.onStageAction}
              focusedParticipantId={props.focusedParticipantId}
              onSpotlightParticipant={props.onSpotlightParticipant}
              remoteStreams={props.remoteStreams}
              peerBandwidthHealth={props.peerBandwidthHealth}
              localStream={props.localStream}
              participantVolumes={props.participantVolumes}
              onParticipantVolumeChange={props.onParticipantVolumeChange}
              audioDuckingEnabled={props.audioDuckingEnabled}
              onAudioDuckingEnabledChange={props.onAudioDuckingEnabledChange}
            />
          )}

          {activeTab === 'chat' && (
            <StudioChat
              messages={props.chatPanelMessages}
              onSend={props.onSendChat}
              onReact={props.onReactChat}
              onToggleStar={props.onToggleChatStar}
              onTogglePin={props.onToggleChatPin}
              externalChatStatuses={props.externalChatStatuses}
              onConnectExternalChat={props.onConnectExternalChat}
              onDisconnectExternalChat={props.onDisconnectExternalChat}
              canManageExternalChat={props.myRole === 'host' || props.myRole === 'co-host'}
              highlightedComment={props.highlightedComment}
              onHighlightComment={props.onHighlightComment}
              onFlashComment={props.onFlashComment}
              onDismissComment={props.onDismissComment}
              senderName={props.chatSenderName}
              typingNames={props.chatTypingNames}
              onTypingChange={props.onChatTypingChange}
              onOpenPopoutChat={props.onOpenPopoutChat}
              participants={props.allParticipants}
              myParticipantId={props.myParticipantId}
            />
          )}

          {activeTab === 'media' && (
            <MediaLibrary
              assets={props.mediaAssets}
              activeMedia={props.activeMedia}
              activeMediaSlideIndex={props.activeMediaSlideIndex}
              onActiveMediaSlideIndexChange={props.onActiveMediaSlideIndexChange}
              onUpload={props.onUploadMedia}
              onAddUrl={props.onAddMediaUrl}
              onPlay={props.onPlayMediaAsset}
              onRemove={props.onRemoveMediaAsset}
              onStop={props.onStopMedia}
              mediaServerHealth={props.mediaServerHealth}
              onRefreshMediaServerHealth={props.onRefreshMediaServerHealth}
            />
          )}

          {activeTab === 'overlays' && <OverlayPanel {...props} />}

          {activeTab === 'brand' && (
            <div style={st.scrollContent}>
              <div style={st.section}>
                <h4 style={st.sectionTitle}>Brand Kit</h4>
                <BrandPreview
                  studioTheme={props.studioTheme}
                  brandColor={props.brandColor}
                  stageBackground={props.stageBackground}
                  logoUrl={props.logoUrl}
                  logoPlacement={props.logoPlacement}
                  logoPosition={props.logoPosition}
                  logoSize={props.logoSize}
                  logoOpacity={props.logoOpacity}
                  cameraShape={props.cameraShape}
                  nameTagStyle={props.nameTagStyle}
                  waitingRoomBranding={props.waitingRoomBranding}
                />
                <details className="studio-brand-setting"><summary>Studio Theme</summary>

                  <div style={st.themeGrid}>
                    {STUDIO_THEME_PRESETS.map((theme) => {
                      const active = props.studioTheme === theme.id;
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          style={{
                            ...st.themeBtn,
                            ...(active ? st.themeBtnActive : {}),
                          }}
                          onClick={() => props.onStudioThemeChange(theme.id)}
                          aria-pressed={active}
                        >
                          <span style={st.themeSwatches}>
                            {theme.swatches.map((swatch) => (
                              <span key={swatch} style={{ ...st.themeSwatch, background: swatch }} />
                            ))}
                          </span>
                          <span style={st.themeLabel}>{theme.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </details>
                <details className="studio-brand-setting"><summary>Presets</summary>

                  <div style={st.brandKitGrid}>
                    {brandKits.map((kit) => (
                      <button key={kit.name} type="button" style={st.brandKitBtn} onClick={() => applyBrandKit(kit)}>
                        <span style={{ ...st.brandKitSwatch, background: kit.stageBackground.type === 'none' ? kit.brandColor : kit.stageBackground.value }} />
                        <span style={st.brandKitName}>{kit.name}</span>
                      </button>
                    ))}
                  </div>
                </details>
                <details className="studio-brand-setting"><summary>Saved Kits</summary>
                  <div style={st.brandLabelRow}>

                    <span style={st.brandKitCount}>{savedBrandKits.length}/{MAX_SAVED_BRAND_KITS}</span>
                  </div>
                  <div style={st.brandSaveRow}>
                    <input
                      type="text"
                      style={st.brandKitInput}
                      placeholder="Kit name"
                      value={brandKitName}
                      onChange={(e) => setBrandKitName(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveCurrentBrandKit();
                      }}
                      maxLength={32}
                    />
                    <button
                      type="button"
                      style={{
                        ...st.brandSaveBtn,
                        ...(savedBrandKits.length >= MAX_SAVED_BRAND_KITS ? st.brandSaveBtnDisabled : {}),
                      }}
                      onClick={saveCurrentBrandKit}
                      disabled={savedBrandKits.length >= MAX_SAVED_BRAND_KITS}
                    >
                      Save
                    </button>
                  </div>
                  {brandKitMessage && <span style={st.brandKitMessage}>{brandKitMessage}</span>}
                  {savedBrandKits.length > 0 && (
                    <div style={st.savedBrandKitList}>
                      {savedBrandKits.map((kit) => (
                        <div key={kit.id} style={st.savedBrandKitCard}>
                          <button
                            type="button"
                            style={st.savedBrandKitApply}
                            onClick={() => applyBrandKit(kit)}
                            title={`Apply ${kit.name}`}
                          >
                            <span style={{ ...st.savedBrandKitSwatch, background: kit.stageBackground.type === 'none' ? kit.brandColor : kit.stageBackground.value }}>
                              {kit.logoUrl && <span style={st.savedBrandKitLogoDot} />}
                            </span>
                            <span style={st.savedBrandKitText}>
                              <span style={st.savedBrandKitName}>{kit.name}</span>
                              <span style={st.savedBrandKitMeta}>{getStudioThemeLabel(kit.studioTheme)} / {kit.cameraShape} / {kit.nameTagStyle}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            style={st.savedBrandKitDelete}
                            title={`Delete ${kit.name}`}
                            onClick={() => deleteSavedBrandKit(kit.id)}
                            aria-label={`Delete ${kit.name}`}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
                <details className="studio-brand-setting"><summary>Logo</summary>

                  <input ref={logoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoUpload} />
                  {props.logoUrl ? (
                    <div style={st.logoPreview}>
                      <img src={props.logoUrl} alt="Logo" style={st.logoImg} />
                      <button style={st.removeImgBtn} onClick={() => { const oldUrl = props.logoUrl; props.onLogoUrlChange(null); if (oldUrl && oldUrl.startsWith('blob:')) { setTimeout(() => URL.revokeObjectURL(oldUrl), 100); } }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <button style={st.uploadBtn} onClick={() => logoInputRef.current?.click()}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      Upload Logo
                    </button>
                  )}
                </details>
                <details className="studio-brand-setting"><summary>Waiting Room</summary>

                  <input
                    type="text"
                    style={st.textInput}
                    value={props.waitingRoomBranding.headline}
                    maxLength={MAX_WAITING_ROOM_HEADLINE_LENGTH}
                    onChange={(e) => props.onWaitingRoomBrandingChange({
                      ...props.waitingRoomBranding,
                      headline: e.currentTarget.value,
                    })}
                    aria-label="Waiting room headline"
                  />
                  <textarea
                    style={st.textArea}
                    value={props.waitingRoomBranding.message}
                    maxLength={MAX_WAITING_ROOM_MESSAGE_LENGTH}
                    rows={3}
                    onChange={(e) => props.onWaitingRoomBrandingChange({
                      ...props.waitingRoomBranding,
                      message: e.currentTarget.value,
                    })}
                    aria-label="Waiting room message"
                  />
                  <div style={st.segmentedTwo}>
                    {[
                      { id: 'brand', label: 'Brand' },
                      { id: 'studio', label: 'Stage' },
                    ].map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        style={{
                          ...st.segmentedBtn,
                          ...(props.waitingRoomBranding.backgroundMode === mode.id ? st.segmentedBtnActive : {}),
                        }}
                        onClick={() => props.onWaitingRoomBrandingChange({
                          ...props.waitingRoomBranding,
                          backgroundMode: mode.id as WaitingRoomBranding['backgroundMode'],
                        })}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  <label style={st.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={props.waitingRoomBranding.showLogo}
                      onChange={(e) => props.onWaitingRoomBrandingChange({
                        ...props.waitingRoomBranding,
                        showLogo: e.currentTarget.checked,
                      })}
                    />
                    <span>Show logo</span>
                  </label>
                </details>
                <details className="studio-brand-setting"><summary>Logo Position</summary>

                  <div style={st.positionGrid}>
                    {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as LogoPlacement[]).map((placement) => (
                      <button
                        key={placement}
                        type="button"
                        style={{ ...st.positionBtn, ...(!props.logoPosition && props.logoPlacement === placement ? st.positionBtnActive : {}) }}
                        onClick={() => {
                          props.onLogoPositionChange(null);
                          props.onLogoPlacementChange(placement);
                        }}
                        title={placement.replace('-', ' ')}
                      >
                        <span style={{ ...st.positionDot, ...getPositionDotStyle(placement) }} />
                      </button>
                    ))}
                  </div>
                  <div style={st.positionModeRow}>
                    <button
                      type="button"
                      style={{ ...st.positionModeBtn, ...(props.logoPosition ? st.positionModeBtnActive : {}) }}
                      onClick={() => props.onLogoPositionChange(props.logoPosition || getLogoPositionFromPlacement(props.logoPlacement))}
                    >
                      Custom
                    </button>
                    <button
                      type="button"
                      style={{ ...st.positionModeBtn, ...(!props.logoPosition ? st.positionModeBtnActive : {}) }}
                      onClick={() => props.onLogoPositionChange(null)}
                    >
                      Corner
                    </button>
                  </div>
                </details>
                <details className="studio-brand-setting"><summary>Logo Size</summary>

                  <div style={st.segmented}>
                    {(['small', 'medium', 'large'] as LogoSize[]).map((size) => (
                      <button
                        key={size}
                        type="button"
                        style={{ ...st.segmentedBtn, ...(props.logoSize === size ? st.segmentedBtnActive : {}) }}
                        onClick={() => props.onLogoSizeChange(size)}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </details>
                <details className="studio-brand-setting"><summary>Watermark Opacity</summary>
                  <div style={st.brandLabelRow}>

                    <span style={st.colorHex}>{Math.round(props.logoOpacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={Math.round(props.logoOpacity * 100)}
                    onChange={(e) => props.onLogoOpacityChange(normalizeLogoOpacity(Number(e.currentTarget.value) / 100))}
                    style={st.opacitySlider}
                    aria-label="Logo watermark opacity"
                  />
                  <div style={st.opacityPresets}>
                    {[
                      { label: 'Subtle', value: 0.45 },
                      { label: 'Standard', value: 0.85 },
                      { label: 'Solid', value: 1 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        style={{
                          ...st.opacityPresetBtn,
                          ...(Math.abs(props.logoOpacity - preset.value) < 0.01 ? st.opacityPresetBtnActive : {}),
                        }}
                        onClick={() => props.onLogoOpacityChange(preset.value)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </details>
                <details className="studio-brand-setting"><summary>Stage Background</summary>

                  <BackgroundPicker value={props.stageBackground} onChange={props.onStageBackgroundChange} />
                </details>
                <details className="studio-brand-setting"><summary>Brand Color</summary>

                  <div style={st.colorGrid}>
                    {brandPresets.map((p) => (
                      <button
                        key={p.color}
                        style={{ ...st.colorSwatch, background: p.color, outline: props.brandColor === p.color ? `2px solid ${p.color}` : 'none', outlineOffset: 2 }}
                        onClick={() => props.onBrandColorChange(p.color)}
                        title={p.name}
                      />
                    ))}
                  </div>
                  <div style={st.colorInfo}>
                    <div style={{ ...st.colorDot, background: props.brandColor }} />
                    <span style={st.colorHex}>{props.brandColor}</span>
                  </div>
                </details>

                <details className="studio-brand-setting"><summary>Camera Shape</summary>

                  <div style={st.shapeGrid}>
                    {(['rectangle', 'rounded', 'square', 'circle'] as CameraShape[]).map((shape) => (
                      <button
                        key={shape}
                        style={{ ...st.shapeBtn, outline: props.cameraShape === shape ? '2px solid var(--accent)' : 'none', outlineOffset: 2 }}
                        onClick={() => props.onCameraShapeChange(shape)}
                        title={shape}
                      >
                        <div style={{ ...st.shapeVisual, borderRadius: shape === 'circle' ? '50%' : shape === 'rounded' ? 8 : shape === 'square' ? 4 : 2, aspectRatio: shape === 'square' || shape === 'circle' ? '1/1' : '16/9' }} />
                        <span style={st.shapeText}>{shape}</span>
                      </button>
                    ))}
                  </div>
                </details>

                <details className="studio-brand-setting"><summary>Name Tag Style</summary>

                  <select
                    style={st.selectInput}
                    value={props.nameTagStyle}
                    onChange={(e) => props.onNameTagStyleChange(e.target.value as NameTagStyle)}
                  >
                    <option value="classic">Classic (Pill)</option>
                    <option value="minimal">Minimal</option>
                    <option value="block">Block (Solid Brand Color)</option>
                  </select>
                </details>
              </div>
            </div>
          )}

          {activeTab === 'scenes' && (
            <div style={st.scrollContent}>
              <div style={st.section}>
                <SceneManager
                  scenes={props.scenes}
                  activeSceneId={props.activeSceneId}
                  sceneTransitionPreset={props.sceneTransitionPreset}
                  sceneStingerClip={props.sceneStingerClip}
                  onSceneTransitionPresetChange={props.onSceneTransitionPresetChange}
                  onSceneStingerClipChange={props.onSceneStingerClipChange}
                  onSaveScene={props.onSaveScene}
                  onCreateTemplateScene={props.onCreateTemplateScene}
                  onCreateProductionScenePack={props.onCreateProductionScenePack}
                  onApplyScene={props.onApplyScene}
                  onDeleteScene={props.onDeleteScene}
                  onRenameScene={props.onRenameScene}
                  onUpdateScene={props.onUpdateScene}
                  onDuplicateScene={props.onDuplicateScene}
                  onReorderScene={props.onReorderScene}
                  onExportScenePack={props.onExportScenePack}
                  onImportScenePack={props.onImportScenePack}
                  scenePackMessage={props.scenePackMessage}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vertical icon strip — always visible (StreamYard / Riverside pattern) */}
      <nav className="studio-tool-rail" aria-label="Studio panels" style={st.iconStrip}>
        {tabDefs.map((tab) => (
          <button
            key={tab.id}
            className={`sidebar-icon-btn ${activeTab === tab.id ? 'active' : ''}`}
            style={{ ...st.iconBtn, ...(activeTab === tab.id ? st.iconBtnActive : {}) }}
            onClick={() => handleTabClick(tab.id)}
            title={tab.label}
            aria-label={tab.label}
            aria-expanded={activeTab === tab.id}
          >
            {tab.icon}
            <span style={st.iconLabel}>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mini video preview for the People tab
// ---------------------------------------------------------------------------
function MiniVideoPreview({ stream, videoEnabled, name }: { stream: MediaStream | null; videoEnabled: boolean; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const initial = (name || '?').charAt(0).toUpperCase();

  if (!stream || !videoEnabled) {
    return (
      <div style={st.miniPreview}>
        <div style={st.miniPreviewPlaceholder}>
          <span style={st.miniPreviewInitial}>{initial}</span>
        </div>
        {!videoEnabled && (
          <div style={st.miniCamOff}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34" />
            </svg>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={st.miniPreview}>
      <video ref={videoRef} autoPlay playsInline muted style={st.miniPreviewVideo} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// People sub-component
// ---------------------------------------------------------------------------
function PeopleContent({
  participants,
  myParticipantId,
  myRole,
  onStageAction,
  focusedParticipantId,
  onSpotlightParticipant,
  remoteStreams,
  peerBandwidthHealth,
  localStream,
  participantVolumes,
  onParticipantVolumeChange,
  audioDuckingEnabled,
  onAudioDuckingEnabledChange,
}: {
  participants: Map<string, Participant>; myParticipantId: string;
  myRole: 'host' | 'co-host' | 'guest';
  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;
  focusedParticipantId: string | null;
  onSpotlightParticipant: (participantId: string | null) => void;
  remoteStreams: Map<string, MediaStream>;
  peerBandwidthHealth: Map<string, PeerBandwidthHealth>;
  localStream: MediaStream | null;
  participantVolumes: Record<string, number>;
  onParticipantVolumeChange: (participantId: string, volume: number) => void;
  audioDuckingEnabled: boolean;
  onAudioDuckingEnabledChange: (enabled: boolean) => void;
}) {
  const isHostOrCoHost = myRole === 'host' || myRole === 'co-host';
  type PStatus = 'on-stage' | 'backstage' | 'green-room';
  const grouped: Record<PStatus, Participant[]> = { 'on-stage': [], 'backstage': [], 'green-room': [] };
  for (const [, p] of participants) {
    if (p.id !== myParticipantId) grouped[p.status].push(p);
  }
  const myP = participants.get(myParticipantId);

  const getStream = (id: string): MediaStream | null => {
    if (id === myParticipantId) return localStream;
    return remoteStreams.get(id) || null;
  };
  const canAdjustOwnVolume = isHostOrCoHost && myP?.status === 'on-stage';
  const isMeSpotlighted = Boolean(myP && focusedParticipantId === myP.id);

  return (
    <div style={st.panelFull}>
      <div style={st.panelHeader}><h3 style={st.panelTitle}>People</h3><span style={st.panelSub}>{participants.size}/12 in session</span></div>
      <div style={st.panelBody}>
        {myP && (
          <div className="participant-item" style={{ ...st.personItem, ...(canAdjustOwnVolume ? st.personItemStack : {}) }}>
            <div style={st.personRow}>
              <div style={st.personLeft}>
                <MiniVideoPreview stream={localStream} videoEnabled={myP.videoEnabled} name={myP.name} />
                <div style={st.personInfo}>
                  <span style={st.personName}>{myP.name}</span>
                  <div style={st.badges}>
                    <span style={{ ...st.roleBadge, background: 'var(--accent-subtle)', color: 'var(--accent)' }}>{myP.role}</span>
                    <span style={st.qualityBadge}>You</span>
                  </div>
                </div>
              </div>
              <div style={st.personRight}>
                <div style={st.mediaIndicators}>
                  <div style={{ ...st.mediaIcon, color: myP.audioEnabled ? 'var(--success)' : 'var(--danger)' }}>
                    {myP.audioEnabled ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" /><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" /></svg>
                    )}
                  </div>
                  <div style={{ ...st.mediaIcon, color: myP.videoEnabled ? 'var(--success)' : 'var(--danger)' }}>
                    {myP.videoEnabled ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23" /><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34" /></svg>
                    )}
                  </div>
                </div>
                {canAdjustOwnVolume && (
                  <div style={st.personActions}>
                    <SmallBtn
                      label={isMeSpotlighted ? 'Clear' : 'Spotlight'}
                      color={isMeSpotlighted ? 'var(--text-muted)' : 'var(--accent)'}
                      onClick={() => onSpotlightParticipant(isMeSpotlighted ? null : myP.id)}
                    />
                  </div>
                )}
              </div>
            </div>
            {canAdjustOwnVolume && (
              <ParticipantVolumeControl
                participant={myP}
                stream={localStream}
                value={participantVolumes[myP.id] ?? 1}
                onChange={onParticipantVolumeChange}
              />
            )}
          </div>
        )}
        {isHostOrCoHost && (
          <label style={st.duckingControl} title="Lower non-speaking broadcast audio while one participant is clearly speaking">
            <span style={st.duckingText}>
              <span style={st.duckingTitle}>Auto ducking</span>
              <span style={st.duckingState}>{audioDuckingEnabled ? 'On' : 'Off'}</span>
            </span>
            <input
              type="checkbox"
              checked={audioDuckingEnabled}
              onChange={(event) => onAudioDuckingEnabledChange(event.currentTarget.checked)}
              aria-label="Auto ducking"
              style={st.duckingCheckbox}
            />
          </label>
        )}
        {grouped['green-room'].length > 0 && (
          <PeopleSection title="Green Room" subtitle="Waiting to be admitted" color="#f59e0b" participants={grouped['green-room']} isHostOrCoHost={isHostOrCoHost} getStream={getStream} peerBandwidthHealth={peerBandwidthHealth} actions={(p) => (<><SmallBtn label="Next" color="var(--accent)" onClick={() => onStageAction('notify-next', p.id)} /><SmallBtn label="Admit" color="var(--success)" onClick={() => onStageAction('move-to-stage', p.id)} /><SmallBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} /><SmallBtn label="Ban" color="var(--danger)" onClick={() => onStageAction('ban', p.id)} /></>)} />
        )}
        <PeopleSection title="On Stage" subtitle="Visible in the broadcast" color="var(--success)" participants={grouped['on-stage']} count={grouped['on-stage'].length + (myP?.status === 'on-stage' ? 1 : 0)} emptyMessage={myP?.status === 'on-stage' ? 'No other participants' : 'No participants'} isHostOrCoHost={isHostOrCoHost} getStream={getStream} peerBandwidthHealth={peerBandwidthHealth} participantVolumes={participantVolumes} onParticipantVolumeChange={onParticipantVolumeChange} showVolumeControls actions={(p) => (<>
          <SmallBtn label={focusedParticipantId === p.id ? 'Clear' : 'Spotlight'} color={focusedParticipantId === p.id ? 'var(--text-muted)' : 'var(--accent)'} onClick={() => onSpotlightParticipant(focusedParticipantId === p.id ? null : p.id)} />
          {p.audioEnabled && <SmallBtn label="Mute" color="var(--text-muted)" onClick={() => onStageAction('mute', p.id)} />}
          {!p.audioEnabled && <SmallBtn label="Ask Unmute" color="var(--success)" onClick={() => onStageAction('unmute', p.id)} />}
          <SmallBtn label="Backstage" color="var(--warning)" onClick={() => onStageAction('move-to-backstage', p.id)} />
          <SmallBtn label="Hold" color="#fbbf24" onClick={() => onStageAction('move-to-green-room', p.id)} />
          {p.role === 'guest' && <SmallBtn label="Co-host" color="var(--accent)" onClick={() => onStageAction('promote-co-host', p.id)} />}
          {p.role === 'co-host' && <SmallBtn label="Demote" color="var(--text-muted)" onClick={() => onStageAction('demote-to-guest', p.id)} />}
          <SmallBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} />
          <SmallBtn label="Ban" color="var(--danger)" onClick={() => onStageAction('ban', p.id)} />
        </>)} />
        {grouped['backstage'].length > 0 && (
          <PeopleSection title="Backstage" subtitle="Off broadcast stage" color="var(--accent)" participants={grouped['backstage']} isHostOrCoHost={isHostOrCoHost} getStream={getStream} peerBandwidthHealth={peerBandwidthHealth} actions={(p) => (<><SmallBtn label="Next" color="var(--accent)" onClick={() => onStageAction('notify-next', p.id)} /><SmallBtn label="To Stage" color="var(--success)" onClick={() => onStageAction('move-to-stage', p.id)} /><SmallBtn label="Hold" color="#fbbf24" onClick={() => onStageAction('move-to-green-room', p.id)} /><SmallBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} /><SmallBtn label="Ban" color="var(--danger)" onClick={() => onStageAction('ban', p.id)} /></>)} />
        )}
        {grouped['green-room'].length > 1 && isHostOrCoHost && (
          <button className="btn-primary" style={st.admitAllBtn} onClick={() => grouped['green-room'].forEach((p) => onStageAction('move-to-stage', p.id))}>
            Admit All ({grouped['green-room'].length})
          </button>
        )}
      </div>
    </div>
  );
}

function PeopleSection({
  title,
  subtitle,
  color,
  participants,
  isHostOrCoHost,
  getStream,
  peerBandwidthHealth,
  participantVolumes = {},
  onParticipantVolumeChange,
  showVolumeControls = false,
  count,
  emptyMessage = 'No participants',
  actions,
}: {
  title: string; subtitle: string; color: string; participants: Participant[];
  isHostOrCoHost: boolean; getStream: (id: string) => MediaStream | null;
  peerBandwidthHealth: Map<string, PeerBandwidthHealth>;
  participantVolumes?: Record<string, number>;
  onParticipantVolumeChange?: (participantId: string, volume: number) => void;
  showVolumeControls?: boolean;
  count?: number;
  emptyMessage?: string;
  actions: (p: Participant) => React.ReactNode;
}) {
  return (
    <div style={st.pSection}>
      <div style={st.pSectionHead}><div style={{ ...st.pDot, background: color }} /><span style={st.pSectionTitle}>{title}</span><span style={st.pSectionCount}>({count ?? participants.length})</span></div>
      <p style={st.pSectionSub}>{subtitle}</p>
      {participants.length === 0 ? <p style={st.emptyText}>{emptyMessage}</p> : (
        <div style={st.pList}>
          {participants.map((p) => {
            const canAdjustVolume = isHostOrCoHost && showVolumeControls && Boolean(onParticipantVolumeChange);
            const health = peerBandwidthHealth.get(p.id);
            return (
              <div key={p.id} className="participant-item" style={{ ...st.personItem, ...st.personItemStack }}>
                <div style={st.personRow}>
                  <div style={st.personLeft}>
                    <MiniVideoPreview stream={getStream(p.id)} videoEnabled={p.videoEnabled} name={p.name} />
                    <div style={st.personInfo}>
                      <span style={st.personName}>{p.name}</span>
                      <div style={st.badges}>
                        {p.role !== 'guest' && <span style={{ ...st.roleBadge, background: p.role === 'host' ? 'var(--accent-subtle)' : 'var(--success-subtle)', color: p.role === 'host' ? 'var(--accent)' : 'var(--success)' }}>{p.role}</span>}
                        {health && (
                          <span
                            style={{ ...st.qualityBadge, ...getPeerBandwidthQualityBadgeStyle(health.quality) }}
                            title={formatPeerBandwidthHealthTitle(health)}
                          >
                            {formatPeerBandwidthQualityLabel(health)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={st.personRight}>
                    <div style={st.mediaIndicators}>
                      <div style={{ ...st.mediaIcon, color: p.audioEnabled ? 'var(--success)' : 'var(--danger)' }}>
                        {p.audioEnabled ? (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /></svg>
                        ) : (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" /><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" /></svg>
                        )}
                      </div>
                      <div style={{ ...st.mediaIcon, color: p.videoEnabled ? 'var(--success)' : 'var(--danger)' }}>
                        {p.videoEnabled ? (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
                        ) : (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="23" y2="23" /><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34" /></svg>
                        )}
                      </div>
                    </div>
                    {isHostOrCoHost && p.role !== 'host' && <div style={st.personActions}>{actions(p)}</div>}
                  </div>
                </div>
                {canAdjustVolume && onParticipantVolumeChange && (
                  <ParticipantVolumeControl
                    participant={p}
                    stream={getStream(p.id)}
                    value={participantVolumes[p.id] ?? 1}
                    onChange={onParticipantVolumeChange}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getPeerBandwidthQualityBadgeStyle(quality: PeerBandwidthQuality): React.CSSProperties {
  switch (quality) {
    case 'good':
      return { background: 'var(--success-subtle)', color: 'var(--success)' };
    case 'fair':
      return { background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24' };
    case 'poor':
      return { background: 'rgba(239, 68, 68, 0.16)', color: 'var(--danger)' };
    default:
      return {};
  }
}

function ParticipantVolumeControl({
  participant,
  stream,
  value,
  onChange,
}: {
  participant: Participant;
  stream: MediaStream | null;
  value: number;
  onChange: (participantId: string, volume: number) => void;
}) {
  const percentage = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1)) * 100);
  const meterStream = participant.audioEnabled ? stream : null;

  return (
    <div style={st.volumeControl}>
      <div style={st.volumeIcon} title={`Broadcast mix for ${participant.name}`}>
        {percentage === 0 ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <line x1="23" y1="9" x2="17" y2="15" />
            <line x1="17" y1="9" x2="23" y2="15" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        )}
      </div>
      <div style={st.volumeStack}>
        <div style={st.volumeMeter} title={`Live audio level for ${participant.name}`}>
          <AudioLevelMeter stream={meterStream} size="small" orientation="horizontal" />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={percentage}
          onChange={(event) => onChange(participant.id, Number(event.currentTarget.value) / 100)}
          aria-label={`Broadcast mix for ${participant.name}`}
          title={`Broadcast mix for ${participant.name}`}
          style={st.volumeSlider}
        />
      </div>
      <span style={st.volumeValue}>{percentage}%</span>
    </div>
  );
}

function SmallBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  const borderColor = color.startsWith('#') ? `${color}33` : 'var(--border-strong)';
  return <button style={{ ...st.smallBtn, color, borderColor }} onClick={onClick}>{label}</button>;
}

// ---------------------------------------------------------------------------
// Brand preview
// ---------------------------------------------------------------------------
function BrandPreview({
  studioTheme,
  brandColor,
  stageBackground,
  logoUrl,
  logoPlacement,
  logoPosition,
  logoSize,
  logoOpacity,
  cameraShape,
  nameTagStyle,
  waitingRoomBranding,
}: {
  studioTheme: StudioThemeId;
  brandColor: string;
  stageBackground: StageBackground;
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
  logoPosition: LogoPosition | null;
  logoSize: LogoSize;
  logoOpacity: number;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
  waitingRoomBranding: WaitingRoomBranding;
}) {
  const background = getBackgroundStyleValue(stageBackground, brandColor);
  const cameraRadius = getCameraShapeRadius(cameraShape);
  const logoStyle = logoPosition
    ? {
        left: `${Math.round(logoPosition.x * 100)}%`,
        top: `${Math.round(logoPosition.y * 100)}%`,
        transform: 'translate(-50%, -50%)',
      }
    : getPositionDotStyle(logoPlacement);
  const logoDimension = logoSize === 'large' ? 34 : logoSize === 'small' ? 20 : 26;

  return (
    <div style={st.brandPreviewCard}>
      <div style={st.brandPreviewStage}>
        <div style={{ ...st.brandPreviewBackdrop, background }} />
        <div style={{ ...st.brandPreviewCamera, borderColor: brandColor, borderRadius: cameraRadius }}>
          <span style={{ ...st.brandPreviewFace, background: `${brandColor}33` }} />
          <span style={{ ...st.brandPreviewNameTag, ...(nameTagStyle === 'block' ? { background: brandColor, color: '#fff' } : {}) }}>
            {nameTagStyle}
          </span>
        </div>
        <div style={{ ...st.brandPreviewLowerThird, borderColor: brandColor }}>
          <span style={{ ...st.brandPreviewLowerAccent, background: brandColor }} />
          <span style={st.brandPreviewLowerLine} />
        </div>
        <div
          style={{
            ...st.brandPreviewLogo,
            ...logoStyle,
            width: logoDimension,
            height: logoDimension,
            opacity: logoUrl ? logoOpacity : 0.75,
          }}
        >
          {logoUrl ? <img src={logoUrl} alt="" style={st.brandPreviewLogoImage} /> : <span style={{ ...st.brandPreviewLogoFallback, background: brandColor }} />}
        </div>
      </div>
      <div style={st.brandPreviewMeta}>
        <span style={st.brandPreviewTitle}>Broadcast Preview</span>
        <span style={st.brandPreviewSub}>
          {getStudioThemeLabel(studioTheme)} / {cameraShape} cameras / {waitingRoomBranding.backgroundMode === 'studio' ? 'stage green room' : 'brand green room'}
        </span>
      </div>
    </div>
  );
}

type OverlayEditorType = 'lower-third' | 'banner' | 'timer' | 'ticker' | 'widget';
type OverlayPanelView = OverlayEditorType | 'choose' | 'packs' | 'speakers' | 'comments' | null;

const OVERLAY_TYPES: { id: OverlayEditorType; label: string; description: string }[] = [
  { id: 'lower-third', label: 'Name & title', description: 'Introduce a speaker' },
  { id: 'banner', label: 'Banner', description: 'A message on screen' },
  { id: 'timer', label: 'Timer', description: 'Count down or keep time' },
  { id: 'ticker', label: 'Ticker', description: 'A scrolling message' },
  { id: 'widget', label: 'Web widget', description: 'Embed an external overlay' },
];

function OverlayPanel(props: SidebarProps) {
  const [view, setView] = useState<OverlayPanelView>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const previousView = useRef<OverlayPanelView>(null);
  useEffect(() => {
    if (view) (viewRef.current?.querySelector<HTMLElement>('input, select') || viewRef.current?.querySelector<HTMLElement>('button'))?.focus();
    else if (previousView.current) addRef.current?.focus();
    previousView.current = view;
  }, [view, editingId]);
  const openView = (next: OverlayPanelView, id: string | null = null) => {
    setEditingId(id);
    setView(next);
  };
  const closeEditor = () => openView(null);
  const lowerThird = props.lowerThirds.find(item => item.id === editingId);
  const banner = props.banners.find(item => item.id === editingId);
  const timer = props.timers.find(item => item.id === editingId);
  const ticker = props.tickers.find(item => item.id === editingId);
  const widget = props.widgets.find(item => item.id === editingId);
  const formatTimer = (value: number) => `${String(Math.floor(Math.abs(value) / 60)).padStart(2, '0')}:${String(Math.abs(value) % 60).padStart(2, '0')}`;
  const items: {
    id: string; type: OverlayEditorType; name: string; caption: string; visible: boolean;
    toggle: () => void; remove: () => void; editable: boolean; timer?: TimerData;
  }[] = [
    ...props.lowerThirds.map(item => ({ id: item.id, type: 'lower-third' as const, name: item.name, caption: item.title || 'Name & title', visible: item.visible, toggle: () => props.onToggleLowerThird(item.id), remove: () => props.onRemoveLowerThird(item.id), editable: Boolean(props.onUpdateLowerThird) && item.source !== 'auto-speaker' })),
    ...props.banners.map(item => ({ id: item.id, type: 'banner' as const, name: item.text, caption: 'Banner', visible: item.visible, toggle: () => props.onToggleBanner(item.id), remove: () => props.onRemoveBanner(item.id), editable: Boolean(props.onUpdateBanner) })),
    ...props.timers.map(item => ({ id: item.id, type: 'timer' as const, name: `${item.mode === 'countdown' ? 'Countdown' : 'Count up'} · ${formatTimer(item.remainingSeconds)}`, caption: item.isRunning ? 'Timer running' : 'Timer paused', visible: item.visible, toggle: () => props.onToggleTimer(item.id), remove: () => props.onRemoveTimer(item.id), editable: true, timer: item })),
    ...props.tickers.map(item => ({ id: item.id, type: 'ticker' as const, name: item.text, caption: 'Ticker', visible: item.visible, toggle: () => props.onToggleTicker(item.id), remove: () => props.onRemoveTicker(item.id), editable: true })),
    ...props.widgets.map(item => ({ id: item.id, type: 'widget' as const, name: item.name, caption: 'Web widget', visible: item.visible, toggle: () => props.onToggleWidget(item.id), remove: () => props.onRemoveWidget(item.id), editable: Boolean(props.onUpdateWidget) })),
  ];
  const dismissMenu = (element: HTMLElement) => element.closest('details')?.removeAttribute('open');
  const hideAll = () => {
    items.filter(item => item.visible).forEach(item => item.toggle());
    if (props.highlightedComment) props.onDismissComment();
    if (props.autoSpeakerLowerThirds) props.onAutoSpeakerLowerThirdsChange(false);
  };

  return (
    <div className="overlay-workspace" style={st.scrollContent}>
      {!view ? <>
        <div className="overlay-toolbar">
          <button ref={addRef} type="button" className="overlay-add" onClick={() => openView('choose')}><span aria-hidden="true">+</span> Add overlay</button>
          <details className="overlay-more" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.removeAttribute('open'); event.currentTarget.querySelector('summary')?.focus(); } }}>
            <summary aria-label="Overlay options">•••</summary>
            <div className="overlay-menu">
              <button type="button" onClick={() => openView('packs')}>Preset packs</button>
              <button type="button" onClick={() => openView('speakers')}>Speaker names</button>
              <button type="button" onClick={() => openView('comments')}>Chat highlights</button>
              <button type="button" disabled={!items.some(item => item.visible) && !props.highlightedComment && !props.autoSpeakerLowerThirds} onClick={event => { hideAll(); dismissMenu(event.currentTarget); }}>Hide all overlays</button>
            </div>
          </details>
        </div>
        {items.length === 0 ? <div className="overlay-empty"><p>Your overlays, ready when you need them.</p><span>Add a name, message, or timer to your stage.</span></div> :
          <ul className="overlay-list" aria-label="Saved overlays">
            {items.map(item => <li key={`${item.type}:${item.id}`} className="overlay-row">
              <div className="overlay-row-copy"><span className="overlay-row-name" title={item.name}>{item.name}</span><span className="overlay-row-caption">{item.caption}</span></div>
              <button type="button" className="overlay-visibility" data-visible={item.visible} aria-label={`${item.visible ? 'Hide' : 'Show'} ${item.name}`} onClick={item.toggle}>{item.visible ? 'Hide' : 'Show'}</button>
              <details className="overlay-more" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.removeAttribute('open'); event.currentTarget.querySelector('summary')?.focus(); } }}>
                <summary aria-label={`Options for ${item.name}`}>•••</summary>
                <div className="overlay-menu">
                  {item.editable && <button type="button" onClick={() => openView(item.type, item.id)}>Edit</button>}
                  {item.timer && <><button type="button" onClick={event => { props.onUpdateTimer(item.id, { isRunning: !item.timer!.isRunning }); dismissMenu(event.currentTarget); }}>{item.timer.isRunning ? 'Pause timer' : 'Start timer'}</button><button type="button" onClick={event => { props.onUpdateTimer(item.id, { isRunning: false, remainingSeconds: item.timer!.mode === 'countdown' ? item.timer!.durationSeconds : 0 }); dismissMenu(event.currentTarget); }}>Reset timer</button></>}
                  <button type="button" className="overlay-remove" onClick={item.remove}>Remove</button>
                </div>
              </details>
            </li>)}
          </ul>}
      </> : <div ref={viewRef} className="overlay-focused-view">
        <div className="overlay-view-heading"><button type="button" onClick={closeEditor} aria-label="Back to overlays">←</button><h3>{view === 'choose' ? 'Add overlay' : view === 'packs' ? 'Preset packs' : view === 'speakers' ? 'Speaker names' : view === 'comments' ? 'Chat highlights' : `${editingId ? 'Edit' : 'Add'} ${OVERLAY_TYPES.find(type => type.id === view)?.label.toLowerCase()}`}</h3></div>
        {view === 'choose' && <div className="overlay-type-list">{OVERLAY_TYPES.map(type => <button key={type.id} type="button" onClick={() => openView(type.id)}><span>{type.label}</span><small>{type.description}</small><span aria-hidden="true">›</span></button>)}</div>}
        {view === 'lower-third' && <LowerThirdManager key={editingId || 'new'} editorOnly initialValue={lowerThird} submitLabel={editingId ? 'Save changes' : 'Add overlay'} lowerThirds={props.lowerThirds} onToggle={props.onToggleLowerThird} onRemove={props.onRemoveLowerThird} onAdd={value => { if (lowerThird) props.onUpdateLowerThird?.(lowerThird.id, value); else props.onAddLowerThird(value); closeEditor(); }} />}
        {view === 'banner' && <BannerManager key={editingId || 'new'} editorOnly initialValue={banner} submitLabel={editingId ? 'Save changes' : 'Add overlay'} banners={props.banners} onToggle={props.onToggleBanner} onRemove={props.onRemoveBanner} onAdd={value => { if (banner) props.onUpdateBanner?.(banner.id, value); else props.onAddBanner(value); closeEditor(); }} />}
        {view === 'timer' && <TimerManager key={editingId || 'new'} editorOnly initialValue={timer} submitLabel={editingId ? 'Save changes' : 'Add overlay'} timers={props.timers} onToggle={props.onToggleTimer} onRemove={props.onRemoveTimer} onUpdate={props.onUpdateTimer} onAdd={value => {
          if (timer) {
            const configurationChanged = timer.mode !== value.mode || timer.durationSeconds !== value.durationSeconds;
            props.onUpdateTimer(timer.id, configurationChanged ? value : { mode: value.mode, durationSeconds: value.durationSeconds, position: value.position, style: value.style });
          } else props.onAddTimer(value);
          closeEditor();
        }} />}
        {view === 'ticker' && <TickerManager key={editingId || 'new'} editorOnly initialValue={ticker} submitLabel={editingId ? 'Save changes' : 'Add overlay'} tickers={props.tickers} onToggle={props.onToggleTicker} onRemove={props.onRemoveTicker} onUpdate={props.onUpdateTicker} onAdd={value => { if (ticker) props.onUpdateTicker(ticker.id, value); else props.onAddTicker(value); closeEditor(); }} />}
        {view === 'widget' && <WidgetOverlayManager key={editingId || 'new'} editorOnly initialValue={widget} submitLabel={editingId ? 'Save changes' : 'Add overlay'} widgets={props.widgets} onToggle={props.onToggleWidget} onRemove={props.onRemoveWidget} onAdd={value => { if (widget) props.onUpdateWidget?.(widget.id, value); else props.onAddWidget(value); closeEditor(); }} />}
        {view === 'speakers' && <div className="overlay-speakers"><label><span>Automatic speaker names</span><input type="checkbox" checked={props.autoSpeakerLowerThirds} onChange={event => props.onAutoSpeakerLowerThirdsChange(event.target.checked)} /></label><p>Show the active speaker’s name automatically.</p><div className="overlay-speaker-list">{Array.from(props.allParticipants.values()).filter(person => person.status === 'on-stage').map(person => <button key={person.id} type="button" onClick={() => { props.onAddLowerThird({ name: person.name, title: person.role === 'host' ? 'Host' : person.role === 'co-host' ? 'Co-host' : 'Guest', style: 'bold', durationSeconds: 10, animation: 'slide', animationDirection: 'left', visible: true, source: 'participant', participantId: person.id }); closeEditor(); }}><span>{person.name}</span><small>Show name</small></button>)}</div></div>}
        {view === 'packs' && <OverlayPacks hostName={props.chatSenderName} brandColor={props.brandColor} onAddLowerThird={props.onAddLowerThird} onAddBanner={props.onAddBanner} onAddTimer={props.onAddTimer} onAddTicker={props.onAddTicker} onDone={closeEditor} />}
        {view === 'comments' && <CommentHighlightManager chatMessages={props.chatMessages} activeComment={props.highlightedComment} onHighlightComment={props.onHighlightComment} onFlashComment={props.onFlashComment} onDismissComment={props.onDismissComment} />}
      </div>}
    </div>
  );
}

function OverlayPacks({ hostName, brandColor, onAddLowerThird, onAddBanner, onAddTimer, onAddTicker, onDone }: Pick<SidebarProps, 'brandColor' | 'onAddLowerThird' | 'onAddBanner' | 'onAddTimer' | 'onAddTicker'> & { hostName: string; onDone: () => void }) {
  const addLiveShowPack = () => {
    onAddLowerThird({
      name: hostName || 'Host',
      title: 'Live Host',
      style: 'bold',
      durationSeconds: 20,
      accentColor: brandColor,
      animation: 'slide',
      animationDirection: 'left',
      visible: true,
    });
    onAddBanner({ text: 'We are live', style: 'info', isTicker: false, position: 'top', durationSeconds: 20, visible: true });
  };

  const addWebinarPack = () => {
    onAddBanner({ text: 'Send your questions in chat', style: 'custom', customColor: brandColor, isTicker: false, position: 'bottom', visible: true });
    onAddTimer({ mode: 'countup', durationSeconds: 0, remainingSeconds: 0, isRunning: true, position: 'top-right', style: 'minimal', visible: true });
  };

  const addCountdownPack = () => {
    onAddBanner({ text: 'Starting soon', style: 'custom', customColor: brandColor, isTicker: false, position: 'top', visible: true });
    onAddTimer({ mode: 'countdown', durationSeconds: 300, remainingSeconds: 300, isRunning: true, position: 'bottom-right', style: 'bold', visible: true });
  };

  const addTickerPack = () => {
    onAddTicker({ text: 'Welcome to the live stream', speed: 'normal', backgroundColor: brandColor, textColor: '#ffffff', separator: '\u2022', visible: true });
  };

  const addOfferPack = () => {
    onAddBanner({
      text: 'Limited offer - check the link in chat',
      style: 'custom',
      customColor: '#059669',
      isTicker: false,
      position: 'bottom',
      durationSeconds: 60,
      visible: true,
    });
    onAddTicker({
      text: 'Subscribe for updates and replay links',
      speed: 'slow',
      backgroundColor: '#111827',
      textColor: '#ffffff',
      separator: '\u2022',
      visible: true,
    });
  };

  const packs = [
    { label: 'Live Show', meta: 'Host ID + live bug', color: brandColor, action: addLiveShowPack },
    { label: 'Webinar Q&A', meta: 'Questions + timer', color: '#2563eb', action: addWebinarPack },
    { label: 'Countdown', meta: 'Starting soon', color: '#f59e0b', action: addCountdownPack },
    { label: 'Ticker', meta: 'Scrolling message', color: '#06b6d4', action: addTickerPack },
    { label: 'Offer CTA', meta: 'Banner + ticker', color: '#059669', action: addOfferPack },
  ];
  return <div className="overlay-type-list">{packs.map(pack => <button key={pack.label} type="button" onClick={() => { pack.action(); onDone(); }}><span>{pack.label}</span><small>{pack.meta}</small><span aria-hidden="true">›</span></button>)}</div>;
}

function getPositionDotStyle(placement: LogoPlacement): React.CSSProperties {
  switch (placement) {
    case 'top-left': return { top: 4, left: 4 };
    case 'top-right': return { top: 4, right: 4 };
    case 'bottom-left': return { bottom: 4, left: 4 };
    case 'bottom-right': return { bottom: 4, right: 4 };
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const st: Record<string, React.CSSProperties> = {
  wrapper: { display: 'flex', height: '100%', flexShrink: 0 },
  contentPanel: { width: 340, display: 'flex', flexDirection: 'column', background: 'var(--glass-bg)', borderLeft: '1px solid var(--border)', height: '100%', overflow: 'hidden', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)' },
  scrollContent: { flex: 1, overflowY: 'auto' },
  iconStrip: { width: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8, gap: 2, background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', height: '100%', flexShrink: 0 },
  iconBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, width: 48, height: 48, borderRadius: 10, background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer', padding: 0, transition: 'all 0.15s ease' },
  iconBtnActive: { background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  iconLabel: { fontSize: 9, fontWeight: 500, lineHeight: 1 },
  section: { padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 },
  divider: { height: 1, background: 'var(--border)', margin: '4px 16px 8px' },
  brandPreviewCard: { marginBottom: 16, overflow: 'hidden', borderRadius: 10, border: '1px solid rgba(167, 139, 250, 0.26)', background: 'rgba(15, 23, 42, 0.42)' },
  brandPreviewStage: { position: 'relative', aspectRatio: '16 / 9', overflow: 'hidden', background: '#0f172a' },
  brandPreviewBackdrop: { position: 'absolute', inset: 0, opacity: 0.98 },
  brandPreviewCamera: { position: 'absolute', left: '18%', right: '18%', top: '23%', bottom: '22%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderStyle: 'solid', background: 'rgba(2, 6, 23, 0.58)', overflow: 'hidden', boxShadow: '0 16px 34px rgba(0, 0, 0, 0.34)' },
  brandPreviewFace: { width: 44, height: 44, borderRadius: '50%', boxShadow: '0 0 0 18px rgba(255, 255, 255, 0.035)' },
  brandPreviewNameTag: { position: 'absolute', left: 12, bottom: 10, minWidth: 54, maxWidth: '70%', height: 19, padding: '0 8px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2, 6, 23, 0.82)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.86)', fontSize: 9, fontWeight: 800, textTransform: 'capitalize', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  brandPreviewLowerThird: { position: 'absolute', left: 18, bottom: 18, width: 126, height: 30, borderRadius: 8, borderWidth: 1, borderStyle: 'solid', background: 'rgba(2, 6, 23, 0.72)', boxShadow: '0 10px 22px rgba(0, 0, 0, 0.26)', overflow: 'hidden' },
  brandPreviewLowerAccent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5 },
  brandPreviewLowerLine: { position: 'absolute', left: 15, right: 14, top: 12, height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.58)' },
  brandPreviewLogo: { position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(2, 6, 23, 0.48)', border: '1px solid rgba(255,255,255,0.16)', overflow: 'hidden', boxShadow: '0 8px 18px rgba(0,0,0,0.25)' },
  brandPreviewLogoImage: { width: '100%', height: '100%', objectFit: 'contain', padding: 4 },
  brandPreviewLogoFallback: { width: '54%', height: '54%', borderRadius: 4 },
  brandPreviewMeta: { display: 'flex', flexDirection: 'column', gap: 2, padding: '9px 10px' },
  brandPreviewTitle: { fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' },
  brandPreviewSub: { fontSize: 10, lineHeight: 1.35, color: 'var(--text-muted)', textTransform: 'capitalize' },
  brandGroup: { marginBottom: 16 },
  brandLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 },
  brandLabelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  brandKitCount: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 },
  brandKitGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 },
  brandKitBtn: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', borderRadius: 8, padding: 8, cursor: 'pointer', minWidth: 0 },
  brandKitSwatch: { display: 'block', height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' },
  brandKitName: { fontSize: 11, fontWeight: 700, textAlign: 'left' },
  themeGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 },
  themeBtn: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', padding: 7, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' },
  themeBtnActive: { borderColor: 'var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)', boxShadow: 'inset 0 0 0 1px var(--accent)' },
  themeSwatches: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, height: 24, overflow: 'hidden', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' },
  themeSwatch: { display: 'block', minWidth: 0 },
  themeLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 800, textAlign: 'center' },
  brandSaveRow: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, marginBottom: 8 },
  brandKitInput: { minWidth: 0, width: '100%', padding: '7px 9px', fontSize: 12, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none' },
  brandSaveBtn: { padding: '7px 10px', fontSize: 11, fontWeight: 700, color: 'white', background: 'var(--accent)', border: 'none', borderRadius: 8, cursor: 'pointer' },
  brandSaveBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  brandKitMessage: { display: 'block', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: 8 },
  savedBrandKitList: { display: 'flex', flexDirection: 'column', gap: 6 },
  savedBrandKitCard: { display: 'grid', gridTemplateColumns: '1fr 28px', alignItems: 'stretch', gap: 4 },
  savedBrandKitApply: { minWidth: 0, display: 'grid', gridTemplateColumns: '42px 1fr', alignItems: 'center', gap: 8, padding: 6, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', borderRadius: 8, cursor: 'pointer', textAlign: 'left' },
  savedBrandKitSwatch: { position: 'relative', display: 'block', height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' },
  savedBrandKitLogoDot: { position: 'absolute', right: 4, bottom: 4, width: 8, height: 8, borderRadius: 2, background: 'rgba(255,255,255,0.9)', boxShadow: '0 0 0 1px rgba(0,0,0,0.25)' },
  savedBrandKitText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  savedBrandKitName: { minWidth: 0, fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  savedBrandKitMeta: { minWidth: 0, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'capitalize' },
  savedBrandKitDelete: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, minWidth: 28, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 },
  uploadBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, fontSize: 12, fontWeight: 500, background: 'none', color: 'var(--text-muted)', border: '1px dashed var(--border-strong)', borderRadius: 10, cursor: 'pointer', transition: 'all var(--transition-fast)' },
  logoPreview: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 60, borderRadius: 8, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', overflow: 'hidden' },
  logoImg: { maxHeight: 48, maxWidth: '100%', objectFit: 'contain' },
  removeImgBtn: { position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 4, background: 'rgba(0,0,0,0.6)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  colorGrid: { display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 4, marginBottom: 8 },
  colorSwatch: { width: '100%', aspectRatio: '1', borderRadius: 6, border: 'none', cursor: 'pointer', transition: 'transform 0.1s' },
  colorInfo: { display: 'flex', alignItems: 'center', gap: 6 },
  colorDot: { width: 12, height: 12, borderRadius: 4 },
  colorHex: { fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' },
  positionGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 },
  positionBtn: { height: 40, position: 'relative', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-tertiary)', cursor: 'pointer' },
  positionBtnActive: { border: '1px solid var(--accent)', boxShadow: 'inset 0 0 0 1px var(--accent)' },
  positionDot: { position: 'absolute', width: 10, height: 10, borderRadius: 3, background: 'var(--accent)' },
  positionModeRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 6, padding: 3, background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: '1px solid var(--border)' },
  positionModeBtn: { height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  positionModeBtnActive: { background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  segmented: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: 3, background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: '1px solid var(--border)' },
  segmentedTwo: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, padding: 3, background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 8 },
  segmentedBtn: { height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize' },
  segmentedBtnActive: { background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  textInput: { width: '100%', minWidth: 0, padding: '8px 10px', marginBottom: 8, fontSize: 12, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none' },
  textArea: { width: '100%', minWidth: 0, resize: 'vertical', padding: '8px 10px', marginBottom: 8, fontSize: 12, lineHeight: 1.4, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontFamily: 'inherit' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  opacitySlider: { width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' },
  opacityPresets: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginTop: 8 },
  opacityPresetBtn: { minWidth: 0, padding: '6px 4px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer' },
  opacityPresetBtnActive: { borderColor: 'var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  shapeGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 },
  shapeBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s ease' },
  shapeVisual: { width: 32, background: 'var(--border-strong)' },
  shapeText: { fontSize: 10, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'capitalize' },
  selectInput: { width: '100%', padding: '8px 12px', fontSize: 13, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none' },
  // Panel layout
  panelFull: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  panelHeader: { padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  panelTitleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  panelTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
  panelSub: { fontSize: 11, color: 'var(--text-muted)', margin: 0, marginTop: 2 },
  panelBody: { flex: 1, overflowY: 'auto', padding: '8px 0' },
  // People
  pSection: { padding: '8px 16px 12px' },
  pSectionHead: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 },
  pDot: { width: 8, height: 8, borderRadius: '50%' },
  pSectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },
  pSectionCount: { fontSize: 12, color: 'var(--text-muted)' },
  pSectionSub: { fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 },
  emptyText: { fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' },
  pList: { display: 'flex', flexDirection: 'column', gap: 4 },
  personItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: 10, gap: 8, margin: '0 0 4px', border: '1px solid rgba(255, 255, 255, 0.04)' },
  personItemStack: { flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', gap: 7 },
  personRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 },
  personLeft: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 },
  personAvatar: { width: 30, height: 30, borderRadius: '50%', background: 'rgba(167, 139, 250, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#c4b5fd', flexShrink: 0 },
  personInfo: { minWidth: 0, flex: 1 },
  personRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  personName: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', display: 'block' },
  // Mini video preview
  miniPreview: { width: 48, height: 36, borderRadius: 6, overflow: 'hidden', flexShrink: 0, position: 'relative', background: 'rgba(0, 0, 0, 0.3)', border: '1px solid rgba(255, 255, 255, 0.08)' },
  miniPreviewVideo: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' },
  miniPreviewPlaceholder: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(167, 139, 250, 0.1)' },
  miniPreviewInitial: { fontSize: 13, fontWeight: 600, color: '#c4b5fd' },
  miniCamOff: { position: 'absolute', bottom: 2, right: 2, width: 14, height: 14, borderRadius: 3, background: 'rgba(239, 68, 68, 0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' },
  // Media indicators
  mediaIndicators: { display: 'flex', gap: 4, alignItems: 'center' },
  mediaIcon: { width: 20, height: 20, borderRadius: 4, background: 'rgba(255, 255, 255, 0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  badges: { display: 'flex', gap: 4, marginTop: 2 },
  roleBadge: { fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.04em' },
  qualityBadge: { fontSize: 9, fontWeight: 500, padding: '1px 5px', borderRadius: 4, background: 'var(--bg-surface)', color: 'var(--text-muted)' },
  muteBadge: { fontSize: 9, fontWeight: 500, padding: '1px 5px', borderRadius: 4, background: 'rgba(239,68,68,0.1)', color: '#ef4444' },
  personActions: { display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'flex-end', gap: 3, flexShrink: 1, maxWidth: 220 },
  smallBtn: { fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 5, background: 'transparent', border: '1px solid', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 150ms' },
  volumeControl: { display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr) 34px', alignItems: 'center', gap: 7, paddingLeft: 56 },
  volumeIcon: { width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' },
  volumeStack: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  volumeMeter: { width: '100%', minWidth: 0, height: 3 },
  volumeSlider: { width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' },
  volumeValue: { fontSize: 10, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', textAlign: 'right' },
  duckingControl: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '0 16px 8px', padding: '9px 10px', borderRadius: 8, border: '1px solid rgba(96, 165, 250, 0.24)', background: 'rgba(96, 165, 250, 0.08)', cursor: 'pointer' },
  duckingText: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 },
  duckingTitle: { fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' },
  duckingState: { fontSize: 10, fontWeight: 800, color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.04em' },
  duckingCheckbox: { width: 16, height: 16, margin: 0, accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 },
  admitAllBtn: { margin: '8px 16px', width: 'calc(100% - 32px)', fontSize: 13, padding: '8px 14px' },
  // Chat

};
