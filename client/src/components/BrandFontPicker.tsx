import { useRef, useState } from 'react';
import type { BrandFont } from '@studio/shared';
import {
  BRAND_FONT_FILE_ACCEPT,
  BRAND_FONT_PRESETS,
  getBrandFontLabel,
  isSameBrandFont,
} from '../utils/brandFonts.ts';
import { saveUploadedBrandFont } from '../utils/brandFontStore.ts';
import type { BrandFontState } from '../hooks/useBrandFont.ts';

interface BrandFontPickerProps {
  brandFont: BrandFont | null;
  status: BrandFontState;
  onChange: (font: BrandFont | null) => void;
}

/**
 * Brand typeface for banners, tickers, lower thirds and widget text: one of the
 * bundled open fonts, or a font file kept in this browser.
 */
export function BrandFontPicker({ brandFont, status, onChange }: BrandFontPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      onChange(await saveUploadedBrandFont(file));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'That font could not be added.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const message = uploadError
    || status.message
    || (status.status === 'loading' ? 'Loading the font…' : null);

  return (
    <div className="studio-brand-field">
      <div className="studio-brand-field-heading">
        <h3>Brand font</h3>
        <span className="studio-brand-summary-value">{getBrandFontLabel(brandFont)}</span>
      </div>
      <div style={styles.grid} role="radiogroup" aria-label="Brand font">
        {BRAND_FONT_PRESETS.map((preset) => {
          const font: BrandFont | null = preset.id === 'inter' ? null : { source: 'preset', presetId: preset.id };
          const active = isSameBrandFont(font, brandFont);
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={active}
              style={{ ...styles.option, ...(active ? styles.optionActive : {}) }}
              onClick={() => onChange(font)}
              title={`Use ${preset.label} for banners, tickers, lower thirds and widgets`}
            >
              {preset.label}
            </button>
          );
        })}
        {brandFont?.source === 'upload' && (
          <button type="button" role="radio" aria-checked style={{ ...styles.option, ...styles.optionActive }}>
            {brandFont.family}
          </button>
        )}
      </div>
      <div style={styles.uploadRow}>
        <button type="button" className="btn-secondary" style={styles.uploadBtn} disabled={uploading} onClick={() => inputRef.current?.click()}>
          {uploading ? 'Adding…' : 'Upload font file'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={BRAND_FONT_FILE_ACCEPT}
          style={{ display: 'none' }}
          onChange={(event) => void onFile(event.currentTarget.files?.[0])}
        />
      </div>
      <p className="studio-brand-hint">
        Used for banners, tickers, lower thirds and widget text on the stage and in the stream. Uploaded fonts stay in this browser.
      </p>
      {message && <p className="studio-brand-hint" role={uploadError || status.status === 'error' || status.status === 'missing' ? 'alert' : 'status'} style={uploadError || status.status === 'error' || status.status === 'missing' ? styles.error : undefined}>{message}</p>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 },
  option: {
    minHeight: 30,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0 8px',
  },
  optionActive: { borderColor: 'var(--accent)', background: 'var(--accent-subtle)', color: 'var(--accent-hover)' },
  uploadRow: { display: 'flex', gap: 6, marginTop: 6 },
  uploadBtn: { fontSize: 11, padding: '6px 10px' },
  error: { color: '#fca5a5' },
};
