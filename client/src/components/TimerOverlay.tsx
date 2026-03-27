import { useState, useEffect, useCallback, useRef } from 'react';

export interface TimerData {
  id: string;
  mode: 'countdown' | 'countup';
  durationSeconds: number;
  remainingSeconds: number;
  isRunning: boolean;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  style: 'minimal' | 'bold' | 'neon';
  visible: boolean;
}

// ---------------------------------------------------------------------------
// TimerManager — control panel for creating and managing timers
// ---------------------------------------------------------------------------

interface TimerManagerProps {
  timers: TimerData[];
  onAdd: (timer: Omit<TimerData, 'id' | 'visible'>) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<TimerData>) => void;
}

export function TimerManager({ timers, onAdd, onToggle, onRemove, onUpdate }: TimerManagerProps) {
  const [mode, setMode] = useState<TimerData['mode']>('countdown');
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [position, setPosition] = useState<TimerData['position']>('top-right');
  const [style, setStyle] = useState<TimerData['style']>('minimal');

  const handleAdd = () => {
    const durationSeconds = mode === 'countdown' ? minutes * 60 + seconds : 0;
    onAdd({
      mode,
      durationSeconds,
      remainingSeconds: durationSeconds,
      isRunning: false,
      position,
      style,
    });
  };

  const handleStartPause = (timer: TimerData) => {
    onUpdate(timer.id, { isRunning: !timer.isRunning });
  };

  const handleReset = (timer: TimerData) => {
    onUpdate(timer.id, {
      isRunning: false,
      remainingSeconds: timer.mode === 'countdown' ? timer.durationSeconds : 0,
    });
  };

  const formatTime = (totalSeconds: number) => {
    const m = Math.floor(Math.abs(totalSeconds) / 60);
    const s = Math.abs(totalSeconds) % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div style={styles.container}>
      <h4 style={styles.sectionTitle}>Timers</h4>

      {/* Existing timers */}
      <div style={styles.list}>
        {timers.map((timer) => (
          <div key={timer.id} className="participant-item" style={styles.item}>
            <div style={styles.itemInfo}>
              <div style={styles.itemRow}>
                <span style={styles.itemTime}>{formatTime(timer.remainingSeconds)}</span>
                <span style={styles.itemModeBadge}>
                  {timer.mode === 'countdown' ? 'DOWN' : 'UP'}
                </span>
              </div>
              <span style={styles.itemMeta}>
                {timer.position.replace('-', ' ')} / {timer.style}
              </span>
            </div>
            <div style={styles.itemActions}>
              <button
                style={{
                  ...styles.controlBtn,
                  color: timer.isRunning ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                onClick={() => handleStartPause(timer)}
                title={timer.isRunning ? 'Pause' : 'Start'}
              >
                {timer.isRunning ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="6 3 20 12 6 21" />
                  </svg>
                )}
              </button>
              <button
                className="participant-action-btn"
                style={styles.controlBtn}
                onClick={() => handleReset(timer)}
                title="Reset"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
              </button>
              <button
                style={{
                  ...styles.toggleBtn,
                  background: timer.visible ? 'var(--success)' : 'var(--bg-surface)',
                  color: timer.visible ? 'white' : 'var(--text-muted)',
                }}
                onClick={() => onToggle(timer.id)}
              >
                {timer.visible ? 'ON' : 'OFF'}
              </button>
              <button className="participant-action-btn" style={styles.removeBtn} onClick={() => onRemove(timer.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add new timer form */}
      <div style={styles.form}>
        {/* Mode selector */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Mode</span>
          <div style={styles.segmented}>
            {(['countdown', 'countup'] as const).map((m) => (
              <button
                key={m}
                style={{
                  ...styles.segmentedBtn,
                  ...(mode === m ? styles.segmentedBtnActive : {}),
                }}
                onClick={() => setMode(m)}
              >
                {m === 'countdown' ? 'Countdown' : 'Count Up'}
              </button>
            ))}
          </div>
        </div>

        {/* Duration inputs (countdown only) */}
        {mode === 'countdown' && (
          <div style={styles.fieldGroup}>
            <span style={styles.fieldLabel}>Duration</span>
            <div style={styles.durationRow}>
              <div style={styles.durationField}>
                <input
                  type="number"
                  min={0}
                  max={99}
                  value={minutes}
                  onChange={(e) => setMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                  style={styles.durationInput}
                />
                <span style={styles.durationUnit}>min</span>
              </div>
              <span style={styles.durationSeparator}>:</span>
              <div style={styles.durationField}>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={seconds}
                  onChange={(e) => setSeconds(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                  style={styles.durationInput}
                />
                <span style={styles.durationUnit}>sec</span>
              </div>
            </div>
          </div>
        )}

        {/* Position selector */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Position</span>
          <div style={styles.positionGrid}>
            {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((p) => (
              <button
                key={p}
                style={{
                  ...styles.positionBtn,
                  ...(position === p ? styles.positionBtnActive : {}),
                }}
                onClick={() => setPosition(p)}
              >
                <div
                  style={{
                    ...styles.positionDot,
                    ...(position === p ? styles.positionDotActive : {}),
                    ...(positionDotPlacement[p]),
                  }}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Style presets */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Style</span>
          <div style={styles.styleRow}>
            {(['minimal', 'bold', 'neon'] as const).map((s) => (
              <button
                key={s}
                style={{
                  ...styles.styleBtn,
                  ...(style === s ? styles.styleBtnActive : {}),
                }}
                onClick={() => setStyle(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn-primary"
          style={styles.addBtn}
          onClick={handleAdd}
          disabled={mode === 'countdown' && minutes === 0 && seconds === 0}
        >
          Add Timer
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Position dot placement helpers
// ---------------------------------------------------------------------------

const positionDotPlacement: Record<TimerData['position'], React.CSSProperties> = {
  'top-left': { top: 3, left: 3 },
  'top-right': { top: 3, right: 3 },
  'bottom-left': { bottom: 3, left: 3 },
  'bottom-right': { bottom: 3, right: 3 },
};

// ---------------------------------------------------------------------------
// TimerOverlayDisplay — rendered on the stage
// ---------------------------------------------------------------------------

interface TimerOverlayDisplayProps {
  data: TimerData;
}

export function TimerOverlayDisplay({ data }: TimerOverlayDisplayProps) {
  if (!data.visible) return null;

  const isFinished = data.mode === 'countdown' && data.remainingSeconds <= 0 && !data.isRunning;
  const isUrgent = data.mode === 'countdown' && data.remainingSeconds <= 10 && data.remainingSeconds > 0;

  const formatTime = (totalSeconds: number) => {
    const m = Math.floor(Math.abs(totalSeconds) / 60);
    const s = Math.abs(totalSeconds) % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const positionStyle = getPositionStyle(data.position);
  const visualStyle = getVisualStyle(data.style, isFinished, isUrgent);

  return (
    <div
      aria-live="polite"
      role="timer"
      style={{
        ...overlayBase,
        ...positionStyle,
        ...visualStyle.container,
        animation: data.isRunning
          ? 'timerPulse 2s ease-in-out infinite'
          : isFinished
            ? 'timerFlash 0.6s ease-in-out infinite'
            : 'none',
      }}
    >
      <span style={visualStyle.time}>{formatTime(data.remainingSeconds)}</span>
      {data.mode === 'countdown' && isFinished && (
        <span style={visualStyle.label}>TIME</span>
      )}
      {/* Inject keyframes via a style tag */}
      <style>{timerKeyframes}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timer tick hook — use inside a parent that manages TimerData[]
// ---------------------------------------------------------------------------
// Note: The parent component should wire up a useEffect that calls onUpdate
// to tick timers. Below we provide the display + manager; the tick logic
// is intended to live in the parent or can be added via the pattern:
//
//   useEffect(() => {
//     if (!timer.isRunning) return;
//     const id = setInterval(() => {
//       onUpdate(timer.id, {
//         remainingSeconds: timer.mode === 'countdown'
//           ? Math.max(0, timer.remainingSeconds - 1)
//           : timer.remainingSeconds + 1,
//         ...(timer.mode === 'countdown' && timer.remainingSeconds <= 1
//           ? { isRunning: false }
//           : {}),
//       });
//     }, 1000);
//     return () => clearInterval(id);
//   }, [timer.isRunning, timer.remainingSeconds, timer.mode]);
//
// We also export a convenience hook below.

export function useTimerTick(
  timers: TimerData[],
  onUpdate: (id: string, updates: Partial<TimerData>) => void,
) {
  const timersRef = useRef(timers);
  const onUpdateRef = useRef(onUpdate);
  timersRef.current = timers;
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    const interval = setInterval(() => {
      for (const timer of timersRef.current) {
        if (!timer.isRunning) continue;
        if (timer.mode === 'countdown') {
          const next = Math.max(0, timer.remainingSeconds - 1);
          onUpdateRef.current(timer.id, {
            remainingSeconds: next,
            ...(next <= 0 ? { isRunning: false } : {}),
          });
        } else {
          onUpdateRef.current(timer.id, {
            remainingSeconds: timer.remainingSeconds + 1,
          });
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []); // Empty deps — uses refs to avoid tearing down the interval
}

// ---------------------------------------------------------------------------
// Keyframes (injected via <style>)
// ---------------------------------------------------------------------------

const timerKeyframes = `
@keyframes timerPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.85; }
}
@keyframes timerFlash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
`;

// ---------------------------------------------------------------------------
// Overlay position helpers
// ---------------------------------------------------------------------------

function getPositionStyle(position: TimerData['position']): React.CSSProperties {
  switch (position) {
    case 'top-left':
      return { top: 24, left: 24 };
    case 'top-right':
      return { top: 24, right: 24 };
    case 'bottom-left':
      return { bottom: 24, left: 24 };
    case 'bottom-right':
      return { bottom: 24, right: 24 };
  }
}

// ---------------------------------------------------------------------------
// Visual style presets
// ---------------------------------------------------------------------------

function getVisualStyle(
  style: TimerData['style'],
  isFinished: boolean,
  isUrgent: boolean,
) {
  const urgentColor = isFinished ? '#ef4444' : isUrgent ? '#f97316' : undefined;

  switch (style) {
    case 'minimal':
      return {
        container: {
          background: 'rgba(0, 0, 0, 0.6)',
          borderRadius: 10,
          padding: '8px 18px',
          backdropFilter: 'blur(8px)',
          border: urgentColor
            ? `1px solid ${urgentColor}`
            : '1px solid rgba(255,255,255,0.1)',
        } as React.CSSProperties,
        time: {
          fontSize: 32,
          fontWeight: 600,
          color: urgentColor || 'white',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.04em',
          lineHeight: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        } as React.CSSProperties,
        label: {
          fontSize: 10,
          fontWeight: 700,
          color: urgentColor || 'rgba(255,255,255,0.6)',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.12em',
          marginTop: 2,
        } as React.CSSProperties,
      };

    case 'bold':
      return {
        container: {
          background: urgentColor || 'var(--accent, #6366f1)',
          borderRadius: 12,
          padding: '12px 24px',
          boxShadow: `0 4px 24px ${urgentColor ? urgentColor + '66' : 'rgba(99,102,241,0.4)'}`,
        } as React.CSSProperties,
        time: {
          fontSize: 40,
          fontWeight: 800,
          color: 'white',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.06em',
          lineHeight: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
          textShadow: '0 2px 8px rgba(0,0,0,0.3)',
        } as React.CSSProperties,
        label: {
          fontSize: 11,
          fontWeight: 800,
          color: 'rgba(255,255,255,0.8)',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.14em',
          marginTop: 4,
        } as React.CSSProperties,
      };

    case 'neon':
      return {
        container: {
          background: 'rgba(0, 0, 0, 0.8)',
          borderRadius: 10,
          padding: '10px 22px',
          border: `1px solid ${urgentColor || '#22d3ee'}`,
          boxShadow: `0 0 20px ${urgentColor ? urgentColor + '44' : 'rgba(34,211,238,0.25)'}, inset 0 0 20px ${urgentColor ? urgentColor + '11' : 'rgba(34,211,238,0.05)'}`,
        } as React.CSSProperties,
        time: {
          fontSize: 36,
          fontWeight: 700,
          color: urgentColor || '#22d3ee',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.06em',
          lineHeight: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
          textShadow: `0 0 12px ${urgentColor ? urgentColor + '88' : 'rgba(34,211,238,0.6)'}, 0 0 30px ${urgentColor ? urgentColor + '44' : 'rgba(34,211,238,0.3)'}`,
        } as React.CSSProperties,
        label: {
          fontSize: 10,
          fontWeight: 700,
          color: urgentColor || '#22d3ee',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.14em',
          marginTop: 2,
          textShadow: `0 0 8px ${urgentColor ? urgentColor + '66' : 'rgba(34,211,238,0.4)'}`,
        } as React.CSSProperties,
      };
  }
}

// ---------------------------------------------------------------------------
// Base overlay style
// ---------------------------------------------------------------------------

const overlayBase: React.CSSProperties = {
  position: 'absolute',
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  userSelect: 'none',
};

// ---------------------------------------------------------------------------
// Manager panel styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '12px 0',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '0 16px',
    marginBottom: 8,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 12px',
    marginBottom: 12,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: 'var(--bg-tertiary)',
    borderRadius: 8,
    gap: 8,
  },
  itemInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    flex: 1,
  },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  itemTime: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  },
  itemModeBadge: {
    fontSize: 8,
    fontWeight: 700,
    color: 'var(--accent)',
    background: 'var(--accent-subtle)',
    padding: '1px 5px',
    borderRadius: 3,
    letterSpacing: '0.06em',
  },
  itemMeta: {
    fontSize: 10,
    color: 'var(--text-muted)',
    textTransform: 'capitalize',
  },
  itemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  controlBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'all 0.15s ease',
  },
  toggleBtn: {
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 8px',
    borderRadius: 4,
    border: 'none',
    cursor: 'pointer',
    letterSpacing: '0.04em',
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

  // Form
  form: {
    padding: '0 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fieldLabel: {
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
    flex: 1,
    fontSize: 11,
    fontWeight: 500,
    padding: '5px 0',
    borderRadius: 4,
    background: 'transparent',
    color: 'var(--text-muted)',
    border: 'none',
    cursor: 'pointer',
    textTransform: 'capitalize',
    transition: 'all 0.15s ease',
    textAlign: 'center',
  },
  segmentedBtnActive: {
    background: 'var(--accent)',
    color: 'white',
  },

  // Duration inputs
  durationRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  durationField: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flex: 1,
  },
  durationInput: {
    width: '100%',
    padding: '7px 10px',
    fontSize: 14,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    textAlign: 'center',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  },
  durationUnit: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontWeight: 500,
    flexShrink: 0,
  },
  durationSeparator: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-muted)',
    flexShrink: 0,
  },

  // Position grid
  positionGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 4,
  },
  positionBtn: {
    position: 'relative',
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  positionBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
  },
  positionDot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    background: 'var(--text-muted)',
  },
  positionDotActive: {
    background: 'var(--accent)',
  },

  // Style presets
  styleRow: {
    display: 'flex',
    gap: 4,
  },
  styleBtn: {
    flex: 1,
    fontSize: 10,
    fontWeight: 500,
    padding: '5px 0',
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    textTransform: 'capitalize',
  },
  styleBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent-hover)',
    borderColor: 'var(--accent)',
  },

  addBtn: {
    fontSize: 12,
    padding: '7px 12px',
    marginTop: 2,
  },
};
