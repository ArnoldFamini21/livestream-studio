import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { HlsRecoveryPolicy } from '../utils/hlsRecovery.ts';
import { useDialogFocus } from '../hooks/useDialogFocus.ts';

const loadHls = () => import('hls.js/light').then((module) => module.default);

interface TestOutputPlayerProps {
  /** Media server base URL, without a trailing slash. */
  mediaHttpUrl: string;
  /** The private id of the running test's output. */
  watchId: string | null;
  onClose: () => void;
}

interface TestOutputStatus {
  live: boolean;
  playlistPath?: string;
}

/**
 * The real output of a test: what the media server produced, played back to
 * the host. Wear headphones: the microphone would hear this sound.
 */
export function TestOutputPlayer({ mediaHttpUrl, watchId, onClose }: TestOutputPlayerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [error, setError] = useState('');
  const [needsTap, setNeedsTap] = useState(false);
  useDialogFocus(panelRef, onClose, closeRef);

  // The playlist appears a few seconds after the test starts: ask until it is there.
  useEffect(() => {
    setPlaylistUrl('');
    if (!watchId || !mediaHttpUrl) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`${mediaHttpUrl}/watch/${encodeURIComponent(watchId)}/status`, { cache: 'no-store' });
        const status = await response.json() as TestOutputStatus;
        if (cancelled) return;
        if (status.live && status.playlistPath) {
          setPlaylistUrl(`${mediaHttpUrl}${status.playlistPath}`);
          return;
        }
      } catch {
        // Try again below.
      }
      if (!cancelled) timer = window.setTimeout(poll, 1_500);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mediaHttpUrl, watchId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playlistUrl) return undefined;
    let cancelled = false;
    let hls: Hls | null = null;
    let retryTimer: number | undefined;
    const recovery = new HlsRecoveryPolicy();
    setError('');
    setNeedsTap(false);
    const tryPlay = () => {
      video.play().then(() => { if (!cancelled) setNeedsTap(false); }).catch(() => { if (!cancelled) setNeedsTap(true); });
    };
    const playNatively = () => {
      if (!video.canPlayType('application/vnd.apple.mpegurl')) return false;
      video.src = playlistUrl;
      video.addEventListener('loadedmetadata', tryPlay, { once: true });
      return true;
    };
    loadHls().then((HlsPlayer) => {
      if (cancelled) return;
      if (!HlsPlayer.isSupported()) {
        if (!playNatively()) setError('This browser cannot play the test output.');
        return;
      }
      const player = new HlsPlayer({ lowLatencyMode: true, liveSyncDurationCount: 3, enableWorker: true });
      hls = player;
      player.attachMedia(video);
      player.on(HlsPlayer.Events.MEDIA_ATTACHED, () => player.loadSource(playlistUrl));
      player.on(HlsPlayer.Events.MANIFEST_PARSED, tryPlay);
      player.on(HlsPlayer.Events.FRAG_BUFFERED, () => recovery.recovered());
      player.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (!data.fatal || cancelled) return;
        const step = recovery.next(data);
        if (step.action === 'reload') {
          retryTimer = window.setTimeout(() => {
            if (cancelled) return;
            if (data.details.startsWith('manifest')) player.loadSource(playlistUrl);
            else player.startLoad();
          }, step.delayMs);
        } else if (step.action === 'recover-media') {
          player.recoverMediaError();
        } else if (step.action === 'swap-audio-and-recover') {
          player.swapAudioCodec();
          player.recoverMediaError();
        } else {
          setError(step.message);
          player.destroy();
          hls = null;
        }
      });
    }).catch(() => {
      if (!cancelled && !playNatively()) setError('The player could not load. Please try again.');
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      video.removeEventListener('loadedmetadata', tryPlay);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [playlistUrl]);

  return (
    <div style={styles.backdrop} role="presentation">
      <div ref={panelRef} style={styles.panel} role="dialog" aria-modal="true" aria-labelledby="test-output-title" data-testid="test-output-player">
        <div style={styles.header}>
          <div>
            <h2 id="test-output-title" style={styles.title}>Test output</h2>
            <p style={styles.hint}>This is what the media server made of your stream. Only you can see it. Wear headphones, or your microphone will pick this sound up.</p>
          </div>
          <button ref={closeRef} type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>
        <div style={styles.stage}>
          <video ref={videoRef} style={styles.video} controls playsInline data-testid="test-output-video" />
          {!playlistUrl && !error && <div style={styles.overlay}>Waiting for the first seconds of the test output...</div>}
          {error && <div style={{ ...styles.overlay, color: '#fca5a5' }} role="alert">{error}</div>}
          {needsTap && playlistUrl && (
            <button type="button" className="btn-primary" style={styles.tap} onClick={() => { void videoRef.current?.play(); setNeedsTap(false); }}>
              Press to play
            </button>
          )}
        </div>
        <div style={styles.badge}>TEST - not public</div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: 16 },
  panel: { position: 'relative', width: 'min(880px, 100%)', maxHeight: '100%', overflow: 'auto', background: 'var(--bg-secondary, #111827)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  header: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' },
  title: { margin: 0, fontSize: 16, color: 'var(--text-primary)' },
  hint: { margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 },
  stage: { position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden', aspectRatio: '16 / 9' },
  video: { width: '100%', height: '100%', display: 'block', background: '#000' },
  overlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, color: 'var(--text-secondary)', fontSize: 13, pointerEvents: 'none' },
  tap: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  badge: { alignSelf: 'flex-start', background: '#b45309', color: 'white', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, letterSpacing: 0 },
};
