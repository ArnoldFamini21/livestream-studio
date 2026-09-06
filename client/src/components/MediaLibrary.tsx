import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveMedia, StudioMediaAsset, StudioMediaType } from '@studio/shared';
import {
  getNextPresentationSlideIndex,
  getPresentationDeckStatus,
  getPresentationPresenterCards,
  getPresentationSlidePickerItems,
} from '../utils/presentationDeckControls.ts';
import { canBrowserRenderPowerPointFile, hasRenderedPresentationSlides } from '../utils/presentationPreview.ts';
import type { MediaServerHealth } from '../utils/mediaServerHealth.ts';
import { StudioIcon } from './StudioIcon.tsx';

type MediaTab = 'videos' | 'slides' | 'images' | 'files';
interface MediaLibraryProps {
  assets: StudioMediaAsset[];
  activeMedia: ActiveMedia | null;
  activeMediaSlideIndex: number;
  onActiveMediaSlideIndexChange: (index: number) => void;
  onUpload: (files: FileList | File[]) => void | Promise<void>;
  onAddUrl: (url: string, type: 'video' | 'image') => void | Promise<void>;
  onPlay: (asset: StudioMediaAsset) => void;
  onRemove: (assetId: string) => void;
  onStop: () => void;
  mediaServerHealth?: MediaServerHealth | null;
  onRefreshMediaServerHealth?: () => void | Promise<MediaServerHealth>;
}

export const SUPPORTED_MEDIA_ACCEPT = 'video/*,image/*,.pdf,.ppt,.pptx,.pps,.ppsx,.potx,.key,.doc,.docx,.xls,.xlsx,.txt';

