import { useEffect, useRef, useState } from 'react';
import { AudioLevelIndicator } from './AudioLevelMeter.tsx';
import { acquireAudioContext, releaseAudioContext } from '../utils/audioContext.ts';

interface VideoTileProps {
  stream: MediaStream | null;
  name: string;
  isLocal?: boolean;
  isScreenShare?: boolean;
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  brandColor?: string;
}

// Lightweight hook to detect if audio is active on a stream (for border glow).
// Returns { isSpeaking, audioLevel } so consumers can share one analyser pipeline.
function useSpeakingDetector(
  stream: MediaStream | null,
  enabled: boolean,
): { isSpeaking: boolean; audioLevel: number } {
  const [level, setLevel] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number>(0);
  const smoothedRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastRoundedRef = useRef(0);

  const effectiveStream = enabled ? stream : null;

  useEffect(() => {
    if (!effectiveStream) {
      setLevel(0);
      smoothedRef.current = 0;
      lastRoundedRef.current = 0;
      frameCountRef.current = 0;
      return;
    }

    const audioTracks = effectiveStream.getAudioTracks();
    if (audioTracks.length === 0) {
      setLevel(0);
      return;
    }

    const audioCtx = acquireAudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioCtx.createMediaStreamSource(effectiveStream);
    source.connect(analyser);

    analyserRef.current = analyser;
    sourceRef.current = source;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const EMA_ALPHA = 0.25;

    const tick = () => {
      frameCountRef.current++;
      if (frameCountRef.current % 4 !== 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = dataArray[i] / 255;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const rawLevel = Math.min(rms * 200, 100);

      smoothedRef.current =
        EMA_ALPHA * rawLevel + (1 - EMA_ALPHA) * smoothedRef.current;

      const rounded = Math.round(smoothedRef.current);
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
      releaseAudioContext();
      analyserRef.current = null;
      sourceRef.current = null;
      smoothedRef.current = 0;
      lastRoundedRef.current = 0;
      frameCountRef.current = 0;
    };
  }, [effectiveStream]);

  return { isSpeaking: enabled && level > 8, audioLevel: level };
}

// Generate a deterministic background gradient from a name string for the avatar placeholder
function nameToGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash % 360);
  const h2 = (h1 + 40) % 360;
  return `linear-gradient(135deg, hsl(${h1}, 60%, 35%), hsl(${h2}, 50%, 25%))`;
}

export function VideoTile({ stream, name, isLocal, isScreenShare, audioEnabled = true, videoEnabled = true, brandColor = '#a78bfa' }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { isSpeaking, audioLevel: speakingLevel } = useSpeakingDetector(stream, audioEnabled);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream || null;
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);

  const initials = (name || '?')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

  // Dynamic border glow based on speaking + brand color
  const tileStyle: React.CSSProperties = {
    ...tileStyles.tile,
    boxShadow: isSpeaking
      ? `0 0 0 2px ${brandColor}, 0 0 ${Math.min(speakingLevel / 4, 16)}px ${brandColor}88`
      : 'none',
    borderColor: isSpeaking ? brandColor : 'var(--border)',
  };

  return (
    <div style={tileStyle} role="group" aria-label={`Video feed: ${name}${isLocal ? ' (you)' : ''}${!audioEnabled ? ', muted' : ''}${!videoEnabled ? ', camera off' : ''}`}>
      {/* Always render a hidden video/audio element for remote streams so audio plays even when camera is off */}
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          style={videoEnabled ? {
            ...tileStyles.video,
            objectFit: isScreenShare ? 'contain' : 'cover',
            transform: isLocal && !isScreenShare ? 'scaleX(-1)' : 'none',
          } : tileStyles.hiddenVideo}
        />
      )}
      {(!stream || !videoEnabled) && (
        <div style={{ ...tileStyles.placeholder, background: nameToGradient(name) }}>
          <div style={tileStyles.avatarOuter}>
            <div style={tileStyles.avatarInner}>
              <span style={tileStyles.avatarInitials}>{initials}</span>
            </div>
          </div>
          <span style={tileStyles.offlineLabel}>Camera Off</span>
        </div>
      )}

      {/* Bottom gradient overlay */}
      <div style={tileStyles.gradient} />

      {/* Frosted glass pill name badge */}
      <div style={tileStyles.nameBar}>
        <div style={tileStyles.namePill}>
          {!audioEnabled ? (
            <div style={tileStyles.muteIcon}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
              </svg>
            </div>
          ) : (
            <AudioLevelIndicator level={speakingLevel} />
          )}
          <span style={tileStyles.nameText}>
            {name}
            {isLocal && <span style={tileStyles.youTag}> (You)</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

const tileStyles: Record<string, React.CSSProperties> = {
  tile: {
    position: 'relative',
    background: 'var(--bg-tertiary)',
    borderRadius: 16,
    overflow: 'hidden',
    width: '100%',
    height: '100%',
    border: '2px solid var(--border)',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  hiddenVideo: {
    position: 'absolute',
    width: 0,
    height: 0,
    opacity: 0,
    pointerEvents: 'none',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  avatarOuter: {
    width: 72,
    height: 72,
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.08)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(8px)',
    border: '2px solid rgba(255, 255, 255, 0.12)',
  },
  avatarInner: {
    width: 60,
    height: 60,
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.06)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 22,
    fontWeight: 700,
    color: 'rgba(255, 255, 255, 0.85)',
    letterSpacing: '0.04em',
    userSelect: 'none',
  },
  offlineLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: 'rgba(255, 255, 255, 0.35)',
    letterSpacing: '0.02em',
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 72,
    background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.65))',
    pointerEvents: 'none',
  },
  nameBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '0 10px 10px',
    display: 'flex',
    alignItems: 'center',
  },
  namePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 12px',
    borderRadius: 20,
    background: 'rgba(0, 0, 0, 0.4)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    maxWidth: '70%',
    overflow: 'hidden',
  },
  muteIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  nameText: {
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(255, 255, 255, 0.92)',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  youTag: {
    color: 'rgba(255, 255, 255, 0.55)',
    fontWeight: 400,
  },
};
