import type { ActiveMedia } from '@studio/shared';
import { getPresentationDeckStatus } from '../utils/presentationDeckControls.ts';
import '../styles/presentation.css';

export function PresentationToolbar({ media, slideIndex, onSlideIndexChange, screenName, canStopScreen, onStop }: {
  media: ActiveMedia | null;
  slideIndex: number;
  onSlideIndexChange: (index: number) => void;
  screenName?: string;
  canStopScreen: boolean;
  onStop: () => void;
}) {
  const deck = getPresentationDeckStatus(media, slideIndex);
  return <div className="presentation-toolbar" role="group" aria-label="Presentation controls">
    <span className="presentation-title" title={media?.name || screenName}>{media?.name || screenName || 'Shared screen'}</span>
    {deck.hasDeck && <div className="presentation-navigation">
      <button type="button" aria-label="Previous slide" title="Previous slide (←)" disabled={!deck.canGoPrevious} onClick={() => onSlideIndexChange(deck.currentIndex - 1)}>←</button>
      <span aria-live="polite" aria-atomic="true">{deck.currentIndex + 1} / {deck.total}</span>
      <button type="button" aria-label="Next slide" title="Next slide (→)" disabled={!deck.canGoNext} onClick={() => onSlideIndexChange(deck.currentIndex + 1)}>→</button>
    </div>}
    {(media || canStopScreen) && <button type="button" className="presentation-stop" onClick={onStop}>Stop sharing</button>}
  </div>;
}
