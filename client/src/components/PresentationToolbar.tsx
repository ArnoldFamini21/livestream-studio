import { useEffect, useId, useRef, useState } from 'react';
import type { ActiveMedia } from '@studio/shared';
import { clampPresentationSlideIndex, getPresentationDeckStatus, getPresentationItemDisplayTitle, getSharedContentLabel, type SharedContentKind } from '../utils/presentationDeckControls.ts';
import '../styles/presentation.css';

const KIND_ICONS: Record<SharedContentKind, JSX.Element> = {
  deck: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M12 16v4M8 20h8" /></>,
  pdf: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m21 16-5-5-8 8" /></>,
  video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
  screen: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><path d="m10 8 4 2-4 2z" /></>,
  file: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /></>,
};

function ToolbarIcon({ children }: { children: JSX.Element }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

export function PresentationToolbar({ media, slideIndex, onSlideIndexChange, screenName, screens = [], selectedScreenId, onScreenChange, canStopScreen, onStop }: {
  media: ActiveMedia | null;
  slideIndex: number;
  onSlideIndexChange: (index: number) => void;
  screenName?: string;
  screens?: Array<{ id: string; name: string }>;
  selectedScreenId?: string | null;
  onScreenChange?: (id: string) => void;
  canStopScreen: boolean;
  onStop: () => void;
}) {
  const deck = getPresentationDeckStatus(media, slideIndex);
  const label = getSharedContentLabel(media, screenName);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => setPickerOpen(false), [media?.assetId]);
  const subtitle = deck.hasDeck
    ? `${label.kindLabel} · ${deck.unitLabel} ${deck.currentIndex + 1} of ${deck.total}`
    : label.kindLabel;
  return <div className="presentation-toolbar" role="group" aria-label="Presentation controls">
    <div className="presentation-identity">
      <span className="presentation-kind" aria-hidden="true"><ToolbarIcon>{KIND_ICONS[label.kind]}</ToolbarIcon></span>
      <div className="presentation-identity-text">
        {!media && screens.length > 1 && onScreenChange
          ? <select className="presentation-source" aria-label="Screen on stage" value={selectedScreenId || screens[0].id} onChange={event => onScreenChange(event.target.value)}>
              {screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}
            </select>
          : <span className="presentation-title" title={media?.name || screenName}>{label.title}</span>}
        <span className="presentation-subtitle">{subtitle}</span>
      </div>
    </div>
    {deck.hasDeck && <div className="presentation-navigation">
      <button type="button" className="presentation-step" aria-label={`Previous ${deck.unitLabel.toLowerCase()}`} title="Previous (←)" disabled={!deck.canGoPrevious} onClick={() => onSlideIndexChange(deck.currentIndex - 1)}>
        <ToolbarIcon><path d="m15 6-6 6 6 6" /></ToolbarIcon>
      </button>
      <button type="button" className="presentation-slide-picker-trigger" aria-label={`Choose ${deck.unitLabel.toLowerCase()} · ${deck.currentIndex + 1} of ${deck.total}`} aria-haspopup="dialog" title="Preview slides and speaker notes" onClick={() => setPickerOpen(true)}>
        <span aria-live="polite" aria-atomic="true">{deck.currentIndex + 1} <small>/ {deck.total}</small></span>
        <ToolbarIcon><path d="m8 10 4 4 4-4" /></ToolbarIcon>
      </button>
      <button type="button" className="presentation-step" aria-label={`Next ${deck.unitLabel.toLowerCase()}`} title="Next (→)" disabled={!deck.canGoNext} onClick={() => onSlideIndexChange(deck.currentIndex + 1)}>
        <ToolbarIcon><path d="m9 6 6 6-6 6" /></ToolbarIcon>
      </button>
    </div>}
    {(media || canStopScreen) && <button type="button" className="presentation-stop" onClick={onStop}>
      <ToolbarIcon><rect x="6" y="6" width="12" height="12" rx="2" /></ToolbarIcon>
      <span>Stop presenting</span>
    </button>}
    {pickerOpen && deck.hasDeck && media && <PresentationSlidePicker key={media.assetId} media={media} slideIndex={slideIndex} onShow={onSlideIndexChange} onClose={() => setPickerOpen(false)} />}
  </div>;
}

// This dialog lives in the canvas footer, outside the recorded broadcast surface.
// Selecting or navigating a preview never publishes it; only Show does that.
function PresentationSlidePicker({ media, slideIndex, onShow, onClose }: {
  media: ActiveMedia; slideIndex: number; onShow: (index: number) => void; onClose: () => void;
}) {
  const deck = getPresentationDeckStatus(media, slideIndex);
  const [cueIndex, setCueIndex] = useState(deck.currentIndex);
  const [failedSource, setFailedSource] = useState<string | undefined>();
  const cue = clampPresentationSlideIndex(cueIndex, deck.total);
  const slide = deck.slides[cue];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const noteId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const imageFailed = !slide?.imageUrl || failedSource === slide.imageUrl;
  return <dialog ref={dialogRef} className="presentation-picker" aria-labelledby={titleId} aria-describedby={noteId} onClose={onClose} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : ['ArrowRight', 'PageDown'].includes(event.key) ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    setCueIndex(current => clampPresentationSlideIndex(current + delta, deck.total));
  }}>
    <header className="presentation-picker-header">
      <div><h2 id={titleId}>{media.name}</h2><p id={noteId}>Private preview · choose a {deck.unitLabel.toLowerCase()}, then show it on stage.</p></div>
      <button type="button" aria-label="Close slide picker" onClick={() => dialogRef.current?.close()}>×</button>
    </header>
    <div className="presentation-picker-content">
      <div className="presentation-picker-slides" role="group" aria-label={`${deck.unitLabel}s in presentation`}>
        {deck.slides.map((item, index) => <button type="button" key={index} aria-pressed={index === cue} aria-label={`Preview ${deck.unitLabel.toLowerCase()} ${index + 1}: ${getPresentationItemDisplayTitle(item, index, deck.unitLabel)}`} onClick={() => setCueIndex(index)}>
          {item.imageUrl && <img src={item.imageUrl} alt="" loading="lazy" />}
          <span>{index + 1}{index === deck.currentIndex && <small>On stage</small>}</span>
        </button>)}
      </div>
      <div className="presentation-picker-preview">
        <div className="presentation-picker-image">
          {imageFailed ? <p>This preview could not load. Choose another {deck.unitLabel.toLowerCase()}.</p> : <img src={slide.imageUrl} alt={getPresentationItemDisplayTitle(slide, cue, deck.unitLabel)} onError={() => setFailedSource(slide.imageUrl)} />}
        </div>
        <div className="presentation-picker-caption"><span>{deck.unitLabel} {cue + 1} of {deck.total}</span><span aria-live="polite">On stage: {deck.currentIndex + 1}</span></div>
        {!!slide?.notes?.length && <section className="presentation-picker-notes" aria-label="Private speaker notes"><h3>Speaker notes · only you</h3>{slide.notes.map((note, index) => <p key={index}>{note}</p>)}</section>}
      </div>
    </div>
    <footer className="presentation-picker-footer"><span>← → to preview</span><button type="button" className="presentation-picker-show" disabled={cue === deck.currentIndex || imageFailed} onClick={() => onShow(cue)}>{cue === deck.currentIndex ? 'On stage' : `Show ${deck.unitLabel.toLowerCase()} ${cue + 1}`}</button></footer>
  </dialog>;
}
