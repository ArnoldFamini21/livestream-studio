import { useEffect, useRef, useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Hook: useAudioLevel
// Shared logic for reading RMS audio level from a MediaStream.
// Returns a smoothed level value between 0 and 100.
// ---------------------------------------------------------------------------

function useAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number>(0);
  const smoothedRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastRoundedRef = useRef(0);

  useEffect(() => {
    if (!stream) {
      setLevel(0);
      smoothedRef.current = 0;
      lastRoundedRef.current = 0;
      frameCountRef.current = 0;
      return;
    }

    // Ensure there is at least one audio track
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setLevel(0);
      return;
    }

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;
    sourceRef.current = source;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const EMA_ALPHA = 0.3; // Exponential moving average smoothing factor

    const tick = () => {
      // Frame skip: only sample every 3rd frame
      frameCountRef.current++;
      if (frameCountRef.current % 3 !== 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      // Compute RMS from frequency data
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = dataArray[i] / 255;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const rawLevel = Math.min(rms * 200, 100); // Scale to 0-100

      // Exponential moving average for smooth transitions
      smoothedRef.current =
        EMA_ALPHA * rawLevel + (1 - EMA_ALPHA) * smoothedRef.current;

      // Only trigger re-render when rounded value actually changes
      const rounded = Math.round(smoothedRef.current * 100) / 100;
      if (rounded !== lastRoundedRef.current) {
        lastRoundedRef.current = rounded;
        setLevel(rounded);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      audioCtx.close().catch(() => {});
      audioCtxRef.current = null;
      analyserRef.current = null;
      sourceRef.current = null;
      smoothedRef.current = 0;
      lastRoundedRef.current = 0;
      frameCountRef.current = 0;
    };
  }, [stream]);

  return level;
}

// ---------------------------------------------------------------------------
// Helper: level to color
// ---------------------------------------------------------------------------

function levelColor(level: number): string {
  if (level >= 85) return '#ef4444'; // Red - clipping
  if (level >= 60) return '#f59e0b'; // Yellow/amber - high
  return '#22c55e'; // Green - normal
}

// ---------------------------------------------------------------------------
// AudioLevelMeter
// ---------------------------------------------------------------------------

interface AudioLevelMeterProps {
  stream: MediaStream | null;
  size?: 'small' | 'medium';
  orientation?: 'horizontal' | 'vertical';
}

export function AudioLevelMeter({
  stream,
  size = 'small',
  orientation = 'horizontal',
}: AudioLevelMeterProps) {
  const level = useAudioLevel(stream);
  const isDisabled = !stream;
  const color = isDisabled ? 'var(--text-muted)' : levelColor(level);

  const isHorizontal = orientation === 'horizontal';
  const isSmall = size === 'small';

  const trackThickness = isSmall ? 3 : 8;
  const trackLength = '100%';
  const borderRadius = isSmall ? 1.5 : 4;

  // Level markings for medium size
  const markings = size === 'medium' ? [25, 50, 75] : [];

  const containerStyle: React.CSSProperties = isHorizontal
    ? {
        position: 'relative',
        width: trackLength,
        height: isSmall ? trackThickness : trackThickness + 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }
    : {
        position: 'relative',
        width: isSmall ? trackThickness : trackThickness + 24,
        height: trackLength,
        display: 'flex',
        flexDirection: 'row',
        gap: 2,
      };

  const trackStyle: React.CSSProperties = isHorizontal
    ? {
        width: '100%',
        height: trackThickness,
        background: isDisabled
          ? 'var(--bg-tertiary)'
          : 'rgba(255, 255, 255, 0.06)',
        borderRadius,
        overflow: 'hidden',
        position: 'relative',
      }
    : {
        width: trackThickness,
        height: '100%',
        background: isDisabled
          ? 'var(--bg-tertiary)'
          : 'rgba(255, 255, 255, 0.06)',
        borderRadius,
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      };

  const fillStyle: React.CSSProperties = isHorizontal
    ? {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: `${isDisabled ? 0 : level}%`,
        background: isDisabled
          ? 'var(--text-muted)'
          : `linear-gradient(90deg, #22c55e, ${color})`,
        borderRadius,
        transition: 'width 0.06s linear',
        boxShadow:
          !isDisabled && level > 10
            ? `0 0 ${Math.min(level / 8, 6)}px ${color}88`
            : 'none',
      }
    : {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: `${isDisabled ? 0 : level}%`,
        background: isDisabled
          ? 'var(--text-muted)'
          : `linear-gradient(0deg, #22c55e, ${color})`,
        borderRadius,
        transition: 'height 0.06s linear',
        boxShadow:
          !isDisabled && level > 10
            ? `0 0 ${Math.min(level / 8, 6)}px ${color}88`
            : 'none',
      };

  return (
    <div style={containerStyle}>
      <div style={trackStyle}>
        <div style={fillStyle} />
        {/* Segmented tick marks for visual rhythm */}
        {!isSmall &&
          markings.map((mark) =>
            isHorizontal ? (
              <div
                key={mark}
                style={{
                  position: 'absolute',
                  left: `${mark}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: 'rgba(255, 255, 255, 0.08)',
                  pointerEvents: 'none',
                }}
              />
            ) : (
              <div
                key={mark}
                style={{
                  position: 'absolute',
                  bottom: `${mark}%`,
                  left: 0,
                  right: 0,
                  height: 1,
                  background: 'rgba(255, 255, 255, 0.08)',
                  pointerEvents: 'none',
                }}
              />
            ),
          )}
      </div>
      {/* Level labels for medium size */}
      {!isSmall && (
        <div
          style={
            isHorizontal ? meterStyles.labelsRow : meterStyles.labelsColumn
          }
        >
          {isHorizontal ? (
            <>
              <span style={meterStyles.label}>0</span>
              <span style={meterStyles.label}>50</span>
              <span style={meterStyles.label}>100</span>
            </>
          ) : (
            <>
              <span style={meterStyles.label}>100</span>
              <span style={meterStyles.label}>50</span>
              <span style={meterStyles.label}>0</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const meterStyles: Record<string, React.CSSProperties> = {
  labelsRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0 1px',
  },
  labelsColumn: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '1px 0',
  },
  label: {
    fontSize: 8,
    fontWeight: 500,
    color: 'var(--text-muted)',
    letterSpacing: '0.02em',
    lineHeight: 1,
    userSelect: 'none',
  },
};

// ---------------------------------------------------------------------------
// AudioLevelIndicator
// A simple colored dot that pulses when audio is detected.
// ---------------------------------------------------------------------------

interface AudioLevelIndicatorProps {
  stream: MediaStream | null;
}

export function AudioLevelIndicator({ stream }: AudioLevelIndicatorProps) {
  const level = useAudioLevel(stream);
  const isActive = level > 3;
  const isDisabled = !stream;

  const dotSize = 8;
  const glowSize = isActive ? Math.min(level / 6, 8) : 0;
  const color = isDisabled ? 'var(--text-muted)' : levelColor(level);
  const scale = isActive ? 1 + level / 400 : 1;

  const dotStyle: React.CSSProperties = {
    width: dotSize,
    height: dotSize,
    borderRadius: '50%',
    background: isDisabled ? 'var(--bg-tertiary)' : color,
    border: isDisabled ? '1px solid var(--border)' : 'none',
    transition: 'all 0.1s ease-out',
    transform: `scale(${scale})`,
    boxShadow: isActive ? `0 0 ${glowSize}px ${color}aa` : 'none',
    flexShrink: 0,
  };

  return <div style={dotStyle} />;
}
