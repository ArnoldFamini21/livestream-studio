import type { ScreenVolumeView } from '../audio/mixControls.ts';
import '../styles/mix-controls.css';

export interface ScreenShareVolumeProps {
  view: ScreenVolumeView;
  /** Current volume as a whole percent, 0..100. */
  percent: number;
  onChange: (percent: number) => void;
  /** Who runs the program mix, for a co-host whose own setting does not apply. */
  programRunnerName?: string;
}

/**
 * The shared screen's volume in the program mix. It is shown only while a
 * screen share is on the program; the volume changes what viewers and the
 * recording hear, and the host's own monitor of remote shares.
 */
export function ScreenShareVolume({ view, percent, onChange, programRunnerName }: ScreenShareVolumeProps) {
  if (view.kind === 'hidden') return null;
  if (view.kind === 'set-by-program-runner') {
    return (
      <section className="mix-screen" aria-label="Screen share volume">
        <p>
          Screen share volume is set by {programRunnerName || 'the person running the program'}.
        </p>
      </section>
    );
  }
  if (view.kind === 'no-sound') {
    return (
      <section className="mix-screen" aria-label="Screen share volume">
        <p>
          The shared screen has no sound, so there is no volume to set. To play sound, share a
          browser tab and tick the option to share tab audio.
        </p>
      </section>
    );
  }
  return (
    <section className="mix-screen" aria-label="Screen share volume">
      <label>
        <span className="mix-screen-title">
          Screen share volume <output aria-hidden="true">{percent}%</output>
        </span>
        <input
          type="range"
          className="mix-slider"
          min={0}
          max={100}
          step={1}
          value={percent}
          aria-label="Screen share volume"
          aria-valuetext={`${percent} percent`}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
      <small>What viewers and the recording hear. Starts at 100%.</small>
    </section>
  );
}
