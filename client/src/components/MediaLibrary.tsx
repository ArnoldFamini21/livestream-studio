import { useMemo, useRef, useState } from 'react';
import type { ActiveMedia, StudioMediaAsset, StudioMediaType } from '@studio/shared';
import {
  getNextPresentationSlideIndex,
  getPresentationDeckStatus,
  getPresentationItemDisplayTitle,
  getPresentationSlidePickerItems,
} from '../utils/presentationDeckControls.ts';
import { hasRenderedPresentationSlides } from '../utils/presentationPreview.ts';
import type { MediaServerHealth } from '../utils/mediaServerHealth.ts';

type MediaTab = 'videos' | 'slides' | 'images' | 'files';

interface MediaLibraryProps {
  assets: StudioMediaAsset[];
  activeMedia: ActiveMedia | null;
  activeMediaSlideIndex: number;
  onActiveMediaSlideIndexChange: (index: number) => void;
  onUpload: (files: FileList | File[]) => void | Promise<void>;
  onAddUrl: (url: string, type: 'video' | 'image') => void;
  onPlay: (asset: StudioMediaAsset) => void;
  onRemove: (assetId: string) => void;
  onStop: () => void;
  mediaServerHealth?: MediaServerHealth | null;
  onRefreshMediaServerHealth?: () => void | Promise<MediaServerHealth>;
}

const tabDefs: Array<{ id: MediaTab; label: string; accepts: string; title: string }> = [
  { id: 'videos', label: 'Videos', accepts: 'video/*', title: 'Video Clips' },
  { id: 'slides', label: 'Slides', accepts: '.pdf,.ppt,.pptx,.pps,.ppsx,.potx,.key,image/*', title: 'Slides & Decks' },
  { id: 'images', label: 'Images', accepts: 'image/*', title: 'Images' },
  { id: 'files', label: 'Files', accepts: '.pdf,.ppt,.pptx,.pps,.ppsx,.potx,.key,.doc,.docx,.xls,.xlsx,.txt,image/*,video/*', title: 'Files' },
];

export const SUPPORTED_MEDIA_ACCEPT = [
  'video/*',
  'image/*',
  '.pdf',
  '.ppt',
  '.pptx',
  '.pps',
  '.ppsx',
  '.potx',
  '.key',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.txt',
].join(',');

