import type { CSSProperties } from 'react';
import type { ClipAspectPreset } from '../utils/recordingClips.ts';

interface ClipSmartOptionsProps {
  aspect: ClipAspectPreset;
  smartFraming: boolean;
  onSmartFramingChange: (value: boolean) => void;
  burnCaptions: boolean;
  onBurnCaptionsChange: (value: boolean) => void;
  /** Word timings exist for this recording (in-browser or cloud transcript). */
  captionsAvailable: boolean;
  /** Why captions are off for this file, or a caveat about them (e.g. whose words they are). */
  captionsNote?: string | null;
  /** Several participants' own audio tracks exist, so framing can follow who talks. */
  speakerTracksAvailable: boolean;
  disabled: boolean;
  notice?: string | null;
}

/** Smart framing and burned-in captions for the in-browser clip export. */
export function ClipSmartOptions({
  aspect,
  smartFraming,
  onSmartFramingChange,
  burnCaptions,
  onBurnCaptionsChange,
  captionsAvailable,
  captionsNote = null,
  speakerTracksAvailable,
  disabled,
  notice,
}: ClipSmartOptionsProps) {
  const cropping = aspect !== 'source';
  return (
    <div style={styles.box}>
      {cropping && (
        <label style={styles.option} title="Detect faces about twice a second and glide the crop to follow them">
          <input
            type="checkbox"
            checked={smartFraming}
            disabled={disabled}
            onChange={(event) => onSmartFramingChange(event.target.checked)}
          />
          <span>
            Smart framing (follow faces{speakerTracksAvailable ? ' and the active speaker' : ''})
          </span>
        </label>
      )}
      <label
        style={{ ...styles.option, ...(captionsAvailable ? {} : styles.optionDisabled) }}
        title={captionsAvailable ? 'Draw word-synced captions in the brand font and colour' : captionsNote || 'Generate a transcript first'}
      >
        <input
          type="checkbox"
          checked={burnCaptions && captionsAvailable}
          disabled={disabled || !captionsAvailable}
          onChange={(event) => onBurnCaptionsChange(event.target.checked)}
        />
        <span>Burn in captions{captionsAvailable || captionsNote ? '' : ' (generate a transcript first)'}</span>
      </label>
      {captionsNote && <span style={styles.hint}>{captionsNote}</span>}
      <span style={styles.hint}>
        Applies to Export clip in this browser. Smart framing downloads a small face model once.
      </span>
      {notice && <span style={styles.notice}>{notice}</span>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: { display: 'grid', gap: 4 },
  option: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' },
  optionDisabled: { opacity: 0.55, cursor: 'not-allowed' },
  hint: { fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 },
  notice: { fontSize: 10, color: '#fde68a', lineHeight: 1.35 },
};
