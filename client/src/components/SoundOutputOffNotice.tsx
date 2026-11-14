import {
  SOUND_OUTPUT_OFF_MARKER,
  SOUND_OUTPUT_RESTORE_LABEL,
  SOUND_OUTPUT_RESTORING_LABEL,
} from '../utils/relayMediaNotices.ts';
import '../styles/mix-controls.css';

export interface SoundOutputOffNoticeProps {
  restoring: boolean;
  /** Why the last "Turn sound back on" did not work; null when it has not failed. */
  failureMessage: string | null;
  onRestore: () => void;
}

/**
 * Stays in the studio's notice area for as long as the studio's sound output
 * is off (it had to switch it off to keep the broadcast going).
 */
export function SoundOutputOffNotice({ restoring, failureMessage, onRestore }: SoundOutputOffNoticeProps) {
  return (
    <div className="mix-notice" data-testid="sound-output-off-notice">
      <span className="mix-notice-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5 6 9H2v6h4l5 4V5Z" />
          <path d="M22 9l-6 6" />
          <path d="m16 9 6 6" />
        </svg>
      </span>
      <span className="mix-notice-copy">
        <strong data-testid="sound-output-off-message">{SOUND_OUTPUT_OFF_MARKER}</strong>
        {failureMessage && <span data-testid="sound-output-off-failure">{failureMessage}</span>}
        <span className="mix-notice-actions">
          <button
            type="button"
            className="mix-notice-btn mix-notice-btn--primary"
            onClick={onRestore}
            disabled={restoring}
            data-testid="sound-output-restore"
          >
            {restoring ? SOUND_OUTPUT_RESTORING_LABEL : SOUND_OUTPUT_RESTORE_LABEL}
          </button>
        </span>
      </span>
    </div>
  );
}
