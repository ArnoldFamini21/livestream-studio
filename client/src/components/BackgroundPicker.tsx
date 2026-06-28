import { useEffect, useRef, useState } from 'react';
import type { StageBackground } from '@studio/shared';
import { usePhotoLibrary } from '../hooks/usePhotoLibrary.ts';

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

const MAX_SESSION_VIDEO_BYTES = 50 * 1024 * 1024;

function isVideoBackgroundUrl(value: string): boolean {
  if (/^(?:https?:|blob:)/i.test(value)) return true;
  return /^data:video\/(?:mp4|webm|ogg|quicktime);base64,/i.test(value);
}

export function BackgroundPicker({ value, onChange }: BackgroundPickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const { photos, addPhoto, removePhoto, error, clearError } = usePhotoLibrary();
  const [videoUrl, setVideoUrl] = useState(value.type === 'video' && !value.value.startsWith('blob:') ? value.value : '');
  const [videoError, setVideoError] = useState<string | null>(null);

  const isSelected = (type: StageBackground['type'], val: string) =>
    value.type === type && value.value === val;

  useEffect(() => {
    if (value.type === 'video' && !value.value.startsWith('blob:')) {
      setVideoUrl(value.value);
    }
  }, [value]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const photo = await addPhoto(file);
    if (photo) onChange({ type: 'image', value: photo.dataUrl });
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setVideoError('Only video files are supported.');
      return;
    }
    if (file.size > MAX_SESSION_VIDEO_BYTES) {
      setVideoError(`Video is too large (max ${Math.round(MAX_SESSION_VIDEO_BYTES / 1024 / 1024)} MB).`);
      return;
    }

    setVideoError(null);
    onChange({ type: 'video', value: URL.createObjectURL(file) });
  };

  const applyVideoUrl = () => {
    const nextUrl = videoUrl.trim();
    if (!isVideoBackgroundUrl(nextUrl)) {
      setVideoError('Enter an HTTPS video URL or upload a video file.');
      return;
    }
    setVideoError(null);
    onChange({ type: 'video', value: nextUrl });
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

      {/* My Photos */}
      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <span style={styles.groupLabel}>My Photos</span>
          <button
            type="button"
            style={styles.uploadBtnInline}
            onClick={() => fileInputRef.current?.click()}
            title="Upload a new background"
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
          onChange={handleImageUpload}
        />
        {error && (
          <button type="button" style={styles.errorBox} onClick={clearError} title="Dismiss">
            {error}
          </button>
        )}
        {photos.length === 0 ? (
          <button
            type="button"
            style={styles.uploadArea}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <span style={styles.uploadText}>Upload Background Image</span>
            <span style={styles.uploadHint}>JPG, PNG, WebP — up to 4 MB</span>
          </button>
        ) : (
          <div style={styles.thumbGrid}>
            {photos.map((photo) => {
              const selected = isSelected('image', photo.dataUrl);
              return (
                <div key={photo.id} style={styles.photoCell}>
                  <button
                    style={{
                      ...styles.thumb,
                      backgroundImage: `url(${photo.dataUrl})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      outline: selected ? '2px solid var(--accent)' : '2px solid transparent',
                      outlineOffset: 2,
                    }}
                    onClick={() => onChange({ type: 'image', value: photo.dataUrl })}
                    title={photo.name}
                    aria-label={`Use ${photo.name} as background`}
                  />
                  <button
                    type="button"
                    style={styles.photoRemove}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removePhoto(photo.id);
                      if (selected) onChange({ type: 'none', value: '' });
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

      {/* Video Backgrounds */}
      <div style={styles.group}>
        <div style={styles.groupHeader}>
          <span style={styles.groupLabel}>Video</span>
          <button
            type="button"
            style={styles.uploadBtnInline}
            onClick={() => videoFileInputRef.current?.click()}
            title="Upload a session video background"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Upload
          </button>
        </div>
        <input
          ref={videoFileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={handleVideoUpload}
        />
        {videoError && (
          <button type="button" style={styles.errorBox} onClick={() => setVideoError(null)} title="Dismiss">
            {videoError}
          </button>
        )}
        <div style={styles.videoUrlRow}>
          <input
            type="url"
            value={videoUrl}
            onChange={(event) => setVideoUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyVideoUrl();
            }}
            placeholder="https://cdn.example.com/loop.mp4"
            style={styles.videoUrlInput}
          />
          <button type="button" style={styles.applyVideoBtn} onClick={applyVideoUrl}>
            Apply
          </button>
        </div>
        {value.type === 'video' && value.value ? (
          <button
            type="button"
            style={{
              ...styles.videoPreview,
              outline: '2px solid var(--accent)',
              outlineOffset: 2,
            }}
            onClick={() => onChange({ type: 'video', value: value.value })}
            title="Current video background"
          >
            <video src={value.value} style={styles.videoPreviewMedia} autoPlay muted loop playsInline />
            <span style={styles.videoPreviewLabel}>Video</span>
          </button>
        ) : null}
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
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    width: '100%',
  },
  thumbLabel: {
    fontSize: 9,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    pointerEvents: 'none',
  },
  photoCell: {
    position: 'relative',
  },
  photoRemove: {
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
  uploadBtnInline: {
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
  videoUrlRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 6,
  },
  videoUrlInput: {
    minWidth: 0,
    width: '100%',
    padding: '7px 9px',
    fontSize: 12,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    outline: 'none',
  },
  applyVideoBtn: {
    padding: '0 10px',
    minHeight: 32,
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  },
  videoPreview: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    overflow: 'hidden',
    background: '#050816',
    cursor: 'pointer',
    padding: 0,
  },
  videoPreviewMedia: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  videoPreviewLabel: {
    position: 'absolute',
    left: 6,
    bottom: 5,
    padding: '2px 5px',
    borderRadius: 5,
    background: 'rgba(0,0,0,0.58)',
    color: 'white',
    fontSize: 9,
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  errorBox: {
    fontSize: 11,
    padding: '6px 10px',
    background: 'rgba(239,68,68,0.1)',
    color: '#ef4444',
    borderRadius: 6,
    border: '1px solid rgba(239,68,68,0.2)',
    cursor: 'pointer',
    textAlign: 'left',
  },
};
