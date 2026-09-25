import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type Hls from 'hls.js';
import '../styles/studio-chrome.css';
import { StudioIcon } from './StudioIcon.tsx';
import { ApiRequestError, requestJson, resolveMediaHttpUrl } from '../utils/apiClient.ts';
import { pollWatchStatus, type WatchStatus } from '../utils/watchStatus.ts';
import { HlsRecoveryPolicy } from '../utils/hlsRecovery.ts';

// The player library loads only once there is something to play, so the
// waiting page stays small. The light build has everything a single live
// rendition needs (no subtitles, alternate audio, or DRM).
const loadHls = () => import('hls.js/light').then((module) => module.default);

/**
 * The public watch page: the live program as HLS from the media server,
 * behind the studio's registration form when the host enabled it.
 */

interface WatchRoom {
  id: string;
  name: string;
  hostName?: string;
  scheduledFor?: string;
  registration?: { enabled: boolean };
}

function registrationKey(roomId: string): string {
  return `livestream-studio:watch-registered:${roomId}`;
}

function formatSchedule(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
}

export function WatchPage() {
  const { roomId = '' } = useParams<{ roomId: string }>();
  return <WatchRoomPage key={roomId} roomId={roomId} />;
}

function WatchRoomPage({ roomId }: { roomId: string }) {
  const mediaHttpUrl = useMemo(() => resolveMediaHttpUrl().replace(/\/+$/, ''), []);
  const [room, setRoom] = useState<WatchRoom | null>(null);
  const [roomError, setRoomError] = useState<'missing' | 'failed' | null>(null);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [retry, setRetry] = useState(0);
  const [statusFailed, setStatusFailed] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [wasLive, setWasLive] = useState(false);
  const [registered, setRegistered] = useState(() => {
    try { return Boolean(roomId && localStorage.getItem(registrationKey(roomId))); } catch { return false; }
  });
  const [form, setForm] = useState({ name: '', email: '' });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [needsTap, setNeedsTap] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Room details: name, host, schedule, and whether registration gates the page.
  useEffect(() => {
    if (!roomId) { setRoomError('missing'); return; }
    const controller = new AbortController();
    setRoomError(null);
    requestJson<WatchRoom>(`/api/rooms/${encodeURIComponent(roomId)}`, { signal: controller.signal })
      .then((data) => {
        if (!data || typeof data.id !== 'string' || typeof data.name !== 'string') throw new Error('Invalid room response');
        if (!controller.signal.aborted) setRoom(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRoomError(error instanceof ApiRequestError && error.status === 404 ? 'missing' : 'failed');
      });
    return () => controller.abort();
  }, [roomId, retry]);

  const gated = Boolean(room?.registration?.enabled) && !registered;
  const ready = Boolean(room) && !roomError && !gated;

  // Wait for room details and registration before requesting any live media.
  useEffect(() => {
    if (!ready || !mediaHttpUrl) return;
    return pollWatchStatus(`${mediaHttpUrl}/watch/${encodeURIComponent(roomId)}/status`, (next) => {
      setStatus(next);
      setStatusFailed(false);
      if (next.live) setWasLive(true);
    }, () => setStatusFailed(true));
  }, [ready, mediaHttpUrl, roomId, retry]);

  const playlistUrl = ready && status?.live && status.playlistPath ? `${mediaHttpUrl}${status.playlistPath}` : '';

  // Attach the player while live; tear it down when the broadcast ends.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playlistUrl) return;
    let cancelled = false;
    let hls: Hls | null = null;
    let retryTimer: number | undefined;
    const recovery = new HlsRecoveryPolicy();
    setNeedsTap(false);
    setPlayerError('');
    const tryPlay = () => { video.play().then(() => { if (!cancelled) setNeedsTap(false); }).catch(() => { if (!cancelled) setNeedsTap(true); }); };
    const playNatively = () => {
      if (!video.canPlayType('application/vnd.apple.mpegurl')) return false;
      // Safari plays HLS natively.
      video.src = playlistUrl;
      video.addEventListener('loadedmetadata', tryPlay, { once: true });
      return true;
    };
    loadHls().then((HlsPlayer) => {
      if (cancelled) return;
      if (!HlsPlayer.isSupported()) {
        if (!playNatively()) setPlayerError('This browser cannot play this broadcast. Please use a browser with HLS support.');
        return;
      }
      const player = new HlsPlayer({ lowLatencyMode: true, liveSyncDurationCount: 3, enableWorker: true });
      hls = player;
      hlsRef.current = player;
      player.attachMedia(video);
      player.on(HlsPlayer.Events.MEDIA_ATTACHED, () => player.loadSource(playlistUrl));
      player.on(HlsPlayer.Events.MANIFEST_PARSED, tryPlay);
      player.on(HlsPlayer.Events.FRAG_BUFFERED, () => recovery.recovered());
      player.on(HlsPlayer.Events.ERROR, (_event, data) => {
        if (!data.fatal || cancelled) return;
        const step = recovery.next(data);
        if (step.action === 'reload') {
          // The playlist can be missing for a moment (first segment not written yet, encoder restart).
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
          setPlayerError(step.message);
          player.destroy();
          hls = null;
          hlsRef.current = null;
        }
      });
    }).catch(() => {
      // The player chunk failed to load (offline, or a stale deploy); Safari can still play natively.
      if (!cancelled && !playNatively()) setPlayerError('The player could not load. Please retry.');
    });
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      video.removeEventListener('loadedmetadata', tryPlay);
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [playlistUrl, retry]);

  const submitRegistration = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setFormBusy(true);
    setFormError('');
    try {
      await requestJson(`/api/rooms/${encodeURIComponent(roomId)}/registrants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), email: form.email.trim() }),
      });
      try { localStorage.setItem(registrationKey(roomId), form.email.trim()); } catch { /* Private mode. */ }
      setRegistered(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Registration failed. Please try again.');
    } finally {
      setFormBusy(false);
    }
  }, [form.email, form.name, roomId]);

  const title = room?.name || 'Live broadcast';
  const schedule = formatSchedule(room?.scheduledFor);
  const live = ready && Boolean(status?.live);
  const ended = !live && wasLive;

  return (
    <div className="watch-page">
      <header className="watch-header">
        <a href="/" className="entry-wordmark"><StudioIcon name="video" /><span>Live Stream Studio</span></a>
        {live && <span className="watch-live-badge" role="status"><i />LIVE{typeof status?.viewers === 'number' && status.viewers > 0 ? ` · ${status.viewers} watching` : ''}</span>}
      </header>
      <main className="watch-main">
        {roomError === 'missing' ? (
          <section className="watch-card" role="alert">
            <h1>Broadcast not found</h1>
            <p>This link doesn't point to a studio. Check the link you were given.</p>
          </section>
        ) : roomError === 'failed' ? (
          <section className="watch-card" role="alert">
            <h1>Unable to connect</h1>
            <p>The studio server could not be reached. Please try again.</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry connection</button>
          </section>
        ) : gated ? (
          <section className="watch-card">
            <p className="watch-kicker">{room?.hostName ? `${room.hostName} invites you to` : 'Register to watch'}</p>
            <h1>{title}</h1>
            {schedule && <p className="watch-schedule">{schedule}</p>}
            <form className="watch-form" onSubmit={(event) => void submitRegistration(event)}>
              <label>Your name<input required autoComplete="name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
              <label>Email<input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></label>
              {formError && <p className="watch-error" role="alert">{formError}</p>}
              <button type="submit" disabled={formBusy || !form.name.trim() || !form.email.trim()}>{formBusy ? 'Registering…' : 'Register and watch'}</button>
            </form>
          </section>
        ) : (
          <>
            <div className={`watch-player${live ? ' is-live' : ''}`}>
              <video ref={videoRef} playsInline controls={live} muted={false} aria-hidden={!live} aria-label={`${title} live video`} />
              {!live && (
                <div className="watch-placeholder">
                  {statusFailed ? (
                    <><h2>Connection interrupted</h2><p>Trying to reconnect to the broadcast…</p></>
                  ) : ended ? (
                    <><h2>This broadcast has ended</h2><p>Thank you for watching.</p></>
                  ) : !room || status === null ? (
                    <><h2>Connecting…</h2><p>Checking whether the broadcast is live.</p></>
                  ) : (
                    <><h2>Not live yet</h2><p>{schedule ? `Scheduled for ${schedule}. ` : ''}This page starts playing on its own when the host goes live.</p></>
                  )}
                </div>
              )}
              {live && playerError && <div className="watch-placeholder" role="alert"><p>{playerError}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry playback</button></div>}
              {live && statusFailed && <p className="watch-error" role="status">Connection interrupted. Reconnecting…</p>}
              {live && needsTap && !playerError && (
                <button type="button" className="watch-tap" onClick={() => videoRef.current?.play().then(() => setNeedsTap(false)).catch(() => undefined)}>
                  Tap to play
                </button>
              )}
            </div>
            <section className="watch-details">
              <h1>{title}</h1>
              {room?.hostName && <p className="watch-host">Hosted by {room.hostName}</p>}
              {schedule && !live && !ended && <p className="watch-schedule">{schedule}</p>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default WatchPage;
