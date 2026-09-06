import { useState } from 'react';

export type WidgetOverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

export interface WidgetOverlayData {
  id: string;
  name: string;
  url: string;
  position: WidgetOverlayPosition;
  widthPercent: number;
  heightPercent: number;
  opacity: number;
  visible: boolean;
}

interface WidgetOverlayManagerProps {
  initialValue?: WidgetOverlayData;
  editorOnly?: boolean;
  submitLabel?: string;
  widgets: WidgetOverlayData[];
  onAdd: (widget: Omit<WidgetOverlayData, 'id' | 'visible'>) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}

const MAX_WIDGETS = 5;
const MAX_WIDGET_NAME_LENGTH = 64;
const MAX_WIDGET_URL_LENGTH = 2048;
const WIDGET_SIZE_PRESETS = [
  { label: 'Compact', widthPercent: 28, heightPercent: 18 },
  { label: 'Panel', widthPercent: 42, heightPercent: 26 },
  { label: 'Wide', widthPercent: 58, heightPercent: 22 },
  { label: 'Large', widthPercent: 78, heightPercent: 58 },
] as const;

const WIDGET_POSITIONS: WidgetOverlayPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeWidgetOverlayUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WIDGET_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeWidgetOverlayPosition(value: unknown): WidgetOverlayPosition {
  return typeof value === 'string' && WIDGET_POSITIONS.includes(value as WidgetOverlayPosition)
    ? value as WidgetOverlayPosition
    : 'center';
}

export function normalizeWidgetOverlayPercent(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(clamp(value, min, max))
    : fallback;
}

export function normalizeWidgetOverlayOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, 0.2, 1)
    : 1;
}

export function getWidgetOverlayDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return 'Widget';
  }
}

