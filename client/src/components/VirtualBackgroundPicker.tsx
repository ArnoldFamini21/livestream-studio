import { useRef } from 'react';
import { usePhotoLibrary } from '../hooks/usePhotoLibrary.ts';
import type { VirtualBackgroundConfig } from '../hooks/useVirtualBackground.ts';
import {
  DEFAULT_CHROMA_KEY_COLOR,
  DEFAULT_CHROMA_SIMILARITY,
  MAX_CHROMA_SIMILARITY,
  MIN_CHROMA_SIMILARITY,
} from '../utils/virtualBackgrounds.ts';

interface VirtualBackgroundPickerProps {
  value: VirtualBackgroundConfig;
  onChange: (next: VirtualBackgroundConfig) => void;
  // True while the segmentation pipeline is warming up (model load, first frame).
  warmingUp?: boolean;
  error?: string | null;
}

export function VirtualBackgroundPicker({ value, onChange, warmingUp, error }: VirtualBackgroundPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { photos, addPhoto, removePhoto, error: libraryError } = usePhotoLibrary();
  const keyColor = value.keyColor ?? DEFAULT_CHROMA_KEY_COLOR;
  const similarity = value.similarity ?? DEFAULT_CHROMA_SIMILARITY;

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const photo = await addPhoto(file);
    if (!photo) return;
    if (value.mode === 'green-screen') {
      onChange({ mode: 'green-screen', imageSrc: photo.dataUrl, keyColor, similarity });
    } else {
      onChange({ mode: 'image', imageSrc: photo.dataUrl });
    }
  };

  const isImageSelected = (src: string) => (
    (value.mode === 'image' || value.mode === 'green-screen') && value.imageSrc === src
  );

  const selectPhoto = (src: string) => {
    if (value.mode === 'green-screen') {
      onChange({ mode: 'green-screen', imageSrc: src, keyColor, similarity });
    } else {
      onChange({ mode: 'image', imageSrc: src });
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Virtual Background</span>
        {warmingUp && value.mode !== 'off' && <span style={styles.warming}>Loading model…</span>}
      </div>

      {(error || libraryError) && (
        <div style={styles.error}>{error || libraryError}</div>
      )}

      <div style={styles.modeRow}>
        <button
          type="button"
          style={modeButtonStyle(value.mode === 'off')}
          onClick={() => onChange({ mode: 'off' })}
        >
          <span style={styles.modeIconWrap}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              <rect x="3" y="6" width="18" height="12" rx="2" />
            </svg>
          </span>
          <span>None</span>
        </button>
        <button
          type="button"
          style={modeButtonStyle(value.mode === 'blur')}
          onClick={() => onChange({ mode: 'blur', blurPx: value.blurPx ?? 12 })}
        >
          <span style={styles.modeIconWrap}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <circle cx="12" cy="12" r="8" opacity="0.5" />
              <circle cx="12" cy="12" r="11" opacity="0.25" />
            </svg>
          </span>
          <span>Blur</span>
        </button>
        <button
          type="button"
          style={modeButtonStyle(value.mode === 'green-screen')}
          onClick={() => onChange({ mode: 'green-screen', imageSrc: value.imageSrc, keyColor, similarity })}
        >
          <span style={styles.modeIconWrap}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16v12H4z" />
              <path d="M8 10h8" opacity="0.55" />
              <path d="M8 14h5" opacity="0.55" />
            </svg>
          </span>
          <span>Green</span>
        </button>
      </div>

      {value.mode === 'blur' && (
        <div style={styles.blurControls}>
          <label style={styles.blurLabel}>Blur strength</label>
          <input
            type="range"
            min={4}
            max={28}
            step={1}
            value={value.blurPx ?? 12}
            onChange={(e) => onChange({ mode: 'blur', blurPx: Number(e.target.value) })}
            style={styles.range}
          />
        </div>
      )}

      {value.mode === 'green-screen' && (
        <div style={styles.chromaControls}>
          <label style={styles.chromaLabel} htmlFor="virtual-bg-key-color">Key color</label>
          <input
            id="virtual-bg-key-color"
            type="color"
            value={keyColor}
            onChange={(e) => onChange({ mode: 'green-screen', imageSrc: value.imageSrc, keyColor: e.target.value, similarity })}
            style={styles.colorInput}
          />
          <label style={styles.chromaLabel} htmlFor="virtual-bg-similarity">Tolerance</label>
          <input
            id="virtual-bg-similarity"
            type="range"
            min={MIN_CHROMA_SIMILARITY}
            max={MAX_CHROMA_SIMILARITY}
            step={0.01}
            value={similarity}
            onChange={(e) => onChange({ mode: 'green-screen', imageSrc: value.imageSrc, keyColor, similarity: Number(e.target.value) })}
            style={styles.range}
          />
        </div>
      )}

      <div style={styles.libraryHeader}>
        <span style={styles.libraryLabel}>Your photos</span>
        <button
          type="button"
          style={styles.uploadBtn}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Upload
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleUpload}
      />

      {photos.length === 0 ? (
        <button
          type="button"
          style={styles.emptyUpload}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>Upload a photo to use as a virtual background</span>
          <span style={styles.emptyHint}>JPG, PNG, or WebP — up to 4 MB</span>
        </button>
      ) : (
        <div style={styles.thumbGrid}>
          {photos.map((photo) => {
            const selected = isImageSelected(photo.dataUrl);
            return (
              <div key={photo.id} style={styles.photoCell}>
                <button
                  type="button"
                  style={{
                    ...styles.thumb,
                    backgroundImage: `url(${photo.dataUrl})`,
                    outline: selected ? '2px solid var(--accent)' : '2px solid transparent',
                  }}
                  onClick={() => selectPhoto(photo.dataUrl)}
                  title={photo.name}
                  aria-label={`Use ${photo.name} as virtual background`}
                />
                <button
                  type="button"
                  style={styles.removeBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removePhoto(photo.id);
                    if (selected) {
                      if (value.mode === 'green-screen') {
                        onChange({ mode: 'green-screen', keyColor, similarity });
                      } else {
                        onChange({ mode: 'off' });
                      }
                    }
                  }}
                  title="Remove from library"
                  aria-label={`Remove ${photo.name}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function modeButtonStyle(active: boolean): React.CSSProperties {
  return {
    ...styles.modeButton,
    background: active ? 'var(--accent)' : 'var(--bg-tertiary)',
    color: active ? 'white' : 'var(--text-secondary)',
    borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
  };
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  warming: {
    fontSize: 10,
    color: 'var(--text-muted)',
  },
  error: {
    fontSize: 11,
    padding: '6px 10px',
    background: 'rgba(239,68,68,0.1)',
    color: '#ef4444',
    borderRadius: 6,
    border: '1px solid rgba(239,68,68,0.2)',
  },
  modeRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 6,
  },
  modeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid',
    borderRadius: 8,
    cursor: 'pointer',
  },
  modeIconWrap: {
    display: 'inline-flex',
  },
  blurControls: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  blurLabel: {
    fontSize: 11,
    color: 'var(--text-muted)',
    minWidth: 80,
  },
  range: {
    flex: 1,
  },
  chromaControls: {
    display: 'grid',
    gridTemplateColumns: '72px 44px 72px minmax(0, 1fr)',
    alignItems: 'center',
    gap: 8,
  },
  chromaLabel: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  colorInput: {
    width: 34,
    height: 28,
    padding: 0,
    background: 'transparent',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  libraryHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  libraryLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  uploadBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 500,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    cursor: 'pointer',
  },
  emptyUpload: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '14px 12px',
    background: 'none',
    border: '1px dashed var(--border-strong)',
    borderRadius: 8,
    cursor: 'pointer',
    color: 'var(--text-muted)',
    fontSize: 11,
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 10,
    opacity: 0.7,
  },
  thumbGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 6,
  },
  photoCell: {
    position: 'relative',
  },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    cursor: 'pointer',
    padding: 0,
    overflow: 'hidden',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    outlineOffset: 2,
  },
  removeBtn: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    background: 'rgba(0,0,0,0.6)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
};
