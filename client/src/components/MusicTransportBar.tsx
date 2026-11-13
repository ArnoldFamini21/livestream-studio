import { useRef, useState } from 'react';
import {
  SEEK_STEPS,
  getMusicTransportView,
  seekStepToTime,
  timeToSeekStep,
} from '../audio/mixControls.ts';
import { getScrubReleaseSeek } from '../audio/scrubRelease.ts';
import '../styles/mix-controls.css';

export interface MusicTransportBarProps {
  trackName: string;
  currentTime: number;
  /** 0 while the length is unknown (loading, or a live stream). */
  duration: number;
  onSeek: (seconds: number) => void;
}

/**
 * Elapsed, total and remaining time with a scrub bar. Without a known length
 * only the elapsed time shows. While the host drags the bar, the player keeps
 * playing and the seek happens on release; with the keyboard, or a tap, every
 * change seeks at once.
 */
export function MusicTransportBar({ trackName, currentTime, duration, onSeek }: MusicTransportBarProps) {
  const [scrubStep, setScrubStep] = useState<number | null>(null);
  const pointerDown = useRef(false);
  // The step the bar was moved to while the pointer is down; null when it has not moved.
  const movedTo = useRef<number | null>(null);
  const view = getMusicTransportView({
    currentTime: scrubStep === null ? currentTime : seekStepToTime(scrubStep, duration),
    duration,
  });

  if (!view.canSeek) {
    return (
      <div className="music-times" data-testid="music-times">
        <span className="music-elapsed-only">{view.elapsed} elapsed</span>
      </div>
    );
  }

  const step = scrubStep ?? timeToSeekStep(currentTime, duration);
  const commit = (value: number) => {
    onSeek(seekStepToTime(value, duration));
    setScrubStep(null);
  };

  return (
    <div className="music-times" data-testid="music-times">
      <span className="music-elapsed">{view.elapsed}</span>
      <input
        type="range"
        className="mix-slider"
        min={0}
        max={SEEK_STEPS}
        step={1}
        value={step}
        aria-label={`Seek in ${trackName}`}
        aria-valuetext={view.valueText}
        onPointerDown={() => { pointerDown.current = true; movedTo.current = null; }}
        onPointerUp={() => {
          pointerDown.current = false;
          const seconds = getScrubReleaseSeek(movedTo.current, duration);
          movedTo.current = null;
          if (seconds === null) setScrubStep(null);
          else { onSeek(seconds); setScrubStep(null); }
        }}
        onPointerCancel={() => { pointerDown.current = false; movedTo.current = null; setScrubStep(null); }}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (pointerDown.current) { movedTo.current = value; setScrubStep(value); }
          else commit(value);
        }}
      />
      <span className="music-total">{view.total}</span>
      <span className="music-remaining" aria-label={`${view.remaining?.slice(1)} remaining`}>{view.remaining}</span>
    </div>
  );
}
