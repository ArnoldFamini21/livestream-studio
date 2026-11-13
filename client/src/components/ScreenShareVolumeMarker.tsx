import type { ScreenVolumeMarkerCopy } from '../audio/screenVolumeNotice.ts';
import '../styles/mix-controls.css';

export interface ScreenShareVolumeMarkerProps {
  copy: ScreenVolumeMarkerCopy;
  /** Opens People, where the slider is. */
  onOpen: () => void;
}

/** A small reminder beside the People opener while viewers hear the share below full volume. */
export function ScreenShareVolumeMarker({ copy, onOpen }: ScreenShareVolumeMarkerProps) {
  return (
    <button
      type="button"
      className="mix-marker"
      data-testid="screen-volume-marker"
      onClick={onOpen}
      title={copy.title}
      aria-label={copy.title}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H2v6h4l5 4V5Z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      </svg>
      {copy.label}
    </button>
  );
}
