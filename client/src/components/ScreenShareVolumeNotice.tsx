import type { ScreenVolumeNoticeCopy } from '../audio/screenVolumeNotice.ts';
import '../styles/mix-controls.css';

export interface ScreenShareVolumeNoticeProps {
  copy: ScreenVolumeNoticeCopy;
  onRestore: () => void;
  onKeep: () => void;
}

/** Shown to the person running the program when a share starts below full volume. */
export function ScreenShareVolumeNotice({ copy, onRestore, onKeep }: ScreenShareVolumeNoticeProps) {
  return (
    <div className="mix-notice" data-testid="screen-volume-notice">
      <span className="mix-notice-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" />
          <path d="M22 9l-6 6" />
          <path d="m16 9 6 6" />
        </svg>
      </span>
      <span className="mix-notice-copy">
        <strong>{copy.message}</strong>
        <span className="mix-notice-actions">
          <button type="button" className="mix-notice-btn mix-notice-btn--primary" onClick={onRestore}>
            {copy.restoreLabel}
          </button>
          <button type="button" className="mix-notice-btn" onClick={onKeep}>
            {copy.keepLabel}
          </button>
        </span>
      </span>
    </div>
  );
}
