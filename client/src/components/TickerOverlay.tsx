import { useState, useRef, useEffect } from 'react';

export interface TickerData {
  id: string;
  text: string;
  speed: 'slow' | 'normal' | 'fast';
  backgroundColor: string;
  textColor: string;
  visible: boolean;
  separator: string;
}

// ---------------------------------------------------------------------------
// TickerOverlayDisplay — the on-screen scrolling overlay
// ---------------------------------------------------------------------------

interface TickerOverlayDisplayProps {
  data: TickerData;
}

const SPEED_DURATION: Record<TickerData['speed'], number> = {
  slow: 30,
  normal: 20,
  fast: 12,
};

export function TickerOverlayDisplay({ data }: TickerOverlayDisplayProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [textWidth, setTextWidth] = useState(0);
  const [isPresent, setIsPresent] = useState(data.visible);
  const [isAnimatingIn, setIsAnimatingIn] = useState(data.visible);

  // Measure the single text block width so we can build a seamless loop
  useEffect(() => {
    if (textRef.current) {
      setTextWidth(textRef.current.offsetWidth);
    }
  }, [data.text, data.separator]);

  // Handle enter/exit transitions
  useEffect(() => {
    if (data.visible) {
      setIsPresent(true);
      // Trigger slide-up on next frame
      requestAnimationFrame(() => setIsAnimatingIn(true));
    } else {
      setIsAnimatingIn(false);
      // Wait for slide-out transition to finish before unmounting
      const timeout = setTimeout(() => setIsPresent(false), 350);
      return () => clearTimeout(timeout);
    }
  }, [data.visible]);

  const duration = SPEED_DURATION[data.speed];
  const keyframeName = `tickerScroll-${data.id}`;

  // Build the repeated text content: "text separator text separator ..."
  const segment = `${data.text} ${data.separator} `;

  if (!isPresent) return null;

  return (
    <div
      style={{
        ...overlayBar,
        backgroundColor: data.backgroundColor,
        transform: isAnimatingIn ? 'translateY(0)' : 'translateY(100%)',
        opacity: isAnimatingIn ? 1 : 0,
      }}
    >
      {/* Inject unique keyframes for this ticker */}
      <style>{`
        @keyframes ${keyframeName} {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
      `}</style>

      {/* Left fade edge */}
      <div
        style={{
          ...edgeFadeBase,
          left: 0,
          background: `linear-gradient(to right, ${data.backgroundColor} 0%, transparent 100%)`,
        }}
      />

      {/* Scrolling track */}
      <div ref={trackRef} style={scrollTrack}>
        <div
          style={{
            display: 'flex',
            whiteSpace: 'nowrap',
            animation: `${keyframeName} ${duration}s linear infinite`,
            willChange: 'transform',
          }}
        >
          {/* Two identical copies for seamless looping */}
          <span
            ref={textRef}
            style={{
              ...scrollText,
              color: data.textColor,
            }}
          >
            {segment}{segment}{segment}{segment}{segment}{segment}{segment}{segment}
          </span>
          <span
            style={{
              ...scrollText,
              color: data.textColor,
            }}
          >
            {segment}{segment}{segment}{segment}{segment}{segment}{segment}{segment}
          </span>
        </div>
      </div>

      {/* Right fade edge */}
      <div
        style={{
          ...edgeFadeBase,
          right: 0,
          background: `linear-gradient(to left, ${data.backgroundColor} 0%, transparent 100%)`,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TickerManager — sidebar/panel control for managing tickers
// ---------------------------------------------------------------------------

interface TickerManagerProps {
  tickers: TickerData[];
  onAdd: (ticker: Omit<TickerData, 'id' | 'visible'>) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<TickerData>) => void;
}

const BG_PRESETS = [
  '#1e1e2e',
  '#1a1a2e',
  '#0f172a',
  '#18181b',
  '#1c1917',
  '#dc2626',
  '#2563eb',
  '#7c3aed',
  '#059669',
  '#d97706',
];

const TEXT_COLOR_PRESETS = [
  { label: 'White', value: '#ffffff' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Cyan', value: '#22d3ee' },
];

const SEPARATOR_PRESETS = ['\u2022', '\u2605', '|', '\u2014', '\u26A1'];

const MAX_TICKERS = 5;

export function TickerManager({ tickers, onAdd, onToggle, onRemove, onUpdate }: TickerManagerProps) {
  const [text, setText] = useState('');
  const [speed, setSpeed] = useState<TickerData['speed']>('normal');
  const [backgroundColor, setBackgroundColor] = useState(BG_PRESETS[0]);
  const [textColor, setTextColor] = useState(TEXT_COLOR_PRESETS[0].value);
  const [separator, setSeparator] = useState(SEPARATOR_PRESETS[0]);

  const handleAdd = () => {
    if (!text.trim() || tickers.length >= MAX_TICKERS) return;
    onAdd({
      text: text.trim(),
      speed,
      backgroundColor,
      textColor,
      separator,
    });
    setText('');
  };

  return (
    <div style={styles.container}>
      <h4 style={styles.sectionTitle}>Scrolling Tickers</h4>

      {/* Add Ticker form */}
      <div style={styles.form}>
        <input
          style={styles.input}
          placeholder="Ticker message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
        />

        {/* Speed selector */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Speed</span>
          <div style={styles.speedRow}>
            {(['slow', 'normal', 'fast'] as const).map((s) => (
              <button
                key={s}
                style={{
                  ...styles.speedBtn,
                  ...(speed === s ? styles.speedBtnActive : {}),
                }}
                onClick={() => setSpeed(s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Background color picker */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Background</span>
          <div style={styles.colorRow}>
            {BG_PRESETS.map((c) => (
              <button
                key={c}
                style={{
                  ...styles.colorBtn,
                  background: c,
                  outline: backgroundColor === c ? `2px solid var(--accent)` : 'none',
                  outlineOffset: 2,
                }}
                onClick={() => setBackgroundColor(c)}
                title={c}
              />
            ))}
          </div>
        </div>

        {/* Text color picker */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Text Color</span>
          <div style={styles.textColorRow}>
            {TEXT_COLOR_PRESETS.map((tc) => (
              <button
                key={tc.value}
                style={{
                  ...styles.textColorBtn,
                  color: tc.value,
                  ...(textColor === tc.value ? styles.textColorBtnActive : {}),
                }}
                onClick={() => setTextColor(tc.value)}
              >
                {tc.label}
              </button>
            ))}
          </div>
        </div>

        {/* Separator picker */}
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Separator</span>
          <div style={styles.separatorRow}>
            {SEPARATOR_PRESETS.map((sep) => (
              <button
                key={sep}
                style={{
                  ...styles.separatorBtn,
                  ...(separator === sep ? styles.separatorBtnActive : {}),
                }}
                onClick={() => setSeparator(sep)}
              >
                {sep}
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn-primary"
          style={styles.addBtn}
          onClick={handleAdd}
          disabled={!text.trim() || tickers.length >= MAX_TICKERS}
        >
          {tickers.length >= MAX_TICKERS ? `Max ${MAX_TICKERS} tickers` : 'Add Ticker'}
        </button>
      </div>

      {/* Existing tickers list */}
      {tickers.length > 0 && (
        <div style={styles.list}>
          {tickers.map((ticker) => (
            <div key={ticker.id} className="participant-item" style={styles.item}>
              <div style={styles.itemInfo}>
                <div
                  style={{
                    ...styles.previewStrip,
                    backgroundColor: ticker.backgroundColor,
                    color: ticker.textColor,
                  }}
                >
                  <span style={styles.previewText}>{ticker.text}</span>
                </div>
                <div style={styles.itemMeta}>
                  <span style={styles.itemTag}>{ticker.speed}</span>
                  <span style={styles.itemTag}>{ticker.separator}</span>
                </div>
              </div>
              <div style={styles.itemActions}>
                <button
                  style={{
                    ...styles.toggleBtn,
                    background: ticker.visible ? 'var(--success)' : 'var(--bg-surface)',
                    color: ticker.visible ? 'white' : 'var(--text-muted)',
                  }}
                  onClick={() => onToggle(ticker.id)}
                  title={ticker.visible ? 'Hide ticker' : 'Show ticker'}
                >
                  {/* Eye icon */}
                  {ticker.visible ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>
                <button className="participant-action-btn" style={styles.removeBtn} onClick={() => onRemove(ticker.id)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlay styles
// ---------------------------------------------------------------------------

const overlayBar: React.CSSProperties = {
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 8,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
  transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease',
  pointerEvents: 'none',
  userSelect: 'none',
};

const scrollTrack: React.CSSProperties = {
  flex: 1,
  overflow: 'hidden',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
};

const scrollText: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  letterSpacing: '0.02em',
  paddingRight: 0,
};

const edgeFadeBase: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 48,
  zIndex: 2,
  pointerEvents: 'none',
};

// ---------------------------------------------------------------------------
// Panel styles
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
  form: {
    padding: '0 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    marginBottom: 12,
  },
  input: {
    width: '100%',
    padding: '7px 10px',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
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
  speedRow: {
    display: 'flex',
    gap: 4,
  },
  speedBtn: {
    flex: 1,
    fontSize: 10,
    fontWeight: 500,
    padding: '5px 0',
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  speedBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent-hover)',
    borderColor: 'var(--accent)',
    fontWeight: 600,
  },
  colorRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    padding: '2px 0',
  },
  colorBtn: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.15)',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'transform 0.1s ease',
  },
  textColorRow: {
    display: 'flex',
    gap: 4,
  },
  textColorBtn: {
    flex: 1,
    fontSize: 10,
    fontWeight: 500,
    padding: '5px 0',
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  textColorBtnActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    fontWeight: 600,
  },
  separatorRow: {
    display: 'flex',
    gap: 4,
  },
  separatorBtn: {
    flex: 1,
    fontSize: 14,
    padding: '4px 0',
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    textAlign: 'center',
  },
  separatorBtnActive: {
    background: 'var(--accent-subtle)',
    color: 'var(--accent-hover)',
    borderColor: 'var(--accent)',
  },
  addBtn: {
    fontSize: 12,
    padding: '7px 12px',
    marginTop: 2,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '0 12px',
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
    gap: 4,
    minWidth: 0,
    flex: 1,
  },
  previewStrip: {
    height: 20,
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    overflow: 'hidden',
  },
  previewText: {
    fontSize: 10,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  itemMeta: {
    display: 'flex',
    gap: 4,
  },
  itemTag: {
    fontSize: 9,
    fontWeight: 500,
    color: 'var(--text-muted)',
    background: 'var(--bg-surface)',
    padding: '1px 5px',
    borderRadius: 3,
    textTransform: 'capitalize',
  },
  itemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  toggleBtn: {
    width: 28,
    height: 24,
    borderRadius: 4,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
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
};
