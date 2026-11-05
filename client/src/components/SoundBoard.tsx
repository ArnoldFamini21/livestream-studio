import { useCallback, useEffect, useRef, useState } from 'react';
import type { SoundBoardPlayer } from '../audio/soundBoardPlayer.ts';
import { listSoundPads } from '../audio/soundBoardPlayer.ts';
import { useSoundBoardState } from '../audio/useSoundBoardPlayer.ts';
import { shouldIgnoreShortcutTarget } from '../utils/keyboardShortcuts.ts';
import { MAX_CUSTOM_SOUND_BYTES, MAX_CUSTOM_SOUND_SECONDS } from '../utils/soundBoard.ts';

interface SoundBoardProps {
  onClose: () => void;
  /** The studio-level player: sounds keep playing when this panel closes. */
  player: SoundBoardPlayer;
}

/**
 * Sound board controls, docked beside the stage so the host can keep
 * producing while it is open. Pads play through the studio's media bus (the
 * stream, the program recording and guests all hear them).
 */
export function SoundBoard({ onClose, player }: SoundBoardProps) {
  const state = useSoundBoardState(player);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pads = listSoundPads(state.customSounds);
  const builtInPads = pads.filter((pad) => pad.kind === 'built-in');
  const customPads = pads.filter((pad) => pad.kind === 'custom');

  useEffect(() => {
    void player.loadLibrary();
  }, [player]);

  // Escape closes the dock (sounds keep playing) unless the host is typing.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !shouldIgnoreShortcutTarget(e.target as HTMLElement | null)) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    setUploading(true);
    try {
      await player.addCustomSound(file);
    } finally {
      setUploading(false);
    }
  }, [player]);

  const renderPadVolume = (padId: string, name: string) => (
    <input
      type="range"
      min="0"
      max="1"
      step="0.05"
      aria-label={`${name} volume`}
      title={`${name} volume`}
      value={state.padVolumes[padId] ?? 1}
      onChange={(e) => player.setPadVolume(padId, parseFloat(e.target.value))}
      style={styles.padVolume}
    />
  );

  return (
    <div style={styles.overlay}>
      <div style={styles.panel} role="dialog" aria-modal="false" aria-label="Sound board">
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <span style={styles.headerTitle}>Sound Board</span>
          </div>
          <div style={styles.headerActions}>
            <button
              type="button"
              style={{ ...styles.stopAllBtn, opacity: state.playingIds.length > 0 ? 1 : 0.55 }}
              onClick={() => player.stopAll()}
              disabled={state.playingIds.length === 0}
              title="Stop all sounds"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
              Stop all
            </button>
            <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose} title="Close" aria-label="Close sound board">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div style={styles.volumeRow}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          </svg>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            aria-label="Sound effects volume"
            value={state.volume}
            onChange={(e) => player.setVolume(parseFloat(e.target.value))}
            style={styles.volumeSlider}
          />
          <span style={styles.volumeLabel}>{Math.round(state.volume * 100)}%</span>
        </div>

        <div style={styles.routingSection}>
          <span style={styles.sectionLabel}>Mix Routing</span>
          <div style={styles.routingGrid}>
            <label style={styles.routingOption}>
              <span style={styles.routingLabel}>Stream &amp; guests</span>
              <span style={styles.routingState}>{state.sendToStream ? 'On' : 'Off'}</span>
              <input
                type="checkbox"
                checked={state.sendToStream}
                onChange={(e) => player.setSendToStream(e.target.checked)}
                style={styles.routingCheckbox}
                aria-label="Send sound board to the stream, recording and guests"
              />
            </label>
            <label style={styles.routingOption}>
              <span style={styles.routingLabel}>Monitor</span>
              <span style={styles.routingState}>{state.monitorEnabled ? 'On' : 'Off'}</span>
              <input
                type="checkbox"
                checked={state.monitorEnabled}
                onChange={(e) => player.setMonitorEnabled(e.target.checked)}
                style={styles.routingCheckbox}
                aria-label="Monitor sound board locally"
              />
            </label>
          </div>
        </div>

        <div style={styles.grid}>
          {builtInPads.map((pad) => {
            const playing = state.playingIds.includes(pad.id);
            return (
              <div key={pad.id} style={styles.padCell}>
                <button
                  type="button"
                  style={{
                    ...styles.effectBtn,
                    borderColor: playing ? pad.color : 'var(--border)',
                    boxShadow: playing ? `0 0 12px ${pad.color}44, inset 0 0 20px ${pad.color}11` : 'none',
                  }}
                  onClick={() => void player.play(pad.id)}
                  aria-label={`Play ${pad.name}${pad.hotkey ? ` (${pad.hotkey})` : ''}`}
                  title={pad.hotkey ? `${pad.name} (${pad.hotkey})` : pad.name}
                >
                  <span style={styles.effectIcon}>{pad.icon}</span>
                  <span style={styles.effectName}>{pad.name}</span>
                  {pad.hotkey && <kbd style={styles.hotkey}>{pad.hotkey.replace('Shift+', '⇧')}</kbd>}
                </button>
                {renderPadVolume(pad.id, pad.name)}
              </div>
            );
          })}
        </div>

        <div style={styles.divider} />
        <div style={styles.customSection}>
          <span style={styles.sectionLabel}>Custom Sounds</span>
          {customPads.length === 0 && state.libraryStatus !== 'loading' && (
            <span style={styles.emptyText}>Upload short clips (up to {MAX_CUSTOM_SOUND_SECONDS}s). They stay in this browser.</span>
          )}
          <div style={styles.customGrid}>
            {customPads.map((pad) => {
              const playing = state.playingIds.includes(pad.id);
              return (
                <div key={pad.id} style={styles.customItem}>
                  <button
                    type="button"
                    style={{ ...styles.customPlayBtn, borderColor: playing ? 'var(--accent)' : 'var(--border)' }}
                    onClick={() => void player.play(pad.id)}
                    aria-label={`Play ${pad.name}${pad.hotkey ? ` (${pad.hotkey})` : ''}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--text-muted)">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span style={styles.customName}>{pad.name}</span>
                    {pad.hotkey && <kbd style={styles.hotkey}>{pad.hotkey.replace('Shift+', '⇧')}</kbd>}
                  </button>
                  {renderPadVolume(pad.id, pad.name)}
                  <button
                    type="button"
                    style={styles.removeBtn}
                    onClick={() => void player.removeCustomSound(pad.id)}
                    title="Remove"
                    aria-label={`Remove ${pad.name}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {state.message && (
          <div style={styles.message} role="status">
            <span>{state.message}</span>
            <button type="button" style={styles.messageDismiss} onClick={() => player.clearMessage()} aria-label="Dismiss">×</button>
          </div>
        )}

        <div style={styles.uploadSection}>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={(e) => void handleFileUpload(e)}
            style={styles.fileInput}
            id="sound-upload"
            disabled={uploading}
          />
          <label htmlFor="sound-upload" style={{ ...styles.uploadLabel, opacity: uploading ? 0.6 : 1 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>{uploading ? 'Adding sound...' : `Upload custom sound (max ${Math.round(MAX_CUSTOM_SOUND_BYTES / 1024 / 1024)} MB)`}</span>
          </label>
          <span style={styles.hint}>Shift + 1…0 plays the first ten pads, even with this panel closed.</span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // Docked, non-modal: the stage stays visible and clickable.
  overlay: {
    position: 'fixed',
    right: 16,
    bottom: 88,
    zIndex: 900,
    pointerEvents: 'none',
    maxWidth: 'calc(100vw - 32px)',
  },
  panel: {
    pointerEvents: 'auto',
    width: 380,
    maxWidth: '100%',
    maxHeight: 'calc(100vh - 140px)',
    overflowY: 'auto',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px',
    borderBottom: '1px solid var(--border)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-primary)',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  stopAllBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  volumeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-muted)',
  },
  volumeSlider: {
    flex: 1,
    height: 4,
    cursor: 'pointer',
    accentColor: 'var(--accent)',
  },
  volumeLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    minWidth: 32,
    textAlign: 'right',
  },
  routingSection: {
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
  },
  routingGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 8,
    marginTop: 8,
  },
  routingOption: {
    minHeight: 38,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    gap: 8,
    padding: '8px 9px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    cursor: 'pointer',
  },
  routingLabel: {
    minWidth: 0,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  routingState: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
  },
  routingCheckbox: {
    width: 16,
    height: 16,
    accentColor: 'var(--accent)',
    cursor: 'pointer',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: 8,
    padding: 14,
  },
  padCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  effectBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '12px 4px 8px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'border-color 0.1s ease, box-shadow 0.1s ease',
    position: 'relative',
    color: 'var(--text-primary)',
  },
  effectIcon: {
    fontSize: 20,
    lineHeight: 1,
  },
  effectName: {
    fontSize: 10,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textAlign: 'center',
    lineHeight: 1.2,
  },
  hotkey: {
    fontSize: 9,
    fontFamily: 'inherit',
    fontWeight: 600,
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '0 4px',
    lineHeight: '14px',
  },
  padVolume: {
    width: '100%',
    height: 4,
    cursor: 'pointer',
    accentColor: 'var(--accent)',
  },
  divider: {
    height: 1,
    background: 'var(--border)',
    margin: '0 14px',
  },
  customSection: {
    padding: '12px 14px',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
    display: 'block',
  },
  emptyText: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  customGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  customItem: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 72px 24px',
    alignItems: 'center',
    gap: 6,
  },
  customPlayBtn: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
    color: 'var(--text-primary)',
    fontSize: 12,
  },
  customName: {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    margin: '0 14px 10px',
    padding: '8px 10px',
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: 11,
  },
  messageDismiss: {
    marginLeft: 'auto',
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    padding: 0,
  },
  uploadSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '0 14px 14px',
  },
  fileInput: {
    display: 'none',
  },
  uploadLabel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '9px',
    borderRadius: 8,
    border: '1px dashed var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  hint: {
    fontSize: 10,
    color: 'var(--text-muted)',
    textAlign: 'center',
  },
};
