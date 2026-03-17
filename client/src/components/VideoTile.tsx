import { useEffect, useRef } from 'react';
import { AudioLevelIndicator } from './AudioLevelMeter.tsx';

interface VideoTileProps {
  stream: MediaStream | null;
  name: string;
  isLocal?: boolean;
  audioEnabled?: boolean;
  videoEnabled?: boolean;
}

export function VideoTile({ stream, name, isLocal, audioEnabled = true, videoEnabled = true }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const initials = (name || '?')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

  return (
    <div style={styles.tile} role="group" aria-label={`Video feed: ${name}${isLocal ? ' (you)' : ''}${!audioEnabled ? ', muted' : ''}${!videoEnabled ? ', camera off' : ''}`}>
      {stream && videoEnabled ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          style={{
            ...styles.video,
            transform: isLocal ? 'scaleX(-1)' : 'none',
          }}
        />
      ) : (
        <div style={styles.placeholder}>
          <div style={styles.avatarRing}>
            <div style={styles.avatar}>{initials}</div>
          </div>
        </div>
      )}

      {/* Bottom gradient overlay */}
      <div style={styles.gradient} />

      {/* Name badge */}
      <div style={styles.nameBar}>
        <div style={styles.nameBadge}>
          {!audioEnabled ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
            </svg>
          ) : (
            <AudioLevelIndicator stream={stream} />
          )}
          <span style={styles.name}>
            {name}
            {isLocal && <span style={styles.youTag}> (You)</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tile: {
    position: 'relative',
    background: 'var(--bg-tertiary)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    aspectRatio: '16 / 9',
    border: '1px solid var(--border)',
    transition: 'border-color var(--transition)',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  placeholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary))',
  },
  avatarRing: {
    padding: 3,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, var(--accent), #a78bfa)',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: '50%',
    background: 'var(--bg-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '0.02em',
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 60,
    background: 'linear-gradient(transparent, rgba(0, 0, 0, 0.6))',
    pointerEvents: 'none',
  },
  nameBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: '0 10px 8px',
    display: 'flex',
    alignItems: 'center',
  },
  nameBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 8px',
    borderRadius: 6,
    background: 'rgba(0, 0, 0, 0.45)',
    backdropFilter: 'blur(8px)',
  },
  name: {
    fontSize: 12,
    fontWeight: 500,
    color: 'rgba(255, 255, 255, 0.9)',
    letterSpacing: '0.01em',
  },
  youTag: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: 400,
  },
};
