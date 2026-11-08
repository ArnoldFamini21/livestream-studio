import type { CSSProperties } from 'react';

interface GuestCaptionShareProps {
  sharing: boolean;
  listening: boolean;
  supported: boolean;
  error: string | null;
  onChange: (sharing: boolean) => void;
}

/**
 * Shown to an on-stage guest while the host has live captions on: the guest
 * chooses whether their browser captions their own voice for the show.
 */
export function GuestCaptionShare({ sharing, listening, supported, error, onChange }: GuestCaptionShareProps) {
  return (
    <div style={styles.card} role="region" aria-label="Live captions">
      <div style={styles.row}>
        <span style={styles.title}>Live captions are on</span>
        {supported ? (
          <label style={styles.toggle}>
            <input type="checkbox" checked={sharing} onChange={(event) => onChange(event.target.checked)} />
            <span>Caption my voice</span>
          </label>
        ) : null}
      </div>
      <span style={styles.note}>
        {!supported
          ? 'Your browser cannot caption speech. Chrome, Edge or Safari can.'
          : sharing
            ? listening
              ? 'Your words appear in the show captions under your name.'
              : 'Starting captions...'
            : 'Your browser turns your speech into text for the host. Speech is processed by your browser’s speech service.'}
      </span>
      {error && sharing && <span style={styles.error}>{error}</span>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    position: 'fixed',
    left: 16,
    bottom: 96,
    zIndex: 40,
    maxWidth: 'min(320px, calc(100vw - 32px))',
    display: 'grid',
    gap: 4,
    padding: '8px 10px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary, rgba(17, 24, 39, 0.92))',
    color: 'var(--text-primary)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  title: { fontSize: 12, fontWeight: 700 },
  toggle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' },
  note: { fontSize: 11, lineHeight: 1.35, color: 'var(--text-secondary)' },
  error: { fontSize: 11, color: 'var(--danger, #f87171)' },
};
