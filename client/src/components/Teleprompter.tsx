import { useState, useRef, useEffect, useCallback } from 'react';

interface TeleprompterProps {
  onClose: () => void;
}

type ScrollSpeed = 'slow' | 'medium' | 'fast';
type FontSizeOption = 'small' | 'medium' | 'large';

const SCROLL_SPEEDS: Record<ScrollSpeed, number> = {
  slow: 0.5,
  medium: 1.2,
  fast: 2.5,
};

const FONT_SIZES: Record<FontSizeOption, number> = {
  small: 18,
  medium: 26,
  large: 36,
};

export function Teleprompter({ onClose }: TeleprompterProps) {
  const [scriptText, setScriptText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<ScrollSpeed>('medium');
  const [fontSize, setFontSize] = useState<FontSizeOption>('medium');
  const [isMirrored, setIsMirrored] = useState(false);
  const [isEditing, setIsEditing] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);

  const scrollStep = useCallback(
    (timestamp: number) => {
      if (!scrollRef.current) return;

      if (lastTimestampRef.current === null) {
        lastTimestampRef.current = timestamp;
      }

      const delta = timestamp - lastTimestampRef.current;
      lastTimestampRef.current = timestamp;

      const pxPerFrame = SCROLL_SPEEDS[speed] * (delta / 16);
      scrollRef.current.scrollTop += pxPerFrame;

      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      if (scrollTop + clientHeight >= scrollHeight) {
        setIsPlaying(false);
        return;
      }

      animationRef.current = requestAnimationFrame(scrollStep);
    },
    [speed],
  );

  useEffect(() => {
    if (isPlaying) {
      lastTimestampRef.current = null;
      animationRef.current = requestAnimationFrame(scrollStep);
    } else if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isPlaying, scrollStep]);

  const handlePlayPause = useCallback(() => {
    if (isEditing && scriptText.trim()) {
      setIsEditing(false);
    }
    setIsPlaying((prev) => !prev);
  }, [isEditing, scriptText]);

  const handleReset = useCallback(() => {
    setIsPlaying(false);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, []);

  const handleEdit = useCallback(() => {
    setIsPlaying(false);
    setIsEditing(true);
  }, []);

  const handleStartReading = useCallback(() => {
    if (scriptText.trim()) {
      setIsEditing(false);
    }
  }, [scriptText]);

  return (
    <div style={styles.overlay}>
      {/* Header / toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <span style={styles.title}>Teleprompter</span>
          <span style={styles.badge}>Host only</span>
        </div>

        <div style={styles.toolbarCenter}>
          {/* Speed control */}
          <div style={styles.controlGroup}>
            <span style={styles.controlLabel}>Speed</span>
            <div style={styles.segmented}>
              {(['slow', 'medium', 'fast'] as ScrollSpeed[]).map((s) => (
                <button
                  key={s}
                  style={{
                    ...styles.segmentedBtn,
                    ...(speed === s ? styles.segmentedBtnActive : {}),
                  }}
                  onClick={() => setSpeed(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Font size control */}
          <div style={styles.controlGroup}>
            <span style={styles.controlLabel}>Size</span>
            <div style={styles.segmented}>
              {(['small', 'medium', 'large'] as FontSizeOption[]).map((s) => (
                <button
                  key={s}
                  style={{
                    ...styles.segmentedBtn,
                    ...(fontSize === s ? styles.segmentedBtnActive : {}),
                  }}
                  onClick={() => setFontSize(s)}
                >
                  {s.charAt(0).toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Mirror toggle */}
          <button
            style={{
              ...styles.iconBtn,
              ...(isMirrored ? styles.iconBtnActive : {}),
            }}
            onClick={() => setIsMirrored((prev) => !prev)}
            title="Mirror mode"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 8 3 12 7 16" />
              <line x1="3" y1="12" x2="11" y2="12" />
              <polyline points="17 8 21 12 17 16" />
              <line x1="21" y1="12" x2="13" y2="12" />
            </svg>
          </button>

          {/* Divider */}
          <div style={styles.divider} />

          {/* Playback controls */}
          {!isEditing && (
            <button style={styles.iconBtn} onClick={handleReset} title="Reset to top">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          )}

          <button
            style={{
              ...styles.playBtn,
              ...(isPlaying ? styles.playBtnActive : {}),
            }}
            onClick={handlePlayPause}
            disabled={!scriptText.trim()}
          >
            {isPlaying ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 3 20 12 6 21" />
              </svg>
            )}
            <span>{isPlaying ? 'Pause' : 'Play'}</span>
          </button>

          {!isEditing && (
            <button style={styles.iconBtn} onClick={handleEdit} title="Edit script">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
        </div>

        <div style={styles.toolbarRight}>
          <button style={styles.closeBtn} onClick={onClose} title="Close teleprompter">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Script content area */}
      <div style={styles.contentArea}>
        {isEditing ? (
          <div style={styles.editorWrapper}>
            <textarea
              style={styles.textarea}
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="Paste your script here..."
              autoFocus
            />
            <button
              style={{
                ...styles.startBtn,
                opacity: scriptText.trim() ? 1 : 0.4,
              }}
              onClick={handleStartReading}
              disabled={!scriptText.trim()}
            >
              Start Reading
            </button>
          </div>
        ) : (
          <div
            ref={scrollRef}
            style={{
              ...styles.scrollContainer,
              transform: isMirrored ? 'scaleX(-1)' : 'none',
            }}
          >
            {/* Top fade gradient */}
            <div style={styles.fadeTop} />

            <div
              style={{
                ...styles.scriptText,
                fontSize: FONT_SIZES[fontSize],
                lineHeight: 1.7,
              }}
            >
              {/* Top padding so text starts below the "focus line" */}
              <div style={{ height: 80 }} />
              {scriptText}
              {/* Bottom padding so the end of text can scroll to the focus line */}
              <div style={{ height: 300 }} />
            </div>

            {/* Bottom fade gradient */}
            <div style={styles.fadeBottom} />

            {/* Center "reading line" indicator */}
            <div style={styles.readingLine} />
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(0, 0, 0, 0.85)',
    backdropFilter: 'blur(8px)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  },

  // Toolbar
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    gap: 12,
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  toolbarCenter: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    justifyContent: 'center',
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
  },
  title: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
  },
  badge: {
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--accent)',
    background: 'var(--accent-subtle)',
    padding: '2px 6px',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  },

  // Control groups
  controlGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  controlLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  segmented: {
    display: 'flex',
    gap: 2,
    background: 'var(--bg-tertiary)',
    borderRadius: 6,
    padding: 2,
  },
  segmentedBtn: {
    fontSize: 10,
    fontWeight: 500,
    padding: '3px 8px',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    textTransform: 'capitalize',
    transition: 'all 0.15s ease',
  },
  segmentedBtnActive: {
    background: 'var(--accent)',
    color: 'white',
  },

  // Icon buttons
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'all 0.15s ease',
  },
  iconBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },

  divider: {
    width: 1,
    height: 20,
    background: 'var(--border)',
    flexShrink: 0,
  },

  // Play button
  playBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 6,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  playBtnActive: {
    background: 'var(--accent-hover)',
  },

  // Close button
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'color 0.15s ease',
  },

  // Content area
  contentArea: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },

  // Editor
  editorWrapper: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    padding: 16,
    gap: 12,
  },
  textarea: {
    flex: 1,
    width: '100%',
    padding: 16,
    fontSize: 14,
    lineHeight: 1.7,
    fontFamily: 'inherit',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    resize: 'none',
  },
  startBtn: {
    alignSelf: 'center',
    padding: '10px 28px',
    fontSize: 14,
    fontWeight: 600,
    borderRadius: 'var(--radius)',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    transition: 'opacity 0.15s ease',
  },

  // Scroll / reading view
  scrollContainer: {
    height: '100%',
    overflowY: 'auto',
    position: 'relative',
    scrollbarWidth: 'none',
  },
  scriptText: {
    padding: '0 48px',
    color: 'var(--text-primary)',
    fontWeight: 500,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },

  // Fades
  fadeTop: {
    position: 'sticky',
    top: 0,
    left: 0,
    right: 0,
    height: 60,
    background: 'linear-gradient(to bottom, rgba(0,0,0,0.85), transparent)',
    pointerEvents: 'none',
    zIndex: 2,
  },
  fadeBottom: {
    position: 'sticky',
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
    background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)',
    pointerEvents: 'none',
    zIndex: 2,
  },

  // Reading line indicator
  readingLine: {
    position: 'absolute',
    top: 80,
    left: 24,
    right: 24,
    height: 2,
    background: 'var(--accent)',
    opacity: 0.4,
    borderRadius: 1,
    pointerEvents: 'none',
    zIndex: 3,
  },
};
