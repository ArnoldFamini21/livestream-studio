import { useMemo, useRef, useState } from 'react';
import type { ActiveMedia, StudioMediaAsset, StudioMediaType } from '@studio/shared';

type MediaTab = 'videos' | 'slides' | 'images' | 'files';

interface MediaLibraryProps {
  assets: StudioMediaAsset[];
  activeMedia: ActiveMedia | null;
  onUpload: (files: FileList | File[]) => void | Promise<void>;
  onAddUrl: (url: string, type: 'video' | 'image') => void;
  onPlay: (asset: StudioMediaAsset) => void;
  onRemove: (assetId: string) => void;
  onStop: () => void;
}

const tabDefs: Array<{ id: MediaTab; label: string; accepts: string; title: string }> = [
  { id: 'videos', label: 'Videos', accepts: 'video/*', title: 'Video Clips' },
  { id: 'slides', label: 'Slides', accepts: '.pdf,.ppt,.pptx,.pps,.ppsx,.key,image/*', title: 'Slides & Decks' },
  { id: 'images', label: 'Images', accepts: 'image/*', title: 'Images' },
  { id: 'files', label: 'Files', accepts: '.pdf,.ppt,.pptx,.pps,.ppsx,.key,.doc,.docx,.xls,.xlsx,.txt,image/*,video/*', title: 'Files' },
];

export const SUPPORTED_MEDIA_ACCEPT = [
  'video/*',
  'image/*',
  '.pdf',
  '.ppt',
  '.pptx',
  '.pps',
  '.ppsx',
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
  onUpload,
  onAddUrl,
  onPlay,
  onRemove,
  onStop,
}: MediaLibraryProps) {
  const [activeTab, setActiveTab] = useState<MediaTab>('videos');
  const [videoUrl, setVideoUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const inputRefs = {
    videos: useRef<HTMLInputElement>(null),
    slides: useRef<HTMLInputElement>(null),
    images: useRef<HTMLInputElement>(null),
    files: useRef<HTMLInputElement>(null),
  };

  const activeDef = tabDefs.find((tab) => tab.id === activeTab) || tabDefs[0];
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
    void Promise.resolve(onUpload(files)).catch((error) => {
      console.error('Failed to upload media:', error);
    });
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
          <button type="button" style={styles.uploadBtn} onClick={() => inputRefs[activeTab].current?.click()}>
            <UploadIcon />
            Upload
          </button>
        </div>

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
              return (
                <div key={asset.id} style={{ ...styles.assetCard, ...(isActive ? styles.assetCardActive : {}) }}>
                  <div style={styles.assetIcon}>
                    <MediaTypeIcon type={asset.type} />
                  </div>
                  <div style={styles.assetInfo}>
                    <span style={styles.assetName}>{asset.name}</span>
                    <span style={styles.assetMeta}>{getAssetLabel(asset)}</span>
                  </div>
                  <div style={styles.assetActions}>
                    <button type="button" style={styles.iconBtn} onClick={() => onPlay(asset)} aria-label={`Show ${asset.name}`}>
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
    lower.endsWith('.key') ||
    file.type === 'application/vnd.ms-powerpoint' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'
  ) return 'presentation';
  return 'file';
}

export function getMediaTabForType(type: StudioMediaType): MediaTab {
  if (type === 'video') return 'videos';
  if (type === 'image') return 'images';
  if (type === 'pdf' || type === 'presentation') return 'slides';
  return 'files';
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
  const size = asset.sizeBytes ? ` / ${formatBytes(asset.sizeBytes)}` : '';
  return `${typeLabel}${size}`;
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
  urlBox: { display: 'flex', gap: 6 },
  urlInput: { minWidth: 0, flex: 1, height: 34, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none', fontSize: 12 },
  urlBtn: { height: 34, borderRadius: 7, border: 'none', background: 'var(--accent-solid)', color: 'white', fontSize: 11, fontWeight: 700, padding: '0 10px', cursor: 'pointer' },
  assetList: { display: 'flex', flexDirection: 'column', gap: 6 },
  emptyState: { minHeight: 128, border: '1px dashed var(--border-strong)', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)' },
  emptyText: { fontSize: 12, color: 'var(--text-muted)' },
  assetCard: { display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', border: '1px solid var(--border)', background: 'var(--bg-tertiary)', borderRadius: 8 },
  assetCardActive: { border: '1px solid var(--success)', background: 'rgba(34,197,94,0.08)' },
  assetIcon: { width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-hover)', background: 'rgba(167,139,250,0.1)', flexShrink: 0 },
  assetInfo: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  assetName: { fontSize: 12, fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  assetMeta: { fontSize: 10, color: 'var(--text-muted)' },
  assetActions: { display: 'flex', alignItems: 'center', gap: 4 },
  iconBtn: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 },
};