export function MediaLibrary({
  assets,
  activeMedia,
  activeMediaSlideIndex,
  onActiveMediaSlideIndexChange,
  onUpload,
  onAddUrl,
  onPlay,
  onRemove,
  onStop,
  mediaServerHealth,
  onRefreshMediaServerHealth,
}: MediaLibraryProps) {
  const [activeTab, setActiveTab] = useState<MediaTab>('videos');
  const [videoUrl, setVideoUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const inputRefs = {
    videos: useRef<HTMLInputElement>(null),
    slides: useRef<HTMLInputElement>(null),
    images: useRef<HTMLInputElement>(null),
    files: useRef<HTMLInputElement>(null),
  };

  const activeDef = tabDefs.find((tab) => tab.id === activeTab) || tabDefs[0];
  const deckStatus = getPresentationDeckStatus(activeMedia, activeMediaSlideIndex);
  const deckUploadBlockMessage = getDeckUploadBlockMessage(mediaServerHealth);
  const showDeckUploadNotice = (activeTab === 'slides' || activeTab === 'files') && Boolean(deckUploadBlockMessage);
  const filteredAssets = useMemo(() => {
    switch (activeTab) {
      case 'videos':
        return assets.filter((asset) => asset.type === 'video');
      case 'slides':
        return assets.filter((asset) => asset.type === 'pdf' || asset.type === 'presentation');
      case 'images':
        return assets.filter((asset) => asset.type === 'image');
      case 'files':
        return assets;
    }
  }, [activeTab, assets]);

  const handleUrlSubmit = (type: 'video' | 'image') => {
    const value = type === 'video' ? videoUrl.trim() : imageUrl.trim();
    if (!value) return;
    onAddUrl(value, type);
    if (type === 'video') setVideoUrl('');
    else setImageUrl('');
  };

  const handleUpload = (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setActiveTab(getMediaTabForType(detectMediaType(files[0])));
    setUploadError('');

    if (deckUploadBlockMessage && hasDeckFiles(files)) {
      setActiveTab('slides');
      setUploadError(deckUploadBlockMessage);
      return;
    }

    setIsUploading(true);
    void Promise.resolve(onUpload(files))
      .catch((error) => {
        console.error('Failed to upload media:', error);
        setUploadError('Upload failed. Try that file again.');
      })
      .finally(() => setIsUploading(false));
  };

  const counts = {
    videos: assets.filter((asset) => asset.type === 'video').length,
    slides: assets.filter((asset) => asset.type === 'pdf' || asset.type === 'presentation').length,
    images: assets.filter((asset) => asset.type === 'image').length,
    files: assets.length,
  };

  return (
    <div style={styles.panelFull}>
      <div style={styles.panelHeader}>
        <h3 style={styles.panelTitle}>Media</h3>
        {activeMedia && (
          <div style={styles.liveMedia}>
            <span style={styles.liveDot} />
            <span style={styles.liveMediaName}>{activeMedia.name}</span>
            <button type="button" style={styles.stopBtn} onClick={onStop}>Stop</button>
          </div>
        )}
      </div>

      {deckStatus.hasDeck && (
        <ActiveDeckControls
          mediaName={activeMedia?.name || 'Presentation'}
          status={deckStatus}
          onSlideIndexChange={onActiveMediaSlideIndexChange}
        />
      )}

      <div style={styles.tabBar} role="tablist" aria-label="Media library">
        {tabDefs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            style={{ ...styles.tabBtn, ...(activeTab === tab.id ? styles.tabBtnActive : {}) }}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {counts[tab.id] > 0 && <span style={styles.tabCount}>{counts[tab.id]}</span>}
          </button>
        ))}
      </div>

      <div style={styles.body}>
        {showDeckUploadNotice && (
          <div
            style={{
              ...styles.deckReadinessNotice,
              ...(mediaServerHealth?.status === 'checking' ? styles.deckReadinessNoticeChecking : styles.deckReadinessNoticeBlocked),
            }}
          >
            <div style={styles.deckReadinessText}>
              <span style={styles.deckReadinessTitle}>
                {mediaServerHealth?.status === 'checking' ? 'Checking exact deck renderer' : 'Exact deck renderer unavailable'}
              </span>
              <span style={styles.deckReadinessMessage}>{deckUploadBlockMessage}</span>
            </div>
            {onRefreshMediaServerHealth && (
              <button
                type="button"
                style={{
                  ...styles.deckReadinessButton,
                  ...(mediaServerHealth?.status === 'checking' ? styles.deckReadinessButtonDisabled : {}),
                }}
                disabled={mediaServerHealth?.status === 'checking'}
                onClick={() => {
                  setUploadError('');
                  void onRefreshMediaServerHealth();
                }}
              >
                Check
              </button>
            )}
          </div>
        )}
        <div style={styles.uploadCard}>
          <input
            ref={inputRefs[activeTab]}
            type="file"
            accept={SUPPORTED_MEDIA_ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              handleUpload(e.target.files);
              e.target.value = '';
            }}
          />
          <div>
            <h4 style={styles.sectionTitle}>{activeDef.title}</h4>
            <p style={styles.uploadMeta}>{getUploadMeta(activeTab)}</p>
            <p style={styles.uploadHint}>PDF and PowerPoint files are accepted from any tab.</p>
          </div>
          <button
            type="button"
            style={{ ...styles.uploadBtn, ...(isUploading ? styles.uploadBtnDisabled : {}) }}
            disabled={isUploading}
            onClick={() => inputRefs[activeTab].current?.click()}
          >
            <UploadIcon />
            {isUploading ? 'Rendering...' : 'Upload'}
          </button>
        </div>
        {uploadError && <div style={styles.uploadError}>{uploadError}</div>}

        {activeTab === 'videos' && (
          <UrlBox
            value={videoUrl}
            placeholder="Paste video URL"
            actionLabel="Add Video"
            onChange={setVideoUrl}
            onSubmit={() => handleUrlSubmit('video')}
          />
        )}

        {activeTab === 'images' && (
          <UrlBox
            value={imageUrl}
            placeholder="Paste image URL"
            actionLabel="Add Image"
            onChange={setImageUrl}
            onSubmit={() => handleUrlSubmit('image')}
          />
        )}

        <div style={styles.assetList}>
          {filteredAssets.length === 0 ? (
            <div style={styles.emptyState}>
              <MediaTypeIcon type={activeTab === 'slides' ? 'presentation' : activeTab === 'videos' ? 'video' : activeTab === 'images' ? 'image' : 'file'} />
              <span style={styles.emptyText}>No media yet</span>
            </div>
          ) : (
            filteredAssets.map((asset) => {
              const isActive = activeMedia?.assetId === asset.id || activeMedia?.url === asset.url;
              const canPlay = canPlayMediaAsset(asset);
              const isProcessing = asset.processingStatus === 'processing';
              const hasError = asset.processingStatus === 'error';
              const statusLabel = getMediaAssetStatusLabel(asset);
              return (
                <div
                  key={asset.id}
                  style={{
                    ...styles.assetCard,
                    ...(isActive ? styles.assetCardActive : {}),
                    ...(isProcessing ? styles.assetCardProcessing : {}),
                    ...(hasError ? styles.assetCardError : {}),
                  }}
                >
                  <div
                    style={{
                      ...styles.assetIcon,
                      ...(isProcessing ? styles.assetIconProcessing : {}),
                      ...(hasError ? styles.assetIconError : {}),
                    }}
                  >
                    <MediaTypeIcon type={asset.type} />
                  </div>
                  <div style={styles.assetInfo}>
                    <span style={styles.assetName}>{asset.name}</span>
                    <span
                      style={{
                        ...styles.assetMeta,
                        ...(isProcessing ? styles.assetMetaProcessing : {}),
                        ...(hasError ? styles.assetMetaError : {}),
                      }}
                    >
                      {statusLabel}
                    </span>
                  </div>
                  <div style={styles.assetActions}>
                    <button
                      type="button"
                      style={{ ...styles.iconBtn, ...(!canPlay ? styles.iconBtnDisabled : {}) }}
                      onClick={() => { if (canPlay) onPlay(asset); }}
                      disabled={!canPlay}
                      aria-label={`Show ${asset.name}`}
                      title={canPlay ? `Show ${asset.name}` : statusLabel}
                    >
                      <PlayIcon />
                    </button>
                    <button type="button" style={styles.iconBtn} onClick={() => onRemove(asset.id)} aria-label={`Remove ${asset.name}`}>
                      <CloseIcon />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ActiveDeckControls({
  mediaName,
  status,
  onSlideIndexChange,
}: {
  mediaName: string;
  status: ReturnType<typeof getPresentationDeckStatus>;
  onSlideIndexChange: (index: number) => void;
}) {
  const goPrevious = () => {
    onSlideIndexChange(getNextPresentationSlideIndex(status.currentIndex, status.total, 'previous'));
  };
  const goNext = () => {
    onSlideIndexChange(getNextPresentationSlideIndex(status.currentIndex, status.total, 'next'));
  };
  const slideItems = getPresentationSlidePickerItems(status.slides, status.currentIndex, status.unitLabel);
  const currentNotes = status.currentSlide?.notes || [];

  return (
    <div style={styles.deckControl}>
      <div style={styles.deckControlHeader}>
        <span style={styles.deckEyebrow}>Live Deck</span>
        <span style={styles.deckCount}>{status.unitLabel} {status.currentIndex + 1} / {status.total}</span>
      </div>
      <div style={styles.deckName}>{mediaName}</div>
      <div style={styles.deckCurrentTitle}>
        {getPresentationItemDisplayTitle(status.currentSlide, status.currentIndex, status.unitLabel)}
      </div>
      <div style={styles.deckNextTitle}>
        {status.nextSlide
          ? `Next: ${getPresentationItemDisplayTitle(status.nextSlide, status.currentIndex + 1, status.unitLabel)}`
          : 'End of deck'}
      </div>
      {currentNotes.length > 0 && (
        <div style={styles.deckNotes}>
          <div style={styles.deckNotesHeader}>Speaker Notes</div>
          <ul style={styles.deckNotesList}>
            {currentNotes.map((note, index) => (
              <li key={`${status.currentSlide?.id || status.currentIndex}-note-${index}`} style={styles.deckNoteItem}>
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label style={styles.deckJumpLabel}>
        <span style={styles.deckJumpText}>Jump to</span>
        <select
          style={styles.deckJumpSelect}
          value={status.currentIndex}
          onChange={(event) => onSlideIndexChange(Number(event.target.value))}
          aria-label="Jump to slide"
        >
          {slideItems.map((item) => (
            <option key={item.index} value={item.index}>
              {item.label}: {item.title}
            </option>
          ))}
        </select>
      </label>
      <div style={styles.deckFilmstrip} role="list" aria-label="Slides in live deck">
        {slideItems.map((item) => (
          <button
            key={item.index}
            type="button"
            role="listitem"
            style={{
              ...styles.deckThumbButton,
              ...(item.isCurrent ? styles.deckThumbButtonActive : {}),
            }}
            onClick={() => onSlideIndexChange(item.index)}
            aria-pressed={item.isCurrent}
            aria-label={`Show ${item.label}: ${item.title}`}
            title={`${item.label}: ${item.title}`}
          >
            <span style={styles.deckThumbFrame}>
              {item.imageUrl ? (
                <img src={item.imageUrl} alt="" style={styles.deckThumbImage} />
              ) : (
                <span style={styles.deckThumbFallback}>{item.index + 1}</span>
              )}
            </span>
            <span style={styles.deckThumbNumber}>{item.index + 1}</span>
          </button>
        ))}
      </div>
      <div style={styles.deckActions}>
        <button
          type="button"
          style={{ ...styles.deckButton, ...(status.canGoPrevious ? {} : styles.deckButtonDisabled) }}
          disabled={!status.canGoPrevious}
          onClick={goPrevious}
          aria-label="Show previous slide"
        >
          Previous
        </button>
        <button
          type="button"
          style={{ ...styles.deckButton, ...styles.deckPrimaryButton, ...(status.canGoNext ? {} : styles.deckButtonDisabled) }}
          disabled={!status.canGoNext}
          onClick={goNext}
          aria-label="Show next slide"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function UrlBox({
  value,
  placeholder,
  actionLabel,
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  actionLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div style={styles.urlBox}>
      <input
        style={styles.urlInput}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
      />
      <button type="button" style={{ ...styles.urlBtn, opacity: value.trim() ? 1 : 0.45 }} disabled={!value.trim()} onClick={onSubmit}>
        {actionLabel}
      </button>
    </div>
  );
}

export function detectMediaType(file: File): StudioMediaType {
  const lower = file.name.toLowerCase();
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (
    lower.endsWith('.ppt') ||
    lower.endsWith('.pptx') ||
    lower.endsWith('.pps') ||
    lower.endsWith('.ppsx') ||
    lower.endsWith('.potx') ||
    lower.endsWith('.key') ||
    file.type === 'application/vnd.ms-powerpoint' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.template'
  ) return 'presentation';
  return 'file';
}

export function getMediaTabForType(type: StudioMediaType): MediaTab {
  if (type === 'video') return 'videos';
  if (type === 'image') return 'images';
  if (type === 'pdf' || type === 'presentation') return 'slides';
  return 'files';
}

export function canPlayMediaAsset(asset: StudioMediaAsset): boolean {
  if (asset.processingStatus === 'processing') return false;
  if (asset.processingStatus === 'error') return false;
  if ((asset.type === 'presentation' || asset.type === 'pdf') && asset.source === 'upload') {
    return hasRenderedPresentationSlides(asset.preview);
  }
  return true;
}

function isDeckMediaType(type: StudioMediaType): boolean {
  return type === 'presentation' || type === 'pdf';
}

export function hasDeckFiles(files: File[]): boolean {
  return files.some((file) => isDeckMediaType(detectMediaType(file)));
}

export function getDeckUploadBlockMessage(
  health?: Pick<MediaServerHealth, 'status' | 'message' | 'presentationRenderer'> | null
): string {
  if (!health) return '';
  if (health.status === 'ready') {
    if (!health.presentationRenderer) {
      return 'Exact deck renderer is unavailable until the media-server reports presentation renderer readiness.';
    }
    return health.presentationRenderer.ready
      ? ''
      : health.presentationRenderer.message || 'Exact deck renderer is unavailable. Check the media-server presentation renderer before uploading PowerPoint or PDF files.';
  }
  if (health.status === 'checking') {
    return 'Checking the media-server before accepting PowerPoint or PDF uploads.';
  }
  return health.message || 'Media server is unavailable. Check it before uploading PowerPoint or PDF files.';
}

export function getMediaAssetStatusLabel(asset: StudioMediaAsset): string {
  if (asset.processingStatus === 'processing') {
    if (asset.processingMessage) return asset.processingMessage;
    if (asset.type === 'presentation') return 'Rendering PowerPoint design for broadcast...';
    if (asset.type === 'pdf') return 'Rendering PDF pages for broadcast...';
    return 'Preparing media for broadcast...';
  }
  if (asset.processingStatus === 'error') {
    return asset.processingMessage || 'This asset could not be prepared for broadcast.';
  }
  return getAssetLabel(asset);
}

function getUploadMeta(tab: MediaTab): string {
  switch (tab) {
    case 'videos':
      return 'MP4, MOV, WebM';
    case 'slides':
      return 'PDF, PowerPoint, Keynote, images';
    case 'images':
      return 'PNG, JPG, WebP, GIF';
    case 'files':
      return 'Documents, videos, images';
  }
}

function getAssetLabel(asset: StudioMediaAsset): string {
  const typeLabel = {
    video: 'Video',
    image: 'Image',
    pdf: 'PDF',
    presentation: 'Deck',
    file: 'File',
  }[asset.type];
  let slideCount = '';
  if (asset.preview?.kind === 'presentation-slides') {
    const unit = asset.preview.sourceFormat === 'pdf' ? 'page' : 'slide';
    const total = asset.preview.slides.length;
    slideCount = ` / ${total} ${unit}${total === 1 ? '' : 's'}`;
  }
  const size = asset.sizeBytes ? ` / ${formatBytes(asset.sizeBytes)}` : '';
  return `${typeLabel}${slideCount}${size}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function MediaTypeIcon({ type }: { type: StudioMediaType }) {
  if (type === 'video') return <PlayIcon />;
  if (type === 'image') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    );
  }
  if (type === 'pdf' || type === 'presentation') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h20v14H2z" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panelFull: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  panelHeader: { padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  panelTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
  liveMedia: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, minWidth: 0 },
  liveDot: { width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 },
  liveMediaName: { fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  stopBtn: { border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.12)', color: '#fca5a5', borderRadius: 6, fontSize: 10, fontWeight: 700, padding: '3px 7px', cursor: 'pointer' },
  deckControl: { margin: '10px 12px 8px', padding: 12, borderRadius: 8, border: '1px solid rgba(103,232,249,0.24)', background: 'rgba(103,232,249,0.07)' },
  deckControlHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 },
  deckEyebrow: { fontSize: 10, fontWeight: 800, color: '#67e8f9', textTransform: 'uppercase', letterSpacing: 0 },
  deckCount: { fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' },
  deckName: { fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 5 },
  deckCurrentTitle: { fontSize: 13, fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  deckNextTitle: { marginTop: 4, minHeight: 15, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  deckNotes: { marginTop: 9, padding: '8px 9px', borderRadius: 7, border: '1px solid rgba(103,232,249,0.18)', background: 'rgba(2,6,23,0.28)' },
  deckNotesHeader: { fontSize: 9, fontWeight: 900, color: '#67e8f9', textTransform: 'uppercase', letterSpacing: 0, marginBottom: 5 },
  deckNotesList: { margin: 0, paddingLeft: 15, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 96, overflowY: 'auto' },
  deckNoteItem: { fontSize: 10, lineHeight: 1.35, color: 'var(--text-secondary)' },
  deckJumpLabel: { display: 'grid', gridTemplateColumns: '48px minmax(0, 1fr)', alignItems: 'center', gap: 7, marginTop: 9 },
  deckJumpText: { fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' },
  deckJumpSelect: { minWidth: 0, width: '100%', height: 30, padding: '0 8px', borderRadius: 7, border: '1px solid rgba(103,232,249,0.22)', background: 'rgba(15,23,42,0.72)', color: 'var(--text-primary)', fontSize: 11, fontWeight: 700, outline: 'none' },
  deckFilmstrip: { display: 'flex', gap: 7, overflowX: 'auto', padding: '9px 1px 2px', marginTop: 2 },
  deckThumbButton: { position: 'relative', flex: '0 0 68px', width: 68, minWidth: 68, padding: 3, borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(15,23,42,0.5)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'stretch' },
  deckThumbButtonActive: { border: '1px solid var(--accent)', background: 'var(--accent-subtle)', boxShadow: '0 0 0 1px rgba(167,139,250,0.35)' },
  deckThumbFrame: { width: '100%', aspectRatio: '16 / 9', borderRadius: 5, overflow: 'hidden', background: 'rgba(2,6,23,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.08)' },
  deckThumbImage: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  deckThumbFallback: { fontSize: 14, fontWeight: 900, color: 'var(--text-muted)' },
  deckThumbNumber: { fontSize: 9, lineHeight: 1.2, fontWeight: 900, color: 'inherit', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
  deckActions: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 },
  deckButton: { minWidth: 0, height: 30, borderRadius: 7, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 800, cursor: 'pointer' },
  deckPrimaryButton: { border: '1px solid var(--accent)', background: 'var(--accent-solid)', color: '#fff' },
  deckButtonDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  tabBar: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: 8, borderBottom: '1px solid var(--border)' },
  tabBtn: { minWidth: 0, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', borderRadius: 7, fontSize: 10, fontWeight: 700, cursor: 'pointer' },
  tabBtnActive: { border: '1px solid var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  tabCount: { minWidth: 14, height: 14, borderRadius: 7, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.08)', fontSize: 9 },
  body: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  uploadCard: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 12, background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border)', borderRadius: 8 },
  sectionTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', margin: 0 },
  uploadMeta: { margin: '3px 0 0', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.25 },
  uploadHint: { margin: '3px 0 0', fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.25 },
  uploadBtn: { height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 7, border: '1px solid var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)', fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: '0 10px', flexShrink: 0 },
  uploadBtnDisabled: { opacity: 0.58, cursor: 'wait' },
  uploadError: { marginTop: -4, padding: '8px 10px', borderRadius: 7, border: '1px solid rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.1)', color: '#fecaca', fontSize: 10, fontWeight: 700, lineHeight: 1.3 },
  deckReadinessNotice: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8 },
  deckReadinessNoticeChecking: { border: '1px solid rgba(103,232,249,0.3)', background: 'rgba(103,232,249,0.08)' },
  deckReadinessNoticeBlocked: { border: '1px solid rgba(248,113,113,0.34)', background: 'rgba(248,113,113,0.09)' },
  deckReadinessText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  deckReadinessTitle: { fontSize: 10, fontWeight: 900, color: 'var(--text-primary)' },
  deckReadinessMessage: { fontSize: 10, lineHeight: 1.3, color: 'var(--text-muted)' },
  deckReadinessButton: { height: 28, borderRadius: 7, border: '1px solid var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)', fontSize: 10, fontWeight: 800, cursor: 'pointer', padding: '0 9px', flexShrink: 0 },
  deckReadinessButtonDisabled: { opacity: 0.5, cursor: 'wait' },
  urlBox: { display: 'flex', gap: 6 },
  urlInput: { minWidth: 0, flex: 1, height: 34, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', fontSize: 12 },
  urlBtn: { height: 34, borderRadius: 7, border: 'none', background: 'var(--accent-solid)', color: 'white', fontSize: 11, fontWeight: 700, padding: '0 10px', cursor: 'pointer' },
  assetList: { display: 'flex', flexDirection: 'column', gap: 6 },
  emptyState: { minHeight: 128, border: '1px dashed var(--border-strong)', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)' },
  emptyText: { fontSize: 12, color: 'var(--text-muted)' },
  assetCard: { display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', border: '1px solid var(--border)', background: 'var(--bg-tertiary)', borderRadius: 8 },
  assetCardActive: { border: '1px solid var(--success)', background: 'rgba(34,197,94,0.08)' },
  assetCardProcessing: { border: '1px solid rgba(103,232,249,0.34)', background: 'rgba(103,232,249,0.07)' },
  assetCardError: { border: '1px solid rgba(248,113,113,0.45)', background: 'rgba(248,113,113,0.08)' },
  assetIcon: { width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-hover)', background: 'rgba(167,139,250,0.1)', flexShrink: 0 },
  assetIconProcessing: { color: '#67e8f9', background: 'rgba(103,232,249,0.12)' },
  assetIconError: { color: '#fca5a5', background: 'rgba(248,113,113,0.12)' },
  assetInfo: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  assetName: { fontSize: 12, fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  assetMeta: { fontSize: 10, color: 'var(--text-muted)' },
  assetMetaProcessing: { color: '#67e8f9', lineHeight: 1.25, whiteSpace: 'normal' },
  assetMetaError: { color: '#fca5a5', lineHeight: 1.25, whiteSpace: 'normal' },
  assetActions: { display: 'flex', alignItems: 'center', gap: 4 },
  iconBtn: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 },
  iconBtnDisabled: { opacity: 0.35, cursor: 'not-allowed' },
};
