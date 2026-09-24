import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import Hls from 'hls.js';
import '../styles/studio-chrome.css';
import { StudioIcon } from './StudioIcon.tsx';
import { buildApiUrl, resolveMediaHttpUrl } from '../utils/apiClient.ts';

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

interface WatchStatus {
  live: boolean;
  startedAt?: string;
  playlistPath?: string;
  viewers?: number;
}

const STATUS_POLL_MS = 5_000;

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
  const mediaHttpUrl = useMemo(() => resolveMediaHttpUrl().replace(/\/+$/, ''), []);
  const [room, setRoom] = useState<WatchRoom | null>(null);
  const [roomError, setRoomError] = useState<'missing' | 'failed' | null>(null);
  const [status, setStatus] = useState<WatchStatus | null>(null);
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
    let cancelled = false;
    fetch(buildApiUrl(`/api/rooms/${encodeURIComponent(roomId)}`))
      .then(async (response) => {
        if (response.status === 404) { if (!cancelled) setRoomError('missing'); return; }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as WatchRoom;
        if (!cancelled) setRoom({ id: data.id, name: data.name, hostName: data.hostName, scheduledFor: data.scheduledFor, registration: data.registration });
      })
      .catch(() => { if (!cancelled) setRoomError('failed'); });
    return () => { cancelled = true; };
  }, [roomId]);

  const gated = Boolean(room?.registration?.enabled) && !registered;

  // Live status from the media server. Polling also wakes a sleeping free instance.
  useEffect(() => {
    if (!roomId || !mediaHttpUrl || gated) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${mediaHttpUrl}/watch/${encodeURIComponent(roomId)}/status`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json() as WatchStatus;
        if (cancelled) return;
        setStatus(next);
        if (next.live) setWasLive(true);
      } catch {
        if (!cancelled) setStatus((current) => current ?? { live: false });
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [gated, mediaHttpUrl, roomId]);

  const playlistUrl = status?.live && status.playlistPath ? `${mediaHttpUrl}${status.playlistPath}` : '';

  // Attach the player while live; tear it down when the broadcast ends.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playlistUrl) return;
    let hls: Hls | null = null;
    const tryPlay = () => { video.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true)); };
    if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3, enableWorker: true });
      hlsRef.current = hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(playlistUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !hls) return;
        // Network hiccups (a segment not written yet) recover on their own; media errors need a nudge.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari plays HLS natively.
      video.src = playlistUrl;
      video.addEventListener('loadedmetadata', tryPlay, { once: true });
    }
    return () => {
      hls?.destroy();
      hlsRef.current = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [playlistUrl]);

  const submitRegistration = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setFormBusy(true);
    setFormError('');
    try {
      const response = await fetch(buildApiUrl(`/api/rooms/${encodeURIComponent(roomId)}/registrants`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), email: form.email.trim() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Registration failed. Please try again.');
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
  const live = Boolean(status?.live);
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
              <video ref={videoRef} playsInline controls={live} muted={false} aria-label={`${title} live video`} />
              {!live && (
                <div className="watch-placeholder">
                  {ended ? (
                    <><h2>This broadcast has ended</h2><p>Thank you for watching.</p></>
                  ) : roomError === 'failed' || status === null ? (
                    <><h2>Connecting…</h2><p>Checking whether the broadcast is live.</p></>
                  ) : (
                    <><h2>Not live yet</h2><p>{schedule ? `Scheduled for ${schedule}. ` : ''}This page starts playing on its own when the host goes live.</p></>
                  )}
                </div>
              )}
              {live && needsTap && (
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
