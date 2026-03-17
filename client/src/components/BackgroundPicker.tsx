import { useRef } from 'react';
import type { StageBackground } from '@studio/shared';

interface BackgroundPickerProps {
  value: StageBackground;
  onChange: (bg: StageBackground) => void;
}

const SOLID_COLORS = [
  '#09090b', '#18181b', '#1e293b', '#1c1917', '#1a1a2e',
  '#0f172a', '#162447', '#1b1b2f', '#2d132c', '#0c0c0c',
  '#1a1a40', '#222831', '#2c3333', '#3d0000', '#1b262c',
  '#0a1931', '#150050', '#000000', '#1e3a5f', '#2b2d42',
];

const GRADIENT_PRESETS = [
  { label: 'Purple Haze', value: 'linear-gradient(135deg, #7c3aed, #2563eb)' },
  { label: 'Sunset', value: 'linear-gradient(135deg, #f97316, #ec4899)' },
  { label: 'Ocean', value: 'linear-gradient(135deg, #0ea5e9, #6366f1)' },
  { label: 'Forest', value: 'linear-gradient(135deg, #059669, #0d9488)' },
  { label: 'Midnight', value: 'linear-gradient(135deg, #1e1b4b, #312e81)' },
  { label: 'Flame', value: 'linear-gradient(135deg, #dc2626, #f59e0b)' },
  { label: 'Aurora', value: 'linear-gradient(135deg, #06b6d4, #8b5cf6)' },
  { label: 'Coral', value: 'linear-gradient(135deg, #f43f5e, #fb923c)' },
  { label: 'Slate', value: 'linear-gradient(135deg, #334155, #1e293b)' },
  { label: 'Neon Night', value: 'linear-gradient(135deg, #7c3aed, #ec4899, #f97316)' },
  { label: 'Deep Space', value: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)' },
  { label: 'Emerald', value: 'linear-gradient(135deg, #065f46, #047857, #10b981)' },
];

export function BackgroundPicker({ value, onChange }: BackgroundPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isSelected = (type: StageBackground['type'], val: string) =>
    value.type === type && value.value === val;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      onChange({ type: 'image', value: url });
    }
    e.target.value = '';
  };

  return (
    <div style={styles.container}>
      {/* None / Default */}
      <div style={styles.group}>
        <span style={styles.groupLabel}>Default</span>
        <div style={styles.thumbRow}>
          <button
            style={{
              ...styles.thumb,
              background: '#09090b',
              outline: value.type === 'none' ? '2px solid var(--accent)' : '2px solid transparent',
              outlineOffset: 2,
            }}
            onClick={() => onChange({ type: 'none', value: '' })}
            title="Default (dark)"
          >
            <span style={styles.thumbLabel}>None</span>
          </button>
        </div>
      </div>

      {/* Solid Colors */}
      <div style={styles.group}>
        <span style={styles.groupLabel}>Solid Colors</span>
        <div style={styles.thumbGrid}>
          {SOLID_COLORS.map((color) => (
            <button
              key={color}
              style={{
                ...styles.thumb,
                background: color,
                outline: isSelected('color', color) ? '2px solid var(--accent)' : '2px solid transparent',
                outlineOffset: 2,
              }}
              onClick={() => onChange({ type: 'color', value: color })}
              title={color}
            />
          ))}
        </div>
      </div>

      {/* Gradients */}
      <div style={styles.group}>
        <span style={styles.groupLabel}>Gradients</span>
        <div style={styles.thumbGrid}>
          {GRADIENT_PRESETS.map((preset) => (
            <button
              key={preset.label}
              style={{
                ...styles.thumb,
                background: preset.value,
                outline: isSelected('gradient', preset.value) ? '2px solid var(--accent)' : '2px solid transparent',
                outlineOffset: 2,
              }}
              onClick={() => onChange({ type: 'gradient', value: preset.value })}
              title={preset.label}
            />
          ))}
        </div>
      </div>

      {/* Image Upload */}
      <div style={styles.group}>
        <span style={styles.groupLabel}>Custom Image</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImageUpload}
        />
        {value.type === 'image' ? (
          <div style={styles.imagePreviewWrap}>
            <div
              style={{
                ...styles.thumb,
                ...styles.imageThumb,
                backgroundImage: `url(${value.value})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                outline: '2px solid var(--accent)',
                outlineOffset: 2,
              }}
            />
            <div style={styles.imageActions}>
              <button
                style={styles.uploadBtn}
                onClick={() => fileInputRef.current?.click()}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Replace
              </button>
              <button
                style={styles.removeBtn}
                onClick={() => {
                  URL.revokeObjectURL(value.value);
                  onChange({ type: 'none', value: '' });
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            style={styles.uploadArea}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span style={styles.uploadText}>Upload Background Image</span>
            <span style={styles.uploadHint}>JPG, PNG, WebP</span>
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  thumbRow: {
    display: 'flex',
    gap: 6,
  },
  thumbGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: 6,
  },
  thumb: {
    aspectRatio: '16 / 9',
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    cursor: 'pointer',
    padding: 0,
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'transform 0.1s, outline-color 0.15s',
  },
  thumbLabel: {
    fontSize: 9,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    pointerEvents: 'none',
  },
  imageThumb: {
    width: '100%',
    maxWidth: 120,
  },
  imagePreviewWrap: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
  },
  imageActions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  uploadBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 500,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  removeBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 500,
    background: 'none',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  uploadArea: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '16px 12px',
    background: 'none',
    border: '1px dashed var(--border-strong)',
    borderRadius: 10,
    cursor: 'pointer',
    color: 'var(--text-muted)',
    transition: 'all var(--transition-fast)',
  },
  uploadText: {
    fontSize: 12,
    fontWeight: 500,
  },
  uploadHint: {
    fontSize: 10,
    color: 'var(--text-muted)',
    opacity: 0.7,
  },
};
