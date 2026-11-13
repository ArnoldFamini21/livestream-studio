import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getProgramReturnLabel } from '../utils/programReturn.ts';
import { TEST_BANNER_LABEL } from '../utils/testStreamMachine.ts';

type SinkIdElement = HTMLMediaElement & { setSinkId?: (sinkId: string) => Promise<void> };

interface ProgramReturnVideoProps {
  stream: MediaStream | null;
  muted: boolean;
  audioOutputDeviceId?: string;
  style?: CSSProperties;
  label: string;
}

/** The program return in a <video>; audio plays only when the viewer turns it on. */
export function ProgramReturnVideo({ stream, muted, audioOutputDeviceId, style, label }: ProgramReturnVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) void video.play().catch(() => { /* Autoplay waits for the viewer's first click. */ });
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    if (!muted && stream) void video.play().catch(() => {});
  }, [muted, stream]);

  useEffect(() => {
    const video = videoRef.current as SinkIdElement | null;
    if (!video || !audioOutputDeviceId || typeof video.setSinkId !== 'function') return;
    void video.setSinkId(audioOutputDeviceId).catch(() => { /* The default speaker is used. */ });
  }, [audioOutputDeviceId]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      aria-label={label}
      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000', display: 'block', ...style }}
    />
  );
}

interface ProgramReturnMonitorProps {
  stream: MediaStream | null;
  live: boolean;
  /** A private test is running: show "TEST - not public", never Live. */
  test?: boolean;
  audioOutputDeviceId?: string;
  brandColor?: string;
}

/**
 * The backstage guest's "Live program" view: what the audience sees (and,
 * with the sound turned on, hears), so they can time their entrance. Shown
 * before the show goes live too, labelled Preview.
 */
export function ProgramReturnMonitor({ stream, live, test = false, audioOutputDeviceId, brandColor = '#a78bfa' }: ProgramReturnMonitorProps) {
  const [soundOn, setSoundOn] = useState(false);
  const label = test && !live ? TEST_BANNER_LABEL : getProgramReturnLabel(live);

  return (
    <section style={styles.monitor} aria-label="Live program" data-testid="program-return-monitor">
      <div style={styles.banner} role="status">
        <span style={{ ...styles.bannerDot, background: brandColor }} />
        You&apos;re backstage — the host will bring you on
      </div>
      <div style={styles.header}>
        <span style={styles.title}>Live program</span>
        <span style={{ ...styles.badge, ...(live ? styles.badgeLive : styles.badgePreview) }}>{label}</span>
        <button
          type="button"
          className="btn-ghost"
          style={styles.soundButton}
          onClick={() => setSoundOn((current) => !current)}
          aria-pressed={soundOn}
          disabled={!stream}
          title={soundOn ? 'Mute the program sound' : 'Hear the program (wear headphones so the host does not hear it back)'}
        >
          {soundOn ? 'Mute program sound' : 'Hear program'}
        </button>
      </div>
      <div style={styles.screen}>
        {stream ? (
          <ProgramReturnVideo stream={stream} muted={!soundOn} audioOutputDeviceId={audioOutputDeviceId} label={`Live program (${label})`} />
        ) : (
          <div style={styles.waiting}>Connecting to the program…</div>
        )}
      </div>
      <p style={styles.hint}>
        You are off air. The audience cannot see or hear you until the host brings you on stage.
      </p>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  monitor: {
    width: 'min(960px, 100%)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    background: 'rgba(15, 23, 42, 0.72)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxSizing: 'border-box',
  },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  bannerDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  badge: {
    fontSize: 11,
    fontWeight: 800,
    padding: '2px 8px',
    borderRadius: 999,
    letterSpacing: 0.5,
  },
  badgeLive: {
    background: 'var(--danger, #ef4444)',
    color: '#fff',
  },
  badgePreview: {
    background: 'rgba(148, 163, 184, 0.25)',
    color: 'var(--text-primary)',
  },
  soundButton: {
    marginLeft: 'auto',
    fontSize: 13,
  },
  screen: {
    aspectRatio: '16 / 9',
    width: '100%',
    borderRadius: 10,
    overflow: 'hidden',
    background: '#000',
  },
  waiting: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
  },
  hint: {
    margin: 0,
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
};