export function MediaLibrary({ assets, activeMedia, activeMediaSlideIndex, onActiveMediaSlideIndexChange,
  onUpload, onAddUrl, onPlay, onRemove, onStop }: MediaLibraryProps) {
  const [view, setView] = useState<'library' | 'add' | 'preview'>('library');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [urlType, setUrlType] = useState<'video' | 'image'>('video');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  const selected = assets.find(asset => asset.id === previewId);
  const filtered = useMemo(() => assets.filter(asset => asset.name.toLowerCase().includes(query.toLowerCase())), [assets, query]);
  const deckStatus = getPresentationDeckStatus(activeMedia, activeMediaSlideIndex);

  useEffect(() => {
    if (previousView.current !== view) {
      panelRef.current?.querySelector<HTMLButtonElement>('[data-view-focus]')?.focus();
      previousView.current = view;
    }
  }, [view]);

  const handleUpload = async (files: File[]) => {
    if (!files.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setQuery('');
    setView('library');
    try { await onUpload(files); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add these files. Please try again.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const submitUrl = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onAddUrl(url.trim(), urlType);
      setUrl('');
      setQuery('');
      setView('library');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this link. Please try again.'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  return <div ref={panelRef} className={`media-workspace${dragging ? ' is-dragging' : ''}`}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); setDragging(false); void handleUpload(Array.from(event.dataTransfer.files)); }}>
    <input ref={inputRef} type="file" accept={SUPPORTED_MEDIA_ACCEPT} multiple hidden aria-label="Upload media files"
      onChange={event => { void handleUpload(Array.from(event.target.files || [])); event.target.value = ''; }} />
    {dragging && <div className="media-drop-overlay">Drop files to add</div>}

    {view === 'library' ? <>
      <button type="button" data-view-focus className="media-add" disabled={busy} onClick={() => { setError(''); setView('add'); }}>
        <StudioIcon name="plus" /> Add media
      </button>
      {busy && <p className="media-progress" role="status"><span className="media-spinner" /> Preparing media…</p>}
      {error && <p className="media-error" role="alert">{error}</p>}
      {activeMedia && <section className="media-onstage" aria-label="Media on stage">
        <div className="media-onstage-heading"><span><i /> On stage</span><button type="button" onClick={onStop}>Stop sharing</button></div>
        <p title={activeMedia.name}>{activeMedia.name}</p>
        {deckStatus.hasDeck && <ActiveDeckControls status={deckStatus} onSlideIndexChange={onActiveMediaSlideIndexChange} />}
      </section>}
      {(assets.length > 5 || query) && <label className="media-search"><StudioIcon name="search" />
        <input aria-label="Search media" placeholder="Search media" value={query} onChange={event => setQuery(event.target.value)} />
      </label>}
      {assets.length === 0 ? <div className="media-empty">
        <div className="media-empty-icon"><StudioIcon name="recordings" /></div>
        <p>Your media, ready to share.</p>
        <span>Add videos, images, or slides.<br />You can also drop files here.</span>
      </div> : <ul className="media-library-list" aria-label="Media library">
        {filtered.map(asset => {
          const isActive = activeMedia?.assetId === asset.id || activeMedia?.url === asset.url;
          const canPlay = canPlayMediaAsset(asset);
          const showPreview = () => { setPreviewId(asset.id); setView('preview'); };
          return <li key={asset.id} className="media-library-row" data-active={isActive}>
            <button type="button" className="media-asset-preview" onClick={showPreview} aria-label={`Preview ${asset.name}`}>
              <MediaThumbnail asset={asset} />
            </button>
            <div className="media-asset-copy"><button type="button" onClick={showPreview} title={asset.name}>{asset.name}</button>
              <span className={asset.processingStatus === 'error' ? 'media-error-copy' : ''}>
                {asset.processingStatus === 'processing' && <span className="media-spinner" />}{getMediaAssetStatusLabel(asset)}
              </span>
            </div>
            {!isActive && <button type="button" className="media-show" onClick={() => onPlay(asset)} disabled={!canPlay} aria-label={`Show ${asset.name}`} title={canPlay ? 'Show on stage' : getMediaAssetStatusLabel(asset)}>Show</button>}
            <details className="media-item-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
              <summary aria-label={`Options for ${asset.name}`}><StudioIcon name="more" /></summary>
              <div><button type="button" onClick={showPreview}>Preview</button>
                <button type="button" className="media-remove" onClick={() => onRemove(asset.id)}>Remove</button></div>
            </details>
          </li>;
        })}
        {filtered.length === 0 && <li className="media-no-results">No media matches “{query}”.</li>}
      </ul>}
    </> : <>
      <div className="media-view-heading"><button type="button" data-view-focus aria-label="Back to media library" onClick={() => { setError(''); setView('library'); }}>←</button>
        <h3>{view === 'add' ? 'Add media' : 'Preview'}</h3></div>
      {view === 'add' ? <div className="media-add-view">
        <button type="button" className="media-upload-target" disabled={busy} onClick={() => inputRef.current?.click()}>
          <UploadIcon /><strong>Upload files</strong><span>or drag and drop here</span>
        </button>
        <p className="media-format-hint">Videos, images, PDF & PowerPoint</p>
        <details className="media-disclosure"><summary>Add from a link</summary>
          <form onSubmit={submitUrl} className="media-link-form">
            <label>Media type<select value={urlType} onChange={event => setUrlType(event.target.value as 'video' | 'image')}><option value="video">Video</option><option value="image">Image</option></select></label>
            <label>File link<input type="url" required value={url} placeholder="https://…" onChange={event => setUrl(event.target.value)} /></label>
            <p>Use a direct file link. For a YouTube or webpage link, share your browser tab instead.</p>
            <button type="submit" className="media-primary" disabled={!url.trim() || busy}>{busy ? 'Checking link…' : 'Add to library'}</button>
          </form>
        </details>
        {error && <p className="media-error" role="alert">{error}</p>}
      </div> : selected ? <MediaPreview key={selected.id} asset={selected} isActive={activeMedia?.assetId === selected.id || activeMedia?.url === selected.url} onShow={index => { onPlay(selected); onActiveMediaSlideIndexChange(index); setView('library'); }} onStop={onStop} /> : <p className="media-no-results">This media has been removed.</p>}
    </>}
  </div>;
}

function MediaThumbnail({ asset }: { asset: StudioMediaAsset }) {
  const src = asset.type === 'image' ? asset.url : asset.preview?.slides[0]?.imageUrl;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <MediaTypeIcon type={asset.type} />;
}

function MediaPreview({ asset, isActive, onShow, onStop }: { asset: StudioMediaAsset; isActive: boolean; onShow: (index: number) => void; onStop: () => void }) {
  const [page, setPage] = useState(0);
  const [failed, setFailed] = useState(false);
  const slides = asset.preview?.slides || [];
  const image = slides[page]?.imageUrl || (asset.type === 'image' ? asset.url : null);
  return <div className="media-preview-view" onKeyDown={event => {
    if (!slides.length || event.altKey || event.metaKey || event.ctrlKey) return;
    const direction = ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : ['ArrowRight', 'PageDown'].includes(event.key) ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    setPage(current => Math.max(0, Math.min(slides.length - 1, current + direction)));
  }}>
    <h4 title={asset.name}>{asset.name}</h4>
    <div className="media-preview-frame">
      {failed ? <p>Preview unavailable. Try uploading the file again.</p> : asset.type === 'video' ? <video src={asset.url} controls playsInline preload="metadata" onError={() => setFailed(true)} /> : image ? <img src={image} alt={slides[page]?.title || asset.name} onError={() => setFailed(true)} /> : <MediaTypeIcon type={asset.type} />}
    </div>
    {slides.length > 1 && <div className="media-slide-navigation">
      <button type="button" aria-label="Preview previous slide" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
      <span>{page + 1} / {slides.length}</span>
      <button type="button" aria-label="Preview next slide" disabled={page === slides.length - 1} onClick={() => setPage(page + 1)}>→</button>
    </div>}
    <p className="media-preview-note">Only you see this preview.</p>
    <button type="button" className="media-primary" disabled={!isActive && (!canPlayMediaAsset(asset) || failed)} onClick={isActive ? onStop : () => onShow(page)}>{isActive ? 'Stop sharing' : 'Show on stage'}</button>
    <p className={asset.processingStatus === 'error' ? 'media-error' : 'media-format-hint'}>{getMediaAssetStatusLabel(asset)}</p>
  </div>;
}

function ActiveDeckControls({ status, onSlideIndexChange }: {
  status: ReturnType<typeof getPresentationDeckStatus>; onSlideIndexChange: (index: number) => void;
}) {
  const items = getPresentationSlidePickerItems(status.slides, status.currentIndex, status.unitLabel);
  const next = getPresentationPresenterCards(status).find(card => card.kind === 'next');
  return <div className="media-deck-controls">
    <div className="media-slide-navigation">
      <button type="button" aria-label="Show previous slide" disabled={!status.canGoPrevious} onClick={() => onSlideIndexChange(getNextPresentationSlideIndex(status.currentIndex, status.total, 'previous'))}>←</button>
      <select aria-label="Jump to slide" value={status.currentIndex} onChange={event => onSlideIndexChange(Number(event.target.value))}>
        {items.map(item => <option key={item.index} value={item.index}>{item.label} of {status.total}</option>)}
      </select>
      <button type="button" aria-label="Show next slide" disabled={!status.canGoNext} onClick={() => onSlideIndexChange(getNextPresentationSlideIndex(status.currentIndex, status.total, 'next'))}>→</button>
    </div>
    <details className="media-disclosure"><summary>Presenter view</summary>
      {next && <div className="media-next-slide"><span>Up next</span>{next.imageUrl && <img src={next.imageUrl} alt="" loading="lazy" />}<p>{next.title}</p></div>}
      {!!status.currentSlide?.notes?.length && <div className="media-speaker-notes"><span>Speaker notes · only you</span>{status.currentSlide.notes.map((note, index) => <p key={index}>{note}</p>)}</div>}
      <div className="media-filmstrip" aria-label="Slides in presentation">{items.map(item => <button type="button" key={item.index} aria-pressed={item.isCurrent} aria-label={`Show ${item.label}: ${item.title}`} onClick={() => onSlideIndexChange(item.index)}>
        {item.imageUrl && <img src={item.imageUrl} alt="" loading="lazy" />}<span>{item.index + 1}</span>
      </button>)}</div>
    </details>
  </div>;
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

export function hasDeckFilesRequiringMediaServer(files: File[]): boolean {
  return files.some((file) => detectMediaType(file) === 'presentation' && !canBrowserRenderPowerPointFile(file));
}

export function getDeckUploadBlockMessage(
  health?: Pick<MediaServerHealth, 'status' | 'message' | 'presentationRenderer'> | null
): string {
  const exactRendererMessage = 'Modern PPTX files will use visual browser rendering when the exact Render media-server is unavailable. Legacy PPT files still require the media-server; export Keynote files as PDF or PPTX. PDF files can render in this browser.';
  if (!health) return `Checking the exact deck renderer. ${exactRendererMessage}`;
  if (health.status === 'ready') {
    if (!health.presentationRenderer) {
      return `Exact deck renderer is unavailable. ${exactRendererMessage}`;
    }
    return health.presentationRenderer.ready
      ? ''
      : health.presentationRenderer.message || `Exact deck renderer is unavailable. ${exactRendererMessage}`;
  }
  if (health.status === 'checking') {
    return `Checking the exact deck renderer. ${exactRendererMessage}`;
  }
  return `${health.message || 'Media server is unavailable.'} ${exactRendererMessage}`;
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
