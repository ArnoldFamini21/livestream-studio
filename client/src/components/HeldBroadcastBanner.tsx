import { useState, type CSSProperties } from 'react';
import type { HeldBannerView } from '../utils/heldBroadcastBanner.ts';

interface HeldBroadcastBannerProps {
  view: HeldBannerView;
  /** Runs the normal Go Live path; resolves to why it failed, or null. */
  onContinue: () => Promise<string | null>;
  onOpenDestinations: () => void;
  onDismiss: () => void;
}

/**
 * Top of the studio, for the host only: the broadcast is still on the air on
 * the "be right back" screen. The wording and the button come from
 * decideHeldBanner; this only draws them and runs the chosen action.
 */
export function HeldBroadcastBanner({ view, onContinue, onOpenDestinations, onDismiss }: HeldBroadcastBannerProps) {
  const [pressed, setPressed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ended = view.kind === 'ended';
  const disabled = view.buttonDisabled || pressed;

  const onClick = async () => {
    if (view.action === 'dismiss') return onDismiss();
    if (view.action === 'open-destinations') return onOpenDestinations();
    setFailure(null);
    setPressed(true);
    try {
      setFailure(await onContinue());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The broadcast could not continue.');
    } finally {
      setPressed(false);
    }
  };

  return (
    <div
      style={{ ...styles.wrap, ...(ended ? styles.ended : styles.held) }}
      role={ended ? 'alert' : 'region'}
      aria-label={ended ? 'Broadcast ended' : 'Broadcast still on the air'}
      data-testid="held-broadcast-banner"
      data-kind={view.kind}
    >
      <div style={styles.text}>
        <span style={styles.message} data-testid="held-broadcast-message">{view.message}</span>
        {(failure || view.note) && (
          <span style={styles.note} data-testid="held-broadcast-note">{failure || view.note}</span>
        )}
      </div>
      <button
        type="button"
        className={ended ? 'btn-secondary' : 'btn-primary'}
        style={styles.button}
        onClick={() => { void onClick(); }}
        disabled={disabled}
        data-testid="held-broadcast-action"
      >
        {pressed ? 'Continuing…' : view.buttonLabel}
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '10px 16px',
    margin: '0 12px',
    borderRadius: 10,
    border: '1px solid var(--warning)',
    color: 'var(--text-primary)',
    fontSize: 14,
    lineHeight: 1.4,
    flex: '0 0 auto',
  },
  held: {
    background: 'rgba(245, 158, 11, 0.14)',
  },
  ended: {
    background: 'var(--bg-surface)',
    borderColor: 'var(--border)',
  },
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    flex: '1 1 260px',
  },
  message: {
    fontWeight: 600,
  },
  note: {
    color: 'var(--text-muted)',
    fontSize: 13,
  },
  button: {
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
  },
};
