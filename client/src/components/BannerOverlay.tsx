import { useState, useEffect, useRef } from 'react';

export interface BannerData {
  id: string;
  text: string;
  style: 'breaking' | 'info' | 'alert' | 'custom';
  customColor?: string;
  isTicker: boolean;
  position: 'top' | 'bottom';
  visible: boolean;
}

interface BannerManagerProps {
  banners: BannerData[];
  onAdd: (banner: Omit<BannerData, 'id' | 'visible'>) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

const STYLE_PRESETS: Record<'breaking' | 'info' | 'alert', { label: string; color: string; bg: string }> = {
  breaking: { label: 'Breaking', color: '#fff', bg: '#dc2626' },
  info: { label: 'Info', color: '#fff', bg: '#2563eb' },
  alert: { label: 'Alert', color: '#fff', bg: '#d97706' },
};

const CUSTOM_COLOR_PRESETS = [
  '#7c3aed',
  '#059669',
  '#db2777',
  '#0891b2',
  '#ea580c',
  '#4f46e5',
  '#15803d',
  '#be185d',
];

function getStyleColor(style: BannerData['style'], customColor?: string): string {
  if (style === 'custom') return customColor || '#7c3aed';
  return STYLE_PRESETS[style].bg;
}

export function BannerManager({ banners, onAdd, onToggle, onRemove }: BannerManagerProps) {
  const [text, setText] = useState('');
  const [style, setStyle] = useState<BannerData['style']>('breaking');
  const [customColor, setCustomColor] = useState('#7c3aed');
  const [isTicker, setIsTicker] = useState(false);
  const [position, setPosition] = useState<'top' | 'bottom'>('bottom');

  const handleAdd = () => {
    if (!text.trim()) return;
    onAdd({
      text: text.trim(),
      style,
      customColor: style === 'custom' ? customColor : undefined,
      isTicker,
      position,
    });
    setText('');
  };

  return (
    <div style={styles.container}>
      <h4 style={styles.sectionTitle}>Banners</h4>

      {/* Existing banners */}
      <div style={styles.list}>
        {banners.map((banner) => (
          <div key={banner.id} style={styles.item}>
            <div style={styles.itemInfo}>
              <div style={styles.itemRow}>
                <span
                  style={{
                    ...styles.itemDot,
                    background: getStyleColor(banner.style, banner.customColor),
                  }}
                />
                <span style={styles.itemText}>{banner.text}</span>
              </div>
              <div style={styles.itemMeta}>
                <span style={styles.itemTag}>{banner.style}</span>
                {banner.isTicker && <span style={styles.itemTag}>ticker</span>}
                <span style={styles.itemTag}>{banner.position}</span>
              </div>
            </div>
            <div style={styles.itemActions}>
              <button
                style={{
                  ...styles.toggleBtn,
                  background: banner.visible ? '#16a34a' : 'var(--bg-surface)',
                  color: banner.visible ? 'white' : 'var(--text-muted)',
                }}
                onClick={() => onToggle(banner.id)}
              >
                {banner.visible ? 'ON' : 'OFF'}
              </button>
              <button style={styles.removeBtn} onClick={() => onRemove(banner.id)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Add new banner form */}
      <div style={styles.form}>
        <input
          style={styles.input}
          placeholder="Banner text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
        />

        {/* Style selector */}
        <div style={styles.styleRow}>
          {(['breaking', 'info', 'alert', 'custom'] as const).map((s) => (
            <button
              key={s}
              style={{
                ...styles.styleBtn,
                ...(style === s ? styles.styleBtnActive : {}),
                ...(style === s && s !== 'custom'
                  ? { background: STYLE_PRESETS[s].bg + '22', borderColor: STYLE_PRESETS[s].bg, color: STYLE_PRESETS[s].bg }
                  : {}),
                ...(style === s && s === 'custom'
                  ? { background: customColor + '22', borderColor: customColor, color: customColor }
                  : {}),
              }}
              onClick={() => setStyle(s)}
            >
              {s === 'custom' ? 'Custom' : STYLE_PRESETS[s].label}
            </button>
          ))}
        </div>

        {/* Custom color picker presets */}
        {style === 'custom' && (
          <div style={styles.colorRow}>
            {CUSTOM_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                style={{
                  ...styles.colorBtn,
                  background: c,
                  outline: customColor === c ? `2px solid ${c}` : 'none',
                  outlineOffset: 2,
                }}
                onClick={() => setCustomColor(c)}
                title={c}
              />
            ))}
          </div>
        )}

        {/* Options row: ticker + position */}
        <div style={styles.optionsRow}>
          <button
            style={{
              ...styles.optionBtn,
              ...(isTicker
                ? { background: 'var(--accent-subtle)', color: 'var(--accent-hover)', borderColor: 'var(--accent)' }
                : {}),
            }}
            onClick={() => setIsTicker(!isTicker)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
            Ticker
          </button>
          <button
            style={{
              ...styles.optionBtn,
              ...(position === 'top'
                ? { background: 'var(--accent-subtle)', color: 'var(--accent-hover)', borderColor: 'var(--accent)' }
                : {}),
            }}
            onClick={() => setPosition(position === 'top' ? 'bottom' : 'top')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {position === 'top' ? (
                <>
                  <line x1="4" y1="4" x2="20" y2="4" />
                  <line x1="4" y1="9" x2="20" y2="9" />
                </>
              ) : (
                <>
                  <line x1="4" y1="15" x2="20" y2="15" />
                  <line x1="4" y1="20" x2="20" y2="20" />
                </>
              )}
            </svg>
            {position === 'top' ? 'Top' : 'Bottom'}
          </button>
        </div>

        <button
          className="btn-primary"
          style={styles.addBtn}
          onClick={handleAdd}
          disabled={!text.trim()}
        >
          Add Banner
        </button>
      </div>
    </div>
  );
}

// The actual on-screen overlay component
export function BannerOverlayDisplay({ data }: { data: BannerData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [textWidth, setTextWidth] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [mounted, setMounted] = useState(data.visible);
  const [animatingIn, setAnimatingIn] = useState(data.visible);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data.isTicker && textRef.current && containerRef.current) {
      setTextWidth(textRef.current.scrollWidth);
      setContainerWidth(containerRef.current.offsetWidth);
    }
  }, [data.text, data.isTicker]);

  // Re-measure ticker widths when the container resizes
  useEffect(() => {
    if (!data.isTicker || !containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (textRef.current && containerRef.current) {
        setTextWidth(textRef.current.scrollWidth);
        setContainerWidth(containerRef.current.offsetWidth);
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [data.isTicker]);

  useEffect(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (data.visible) {
      setMounted(true);
      requestAnimationFrame(() => setAnimatingIn(true));
    } else {
      setAnimatingIn(false);
      exitTimerRef.current = setTimeout(() => setMounted(false), 400);
    }

    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, [data.visible]);

  if (!mounted) return null;

  const bannerColor = getStyleColor(data.style, data.customColor);
  const animationDuration = Math.max(8, (textWidth + containerWidth) / 80);
  const slideDirection = data.position === 'top' ? '-100%' : '100%';

  return (
    <div
      ref={containerRef}
      aria-live="polite"
      role="status"
      style={{
        ...overlayBase,
        ...(data.position === 'top' ? { top: 0 } : { bottom: 36 }),
        background: bannerColor,
        opacity: animatingIn ? 1 : 0,
        transform: animatingIn ? 'translateY(0)' : `translateY(${slideDirection})`,
        transition: 'opacity 0.3s ease-out, transform 0.3s ease-out',
      }}
    >
      {/* Inject keyframes for ticker animation */}
      <style>{`
        @keyframes bannerTicker-${data.id} {
          from { transform: translateX(${containerWidth}px); }
          to { transform: translateX(-${textWidth}px); }
        }
      `}</style>

      {data.isTicker ? (
        <div style={tickerContainer}>
          {data.style === 'breaking' && (
            <div style={tickerLabel}>BREAKING</div>
          )}
          {data.style === 'alert' && (
            <div style={tickerLabel}>ALERT</div>
          )}
          <div style={tickerTrack}>
            <div
              ref={textRef}
              style={{
                ...tickerText,
                animation: `bannerTicker-${data.id} ${animationDuration}s linear infinite`,
              }}
            >
              {data.text}
            </div>
          </div>
        </div>
      ) : (
        <div style={staticBanner}>
          {data.style === 'breaking' && (
            <span style={staticLabel}>BREAKING</span>
          )}
          {data.style === 'alert' && (
            <span style={staticLabel}>ALERT</span>
          )}
          <span style={staticText}>{data.text}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overlay styles
// ---------------------------------------------------------------------------

const overlayBase: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  zIndex: 9,
  overflow: 'hidden',
};

const tickerContainer: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: 36,
};

const tickerLabel: React.CSSProperties = {
  padding: '0 14px',
  fontSize: 12,
  fontWeight: 800,
  color: 'white',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  background: 'rgba(0,0,0,0.25)',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const tickerTrack: React.CSSProperties = {
  flex: 1,
  overflow: 'hidden',
  position: 'relative',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
};

const tickerText: React.CSSProperties = {
  whiteSpace: 'nowrap',
  fontSize: 14,
  fontWeight: 600,
  color: 'white',
  paddingLeft: 12,
  paddingRight: 12,
};

const staticBanner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 16px',
};

const staticLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  color: 'white',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  background: 'rgba(0,0,0,0.25)',
  padding: '3px 10px',
  borderRadius: 4,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const staticText: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'white',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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
    gap: 3,
    minWidth: 0,
    flex: 1,
  },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  itemDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  itemText: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemMeta: {
    display: 'flex',
    gap: 4,
    paddingLeft: 14,
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
  form: {
    padding: '0 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
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
    fontWeight: 600,
  },
  colorRow: {
    display: 'flex',
    gap: 6,
    padding: '2px 0',
  },
  colorBtn: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'var(--transition-fast)',
  },
  optionsRow: {
    display: 'flex',
    gap: 4,
  },
  optionBtn: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    fontSize: 10,
    fontWeight: 500,
    padding: '5px 0',
    borderRadius: 6,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  addBtn: {
    fontSize: 12,
    padding: '7px 12px',
  },
};