export function getWidgetOverlayPositionStyle(widget: Pick<WidgetOverlayData, 'position' | 'widthPercent' | 'heightPercent'>): React.CSSProperties {
  const width = `${normalizeWidgetOverlayPercent(widget.widthPercent, 42, 20, 95)}%`;
  const height = `${normalizeWidgetOverlayPercent(widget.heightPercent, 26, 12, 85)}%`;
  const base: React.CSSProperties = { width, height };

  switch (normalizeWidgetOverlayPosition(widget.position)) {
    case 'top-left':
      return { ...base, top: 24, left: 24 };
    case 'top-right':
      return { ...base, top: 24, right: 24 };
    case 'bottom-left':
      return { ...base, bottom: 52, left: 24 };
    case 'bottom-right':
      return { ...base, bottom: 52, right: 24 };
    case 'center':
    default:
      return { ...base, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
}

export function WidgetOverlayManager({ initialValue, editorOnly = false, submitLabel, widgets, onAdd, onToggle, onRemove }: WidgetOverlayManagerProps) {
  const [name, setName] = useState(initialValue?.name || '');
  const [url, setUrl] = useState(initialValue?.url || '');
  const [position, setPosition] = useState<WidgetOverlayPosition>(initialValue?.position || 'center');
  const [sizePreset, setSizePreset] = useState<{ label: string; widthPercent: number; heightPercent: number }>(initialValue ? { label: WIDGET_SIZE_PRESETS.find(preset => preset.widthPercent === initialValue.widthPercent && preset.heightPercent === initialValue.heightPercent)?.label || 'Custom', widthPercent: initialValue.widthPercent, heightPercent: initialValue.heightPercent } : WIDGET_SIZE_PRESETS[1]);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    if ((!initialValue && widgets.length >= MAX_WIDGETS)) {
      setError(`Maximum of ${MAX_WIDGETS} widgets reached.`);
      return;
    }
    const normalizedUrl = normalizeWidgetOverlayUrl(url);
    if (!normalizedUrl) {
      setError('Enter a valid HTTP or HTTPS widget URL.');
      return;
    }
    onAdd({
      name: name.trim().slice(0, MAX_WIDGET_NAME_LENGTH) || getWidgetOverlayDisplayUrl(normalizedUrl),
      url: normalizedUrl,
      position,
      widthPercent: sizePreset.widthPercent,
      heightPercent: sizePreset.heightPercent,
      opacity: initialValue?.opacity ?? 1,
    });
    setName('');
    setUrl('');
    setError(null);
  };

  return (
    <div className={editorOnly ? "overlay-editor-form" : undefined} style={styles.container}>
      <h4 className="overlay-editor-title" style={styles.sectionTitle}>Widget Overlays</h4>

      {widgets.length > 0 && (
        <div className={editorOnly ? "overlay-editor-existing" : undefined} style={styles.list}>
          {widgets.map((widget) => (
            <div key={widget.id} className="participant-item" style={styles.item}>
              <div style={styles.itemInfo}>
                <div style={styles.itemRow}>
                  <span style={styles.itemDot} />
                  <span style={styles.itemText}>{widget.name}</span>
                </div>
                <div style={styles.itemMeta}>
                  <span style={styles.itemTag}>{widget.position.replace('-', ' ')}</span>
                  <span style={styles.itemTag}>{getWidgetOverlayDisplayUrl(widget.url)}</span>
                </div>
              </div>
              <div style={styles.itemActions}>
                <button
                  style={{
                    ...styles.toggleBtn,
                    background: widget.visible ? 'var(--success)' : 'var(--bg-surface)',
                    color: widget.visible ? 'white' : 'var(--text-muted)',
                  }}
                  onClick={() => onToggle(widget.id)}
                >
                  {widget.visible ? 'ON' : 'OFF'}
                </button>
                <button className="participant-action-btn" style={styles.removeBtn} onClick={() => onRemove(widget.id)}>
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

      <div style={styles.form}>
        {error && (
          <button type="button" style={styles.errorBox} onClick={() => setError(null)}>
            {error}
          </button>
        )}
        <input
          style={styles.input}
          placeholder="Widget name" aria-label="Widget name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value.slice(0, MAX_WIDGET_NAME_LENGTH))}
        />
        <input
          style={styles.input}
          placeholder="https://widget.example.com/embed" aria-label="Widget URL"
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleAdd();
          }}
        />

        <details className="overlay-editor-options" open={editorOnly ? undefined : true}>
          <summary>Appearance & options</summary>
        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Position</span>
          <div style={styles.positionGrid}>
            {WIDGET_POSITIONS.map((item) => (
              <button
                key={item}
                type="button"
                style={{
                  ...styles.positionBtn,
                  ...(position === item ? styles.positionBtnActive : {}),
                }}
                onClick={() => setPosition(item)}
                title={item.replace('-', ' ')}
              >
                <span style={{ ...styles.positionDot, ...getPositionDotStyle(item) }} />
              </button>
            ))}
          </div>
        </div>

        <div style={styles.fieldGroup}>
          <span style={styles.fieldLabel}>Size</span>
          <div style={styles.sizeRow}>
            {WIDGET_SIZE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                style={{ ...styles.sizeBtn, ...(sizePreset.label === preset.label ? styles.sizeBtnActive : {}) }}
                onClick={() => setSizePreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        </details>
        <button
          className="btn-primary"
          style={styles.addBtn}
          onClick={handleAdd}
          disabled={!url.trim() || (!initialValue && widgets.length >= MAX_WIDGETS)}
        >
          {(!initialValue && widgets.length >= MAX_WIDGETS) ? `Max ${MAX_WIDGETS} Widgets` : submitLabel || 'Add Widget'}
        </button>
      </div>
    </div>
  );
}

export function WidgetOverlayDisplay({ data }: { data: WidgetOverlayData }) {
  if (!data.visible) return null;

  return (
    <div
      aria-label={`Widget overlay ${data.name}`}
      style={{
        ...overlayBase,
        ...getWidgetOverlayPositionStyle(data),
        opacity: normalizeWidgetOverlayOpacity(data.opacity),
      }}
    >
      <div style={styles.widgetFrameHeader}>
        <span style={styles.widgetFrameTitle}>{data.name}</span>
        <span style={styles.widgetFrameHost}>{getWidgetOverlayDisplayUrl(data.url)}</span>
      </div>
      <iframe
        src={data.url}
        title={data.name}
        style={styles.widgetIframe}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        allow="autoplay; clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

function getPositionDotStyle(position: WidgetOverlayPosition): React.CSSProperties {
  switch (position) {
    case 'top-left': return { top: 4, left: 4 };
    case 'top-right': return { top: 4, right: 4 };
    case 'bottom-left': return { bottom: 4, left: 4 };
    case 'bottom-right': return { bottom: 4, right: 4 };
    case 'center':
    default:
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
}

const overlayBase: React.CSSProperties = {
  position: 'absolute',
  zIndex: 7,
  borderRadius: 10,
  overflow: 'hidden',
  background: 'rgba(2, 6, 23, 0.76)',
  border: '1px solid rgba(255,255,255,0.18)',
  boxShadow: '0 18px 46px rgba(0,0,0,0.32)',
  pointerEvents: 'none',
};

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '12px 0' },
  sectionTitle: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 12px', marginBottom: 10 },
  list: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 12px', marginBottom: 12 },
  item: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px' },
  itemInfo: { minWidth: 0, flex: 1 },
  itemRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 4 },
  itemDot: { width: 8, height: 8, borderRadius: 3, background: 'var(--accent)', flexShrink: 0 },
  itemText: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemMeta: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  itemTag: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)', padding: '2px 5px', borderRadius: 4 },
  itemActions: { display: 'flex', alignItems: 'center', gap: 5 },
  toggleBtn: { minWidth: 34, height: 24, borderRadius: 6, border: 'none', fontSize: 9, fontWeight: 800, cursor: 'pointer' },
  removeBtn: { width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  form: { padding: '0 12px', display: 'flex', flexDirection: 'column', gap: 8 },
  input: { width: '100%', minWidth: 0, padding: '8px 10px', fontSize: 12, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldLabel: { fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  positionGrid: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5 },
  positionBtn: { height: 34, position: 'relative', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-tertiary)', cursor: 'pointer' },
  positionBtnActive: { borderColor: 'var(--accent)', boxShadow: 'inset 0 0 0 1px var(--accent)' },
  positionDot: { position: 'absolute', width: 8, height: 8, borderRadius: 3, background: 'var(--accent)' },
  sizeRow: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 5 },
  sizeBtn: { minHeight: 28, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 800, cursor: 'pointer' },
  sizeBtnActive: { borderColor: 'var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  addBtn: { width: '100%', marginTop: 2 },
  errorBox: { fontSize: 11, padding: '6px 10px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderRadius: 6, border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer', textAlign: 'left' },
  widgetFrameHeader: { position: 'absolute', top: 0, left: 0, right: 0, minHeight: 28, padding: '5px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'rgba(2, 6, 23, 0.72)', color: 'white', zIndex: 2 },
  widgetFrameTitle: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 800 },
  widgetFrameHost: { maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.7)' },
  widgetIframe: { width: '100%', height: '100%', border: 'none', background: 'transparent' },
};
