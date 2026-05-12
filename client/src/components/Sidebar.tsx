import { useState, useRef, useEffect } from 'react';
import type { ActiveMedia, LogoPlacement, LogoSize, StageBackground, Scene, ChatMessage, Participant, StageActionPayload, CameraShape, NameTagStyle, StudioMediaAsset } from '@studio/shared';
import { LowerThirdManager, type LowerThirdData } from './LowerThird.tsx';
import { BannerManager, type BannerData } from './BannerOverlay.tsx';
import { TimerManager, type TimerData } from './TimerOverlay.tsx';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { SceneManager } from './SceneManager.tsx';
import { TickerManager, type TickerData } from './TickerOverlay.tsx';
import { CommentHighlightManager, type HighlightedComment } from './CommentHighlight.tsx';
import { MediaLibrary } from './MediaLibrary.tsx';

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
  banners: BannerData[];
  onAddBanner: (banner: Omit<BannerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleBanner: (id: string) => void;
  onRemoveBanner: (id: string) => void;
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
  // Comment highlight
  chatMessages: ChatMessage[];
  highlightedComment: HighlightedComment | null;
  onHighlightComment: (comment: HighlightedComment) => void;
  onDismissComment: () => void;
  // Brand props
  stageBackground: StageBackground;
  onStageBackgroundChange: (bg: StageBackground) => void;
  brandColor: string;
  onBrandColorChange: (color: string) => void;
  logoUrl: string | null;
  onLogoUrlChange: (url: string | null) => void;
  logoPlacement: LogoPlacement;
  onLogoPlacementChange: (placement: LogoPlacement) => void;
  logoSize: LogoSize;
  onLogoSizeChange: (size: LogoSize) => void;
  cameraShape: CameraShape;
  onCameraShapeChange: (shape: CameraShape) => void;
  nameTagStyle: NameTagStyle;
  onNameTagStyleChange: (style: NameTagStyle) => void;
  // Media props
  mediaAssets: StudioMediaAsset[];
  activeMedia: ActiveMedia | null;
  onUploadMedia: (files: FileList | File[]) => void;
  onAddMediaUrl: (url: string, type: 'video' | 'image') => void;
  onPlayMediaAsset: (asset: StudioMediaAsset) => void;
  onRemoveMediaAsset: (assetId: string) => void;
  onStopMedia: () => void;
  // Scene props
  scenes: Scene[];
  activeSceneId: string | null;
  onSaveScene: (name: string) => void | Promise<void>;
  onApplyScene: (sceneId: string) => void;
  onDeleteScene: (sceneId: string) => void;
  onRenameScene: (sceneId: string, newName: string) => void;
  // Chat props
  chatPanelMessages: ChatMessage[];
  onSendChat: (content: string, isBackstage?: boolean) => void;
  chatSenderName: string;
  // People props
  allParticipants: Map<string, Participant>;
  myParticipantId: string;
  myRole: 'host' | 'co-host' | 'guest';
  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;
  // Streams for live previews in People tab
  remoteStreams: Map<string, MediaStream>;
  localStream: MediaStream | null;
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

// ---------------------------------------------------------------------------
// Main Sidebar component
// ---------------------------------------------------------------------------
export function Sidebar(props: SidebarProps) {
  const [internalActiveTab, setInternalActiveTab] = useState<SidebarTab | null>('people');
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

  const brandKits: Array<{
    name: string;
    color: string;
    background: StageBackground;
    cameraShape: CameraShape;
    nameTagStyle: NameTagStyle;
    logoSize: LogoSize;
  }> = [
    { name: 'Broadcast', color: '#ef4444', background: { type: 'gradient', value: 'linear-gradient(135deg, #111827 0%, #7f1d1d 100%)' }, cameraShape: 'rounded', nameTagStyle: 'block', logoSize: 'medium' },
    { name: 'Webinar', color: '#2563eb', background: { type: 'gradient', value: 'linear-gradient(135deg, #0f172a 0%, #1d4ed8 100%)' }, cameraShape: 'rounded', nameTagStyle: 'classic', logoSize: 'small' },
    { name: 'Podcast', color: '#db2777', background: { type: 'gradient', value: 'linear-gradient(135deg, #18181b 0%, #831843 100%)' }, cameraShape: 'circle', nameTagStyle: 'minimal', logoSize: 'medium' },
    { name: 'Executive', color: '#059669', background: { type: 'color', value: '#111827' }, cameraShape: 'rectangle', nameTagStyle: 'classic', logoSize: 'large' },
  ];

  const applyBrandKit = (kit: (typeof brandKits)[number]) => {
    props.onBrandColorChange(kit.color);
    props.onStageBackgroundChange(kit.background);
    props.onCameraShapeChange(kit.cameraShape);
    props.onNameTagStyleChange(kit.nameTagStyle);
    props.onLogoSizeChange(kit.logoSize);
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
    <div style={st.wrapper}>
      {/* Content panel — only visible when a tab is active */}
      {activeTab && (
        <div style={st.contentPanel}>
          {activeTab === 'people' && (
            <PeopleContent
              participants={props.allParticipants}
              myParticipantId={props.myParticipantId}
              myRole={props.myRole}
              onStageAction={props.onStageAction}
              remoteStreams={props.remoteStreams}
              localStream={props.localStream}
            />
          )}

          {activeTab === 'chat' && (
            <ChatContent
              messages={props.chatPanelMessages}
              onSend={props.onSendChat}
              senderName={props.chatSenderName}
            />
          )}

          {activeTab === 'media' && (
            <MediaLibrary
              assets={props.mediaAssets}
              activeMedia={props.activeMedia}
              onUpload={props.onUploadMedia}
              onAddUrl={props.onAddMediaUrl}
              onPlay={props.onPlayMediaAsset}
              onRemove={props.onRemoveMediaAsset}
              onStop={props.onStopMedia}
            />
          )}

          {activeTab === 'overlays' && (
            <div style={st.scrollContent}>
              <OverlayQuickActions
                hostName={props.chatSenderName}
                brandColor={props.brandColor}
                lowerThirds={props.lowerThirds}
                banners={props.banners}
                timers={props.timers}
                tickers={props.tickers}
                onAddLowerThird={props.onAddLowerThird}
                onToggleLowerThird={props.onToggleLowerThird}
                onAddBanner={props.onAddBanner}
                onToggleBanner={props.onToggleBanner}
                onAddTimer={props.onAddTimer}
                onToggleTimer={props.onToggleTimer}
                onAddTicker={props.onAddTicker}
                onToggleTicker={props.onToggleTicker}
              />
              <div style={st.divider} />
              <LowerThirdManager
                lowerThirds={props.lowerThirds}
                onAdd={props.onAddLowerThird}
                onToggle={props.onToggleLowerThird}
                onRemove={props.onRemoveLowerThird}
              />
              <div style={st.divider} />
              <BannerManager
                banners={props.banners}
                onAdd={props.onAddBanner}
                onToggle={props.onToggleBanner}
                onRemove={props.onRemoveBanner}
              />
              <div style={st.divider} />
              <TimerManager
                timers={props.timers}
                onAdd={props.onAddTimer}
                onToggle={props.onToggleTimer}
                onRemove={props.onRemoveTimer}
                onUpdate={props.onUpdateTimer}
              />
              <div style={st.divider} />
              <TickerManager
                tickers={props.tickers}
                onAdd={props.onAddTicker}
                onToggle={props.onToggleTicker}
                onRemove={props.onRemoveTicker}
                onUpdate={props.onUpdateTicker}
              />
              <div style={st.divider} />
              <CommentHighlightManager
                chatMessages={props.chatMessages}
                activeComment={props.highlightedComment}
                onHighlightComment={props.onHighlightComment}
                onDismissComment={props.onDismissComment}
              />
            </div>
          )}

          {activeTab === 'brand' && (
            <div style={st.scrollContent}>
              <div style={st.section}>
                <h4 style={st.sectionTitle}>Brand Kit</h4>
                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Presets</span>
                  <div style={st.brandKitGrid}>
                    {brandKits.map((kit) => (
                      <button key={kit.name} type="button" style={st.brandKitBtn} onClick={() => applyBrandKit(kit)}>
                        <span style={{ ...st.brandKitSwatch, background: kit.background.type === 'none' ? kit.color : kit.background.value }} />
                        <span style={st.brandKitName}>{kit.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Logo</span>
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
                </div>
                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Logo Position</span>
                  <div style={st.positionGrid}>
                    {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as LogoPlacement[]).map((placement) => (
                      <button
                        key={placement}
                        type="button"
                        style={{ ...st.positionBtn, ...(props.logoPlacement === placement ? st.positionBtnActive : {}) }}
                        onClick={() => props.onLogoPlacementChange(placement)}
                        title={placement.replace('-', ' ')}
                      >
                        <span style={{ ...st.positionDot, ...getPositionDotStyle(placement) }} />
                      </button>
                    ))}
                  </div>
                </div>
                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Logo Size</span>
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
                </div>
                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Stage Background</span>
                  <BackgroundPicker value={props.stageBackground} onChange={props.onStageBackgroundChange} />
                </div>
                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Brand Color</span>
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
                </div>

                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Camera Shape</span>
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
                </div>

                <div style={st.brandGroup}>
                  <span style={st.brandLabel}>Name Tag Style</span>
                  <select 
                    style={st.selectInput} 
                    value={props.nameTagStyle} 
                    onChange={(e) => props.onNameTagStyleChange(e.target.value as NameTagStyle)}
                  >
                    <option value="classic">Classic (Pill)</option>
                    <option value="minimal">Minimal</option>
                    <option value="block">Block (Solid Brand Color)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'scenes' && (
            <div style={st.scrollContent}>
              <div style={st.section}>
                <SceneManager scenes={props.scenes} activeSceneId={props.activeSceneId} onSaveScene={props.onSaveScene} onApplyScene={props.onApplyScene} onDeleteScene={props.onDeleteScene} onRenameScene={props.onRenameScene} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vertical icon strip — always visible (StreamYard / Riverside pattern) */}
      <div style={st.iconStrip}>
        {tabDefs.map((tab) => (
          <button
            key={tab.id}
            className={`sidebar-icon-btn ${activeTab === tab.id ? 'active' : ''}`}
            style={{ ...st.iconBtn, ...(activeTab === tab.id ? st.iconBtnActive : {}) }}
            onClick={() => handleTabClick(tab.id)}
            title={tab.label}
          >
            {tab.icon}
            <span style={st.iconLabel}>{tab.label}</span>
          </button>
        ))}
      </div>
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
function PeopleContent({ participants, myParticipantId, myRole, onStageAction, remoteStreams, localStream }: {
  participants: Map<string, Participant>; myParticipantId: string;
  myRole: 'host' | 'co-host' | 'guest';
  onStageAction: (action: StageActionPayload['action'], targetId: string) => void;
  remoteStreams: Map<string, MediaStream>;
  localStream: MediaStream | null;
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

  return (
    <div style={st.panelFull}>
      <div style={st.panelHeader}><h3 style={st.panelTitle}>People</h3><span style={st.panelSub}>{participants.size}/12 in session</span></div>
      <div style={st.panelBody}>
        {myP && (
          <div className="participant-item" style={st.personItem}>
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
          </div>
        )}
        {grouped['green-room'].length > 0 && (
          <PeopleSection title="Green Room" subtitle="Waiting to be admitted" color="#f59e0b" participants={grouped['green-room']} isHostOrCoHost={isHostOrCoHost} getStream={getStream} actions={(p) => (<><SmallBtn label="Admit" color="var(--success)" onClick={() => onStageAction('move-to-stage', p.id)} /><SmallBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} /></>)} />
        )}
        <PeopleSection title="On Stage" subtitle="Visible in the broadcast" color="var(--success)" participants={grouped['on-stage']} isHostOrCoHost={isHostOrCoHost} getStream={getStream} actions={(p) => (<>
          {p.audioEnabled && <SmallBtn label="Mute" color="var(--text-muted)" onClick={() => onStageAction('mute', p.id)} />}
          {!p.audioEnabled && <SmallBtn label="Unmute" color="var(--success)" onClick={() => onStageAction('unmute', p.id)} />}
          <SmallBtn label="Backstage" color="var(--warning)" onClick={() => onStageAction('move-to-backstage', p.id)} />
          {p.role === 'guest' && <SmallBtn label="Co-host" color="var(--accent)" onClick={() => onStageAction('promote-co-host', p.id)} />}
          {p.role === 'co-host' && <SmallBtn label="Demote" color="var(--text-muted)" onClick={() => onStageAction('demote-to-guest', p.id)} />}
        </>)} />
        {grouped['backstage'].length > 0 && (
          <PeopleSection title="Backstage" subtitle="Can hear but not visible" color="var(--accent)" participants={grouped['backstage']} isHostOrCoHost={isHostOrCoHost} getStream={getStream} actions={(p) => (<><SmallBtn label="To Stage" color="var(--success)" onClick={() => onStageAction('move-to-stage', p.id)} /><SmallBtn label="Remove" color="var(--danger)" onClick={() => onStageAction('remove', p.id)} /></>)} />
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

function PeopleSection({ title, subtitle, color, participants, isHostOrCoHost, getStream, actions }: {
  title: string; subtitle: string; color: string; participants: Participant[];
  isHostOrCoHost: boolean; getStream: (id: string) => MediaStream | null;
  actions: (p: Participant) => React.ReactNode;
}) {
  return (
    <div style={st.pSection}>
      <div style={st.pSectionHead}><div style={{ ...st.pDot, background: color }} /><span style={st.pSectionTitle}>{title}</span><span style={st.pSectionCount}>({participants.length})</span></div>
      <p style={st.pSectionSub}>{subtitle}</p>
      {participants.length === 0 ? <p style={st.emptyText}>No participants</p> : (
        <div style={st.pList}>
          {participants.map((p) => (
            <div key={p.id} className="participant-item" style={st.personItem}>
              <div style={st.personLeft}>
                <MiniVideoPreview stream={getStream(p.id)} videoEnabled={p.videoEnabled} name={p.name} />
                <div style={st.personInfo}>
                  <span style={st.personName}>{p.name}</span>
                  <div style={st.badges}>
                    {p.role !== 'guest' && <span style={{ ...st.roleBadge, background: p.role === 'host' ? 'var(--accent-subtle)' : 'var(--success-subtle)', color: p.role === 'host' ? 'var(--accent)' : 'var(--success)' }}>{p.role}</span>}
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
          ))}
        </div>
      )}
    </div>
  );
}

function SmallBtn({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  const borderColor = color.startsWith('#') ? `${color}33` : 'var(--border-strong)';
  return <button style={{ ...st.smallBtn, color, borderColor }} onClick={onClick}>{label}</button>;
}

// ---------------------------------------------------------------------------
// Chat sub-component
// ---------------------------------------------------------------------------
function ChatContent({ messages, onSend, senderName }: { messages: ChatMessage[]; onSend: (c: string, isBackstage?: boolean) => void; senderName: string }) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'public' | 'backstage'>('public');
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const publicMessages = messages.filter((msg) => !msg.isBackstage);
  const backstageMessages = messages.filter((msg) => msg.isBackstage);
  const visibleMessages = mode === 'backstage' ? backstageMessages : publicMessages;

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  useEffect(() => {
    if (isNearBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages.length, mode]);

  const handleSend = () => {
    const t = input.trim();
    if (!t) return;
    onSend(t, mode === 'backstage');
    setInput('');
  };

  return (
    <div style={st.panelFull}>
      <div style={st.panelHeader}>
        <h3 style={st.panelTitle}>Chat</h3>
        <div style={st.chatTabs} role="tablist" aria-label="Chat channel">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'public'}
            style={{ ...st.chatTab, ...(mode === 'public' ? st.chatTabActive : {}) }}
            onClick={() => setMode('public')}
          >
            Public
            {publicMessages.length > 0 && <span style={st.chatTabCount}>{publicMessages.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'backstage'}
            style={{ ...st.chatTab, ...(mode === 'backstage' ? st.chatTabActiveBackstage : {}) }}
            onClick={() => setMode('backstage')}
          >
            Backstage
            {backstageMessages.length > 0 && <span style={st.chatTabCount}>{backstageMessages.length}</span>}
          </button>
        </div>
      </div>
      <div ref={containerRef} style={st.chatMessages} onScroll={handleScroll}>
        {visibleMessages.length === 0 && (
          <div style={st.chatEmpty}>
            <p style={st.chatEmptyText}>{mode === 'backstage' ? 'No backstage notes yet' : 'No public messages yet'}</p>
            <p style={st.chatEmptyHint}>{mode === 'backstage' ? 'Coordinate with producers and co-hosts.' : 'Messages here are visible to everyone.'}</p>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <div key={msg.id} className="chat-msg-enter" style={st.chatMsg}>
            <div style={st.chatMsgHead}>
              <span style={{ ...st.chatMsgName, color: msg.senderName === senderName ? 'var(--accent-hover)' : 'var(--text-primary)' }}>{msg.senderName}</span>
              {msg.isBackstage && <span style={st.chatBackstageBadge}>Backstage</span>}
              <span style={st.chatMsgTime}>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <p style={st.chatMsgContent}>{msg.content}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={st.chatInputBar}>
        <input
          style={st.chatInput}
          placeholder={mode === 'backstage' ? 'Send a backstage note...' : 'Type a public message...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        />
        <button className="chat-send-btn" style={{ ...st.chatSendBtn, opacity: input.trim() ? 1 : 0.4 }} onClick={handleSend} disabled={!input.trim()} aria-label="Send message">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
        </button>
      </div>
    </div>
  );
}

function OverlayQuickActions({
  hostName,
  brandColor,
  lowerThirds,
  banners,
  timers,
  tickers,
  onAddLowerThird,
  onToggleLowerThird,
  onAddBanner,
  onToggleBanner,
  onAddTimer,
  onToggleTimer,
  onAddTicker,
  onToggleTicker,
}: {
  hostName: string;
  brandColor: string;
  lowerThirds: LowerThirdData[];
  banners: BannerData[];
  timers: TimerData[];
  tickers: TickerData[];
  onAddLowerThird: (lt: Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleLowerThird: (id: string) => void;
  onAddBanner: (banner: Omit<BannerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleBanner: (id: string) => void;
  onAddTimer: (timer: Omit<TimerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleTimer: (id: string) => void;
  onAddTicker: (ticker: Omit<TickerData, 'id' | 'visible'> & { visible?: boolean }) => void;
  onToggleTicker: (id: string) => void;
}) {
  const visibleCount =
    lowerThirds.filter((item) => item.visible).length +
    banners.filter((item) => item.visible).length +
    timers.filter((item) => item.visible).length +
    tickers.filter((item) => item.visible).length;

  const clearLiveOverlays = () => {
    lowerThirds.filter((item) => item.visible).forEach((item) => onToggleLowerThird(item.id));
    banners.filter((item) => item.visible).forEach((item) => onToggleBanner(item.id));
    timers.filter((item) => item.visible).forEach((item) => onToggleTimer(item.id));
    tickers.filter((item) => item.visible).forEach((item) => onToggleTicker(item.id));
  };

  const addLiveShowPack = () => {
    onAddLowerThird({ name: hostName || 'Host', title: 'Live Host', style: 'bold', visible: true });
    onAddBanner({ text: 'We are live', style: 'info', isTicker: false, position: 'top', visible: true });
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

  const packs = [
    { label: 'Live Show', action: addLiveShowPack },
    { label: 'Webinar Q&A', action: addWebinarPack },
    { label: 'Countdown', action: addCountdownPack },
    { label: 'Ticker', action: addTickerPack },
  ];

  return (
    <div style={st.overlayQuick}>
      <div style={st.overlayQuickHead}>
        <div>
          <h4 style={st.sectionTitleInline}>Overlay Packs</h4>
          <p style={st.panelSub}>{visibleCount} live overlay{visibleCount === 1 ? '' : 's'}</p>
        </div>
        <button type="button" style={{ ...st.clearBtn, opacity: visibleCount > 0 ? 1 : 0.45 }} disabled={visibleCount === 0} onClick={clearLiveOverlays}>
          Clear
        </button>
      </div>
      <div style={st.overlayPackGrid}>
        {packs.map((pack) => (
          <button key={pack.label} type="button" style={st.overlayPackBtn} onClick={pack.action}>
            {pack.label}
          </button>
        ))}
      </div>
    </div>
  );
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
  contentPanel: { width: 280, display: 'flex', flexDirection: 'column', background: 'rgba(15, 23, 42, 0.6)', borderLeft: '1px solid rgba(255, 255, 255, 0.06)', height: '100%', overflow: 'hidden', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' },
  scrollContent: { flex: 1, overflowY: 'auto' },
  iconStrip: { width: 56, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8, gap: 2, background: 'rgba(11, 18, 32, 0.8)', borderLeft: '1px solid rgba(255, 255, 255, 0.06)', height: '100%', flexShrink: 0 },
  iconBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, width: 48, height: 48, borderRadius: 10, background: 'transparent', color: 'rgba(255, 255, 255, 0.4)', border: 'none', cursor: 'pointer', padding: 0, transition: 'all 0.15s ease' },
  iconBtnActive: { background: 'rgba(167, 139, 250, 0.12)', color: '#c4b5fd' },
  iconLabel: { fontSize: 9, fontWeight: 500, lineHeight: 1 },
  section: { padding: 16 },
  sectionTitle: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 },
  sectionTitleInline: { fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 },
  divider: { height: 1, background: 'var(--border)', margin: '4px 16px 8px' },
  brandGroup: { marginBottom: 16 },
  brandLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 },
  brandKitGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 },
  brandKitBtn: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', borderRadius: 8, padding: 8, cursor: 'pointer', minWidth: 0 },
  brandKitSwatch: { display: 'block', height: 28, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' },
  brandKitName: { fontSize: 11, fontWeight: 700, textAlign: 'left' },
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
  segmented: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, padding: 3, background: 'rgba(255,255,255,0.04)', borderRadius: 8, border: '1px solid var(--border)' },
  segmentedBtn: { height: 28, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize' },
  segmentedBtnActive: { background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  shapeGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 },
  shapeBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s ease' },
  shapeVisual: { width: 32, background: 'var(--border-strong)' },
  shapeText: { fontSize: 10, fontWeight: 500, color: 'var(--text-secondary)', textTransform: 'capitalize' },
  selectInput: { width: '100%', padding: '8px 12px', fontSize: 13, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none' },
  // Panel layout
  panelFull: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  panelHeader: { padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
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
  personActions: { display: 'flex', gap: 3, flexShrink: 0 },
  smallBtn: { fontSize: 10, fontWeight: 600, padding: '3px 7px', borderRadius: 5, background: 'transparent', border: '1px solid', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 150ms' },
  admitAllBtn: { margin: '8px 16px', width: 'calc(100% - 32px)', fontSize: 13, padding: '8px 14px' },
  // Overlay quick actions
  overlayQuick: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  overlayQuickHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  clearBtn: { border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.1)', color: '#fca5a5', borderRadius: 7, height: 28, padding: '0 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  overlayPackGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 },
  overlayPackBtn: { minHeight: 34, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  // Chat
  chatTabs: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 10, padding: 3, background: 'rgba(255, 255, 255, 0.04)', borderRadius: 8, border: '1px solid var(--border)' },
  chatTab: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, minWidth: 0, height: 28, padding: '0 8px', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  chatTabActive: { background: 'rgba(96, 165, 250, 0.14)', color: '#93c5fd' },
  chatTabActiveBackstage: { background: 'rgba(245, 158, 11, 0.16)', color: '#fbbf24' },
  chatTabCount: { minWidth: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px', borderRadius: 8, background: 'rgba(255, 255, 255, 0.08)', color: 'inherit', fontSize: 9, lineHeight: 1 },
  chatMessages: { flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 },
  chatEmpty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 },
  chatEmptyText: { fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 },
  chatEmptyHint: { fontSize: 12, color: 'var(--text-muted)', opacity: 0.6 },
  chatMsg: { display: 'flex', flexDirection: 'column', gap: 2 },
  chatMsgHead: { display: 'flex', alignItems: 'baseline', gap: 8 },
  chatMsgName: { fontSize: 12, fontWeight: 600 },
  chatBackstageBadge: { fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'rgba(245, 158, 11, 0.14)', color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.04em' },
  chatMsgTime: { fontSize: 10, color: 'var(--text-muted)' },
  chatMsgContent: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4, wordBreak: 'break-word', margin: 0 },
  chatInputBar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderTop: '1px solid var(--border)' },
  chatInput: { flex: 1, padding: '8px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none' },
  chatSendBtn: { width: 34, height: 34, borderRadius: 8, background: 'var(--accent-solid)', color: 'white', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: 'opacity var(--transition-fast)' },
};
