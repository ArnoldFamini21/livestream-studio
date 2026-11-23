import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type Hls from 'hls.js';
import '../styles/studio-chrome.css';
import { StudioIcon } from './StudioIcon.tsx';
import { WatchPollCard } from './WatchPollCard.tsx';
import { WatchChatPanel } from './WatchChatPanel.tsx';
import { WatchCaptions } from './WatchCaptions.tsx';
import { readWatchPlaybackTime } from '../utils/watchCaptions.ts';
import { ReactionOverlay, createFloatingReaction, REACTION_OVERLAY_DURATION_MS, type FloatingReaction } from './ReactionOverlay.tsx';
import { captureWatchInvite, isWatchAccess, readWatchAccess, readWatchInvite, saveWatchAccess, type WatchAccess } from '../utils/watchAccess.ts';
import type { PremiereStatus, ViewerReactionType } from '@studio/shared';
import { ApiRequestError, requestJson, resolveMediaHttpUrl } from '../utils/apiClient.ts';
import { canonicalWatchPath, looksLikeReplacedWatchLink, pollWatchStatus, type WatchStatus } from '../utils/watchStatus.ts';
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
  premiere?: true;
  registration?: { enabled: boolean; inviteOnly?: true };
}

function registeredNameKey(roomId: string): string {
  return `livestream-studio:watch-registered-name:${roomId}`;
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
  const [premiere, setPremiere] = useState<PremiereStatus | null>(null);
  const premiereClock = useRef(0);
  const [retry, setRetry] = useState(0);
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [wasLive, setWasLive] = useState(false);
  const [watchAccess, setWatchAccess] = useState(() => readWatchAccess(roomId));
  const [privateInvite, setPrivateInvite] = useState(() => readWatchInvite(roomId));
  const { hash: locationHash } = useLocation();
  const [form, setForm] = useState({ name: '', email: '' });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [needsTap, setNeedsTap] = useState(false);
  // Reactions from viewers float over the picture on this page (a few at a time).
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const reactionSequence = useRef(0);
  const floatReactions = useCallback((types: ViewerReactionType[]) => {
    const now = Date.now();
    const created = types.map((type) => createFloatingReaction(type, ++reactionSequence.current, now));
    setFloatingReactions((current) => [...current.filter((item) => now - item.createdAt < REACTION_OVERLAY_DURATION_MS + 500), ...created].slice(-18));
    window.setTimeout(() => {
      setFloatingReactions((current) => current.filter((item) => !created.some((made) => made.id === item.id)));
    }, REACTION_OVERLAY_DURATION_MS + 400);
  }, []);
  const [savedName] = useState(() => {
    try { return roomId ? localStorage.getItem(registeredNameKey(roomId)) ?? '' : ''; } catch { return ''; }
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const getWatchPlaybackTime = useCallback(
    () => readWatchPlaybackTime(videoRef.current, hlsRef.current?.playingDate),
    [],
  );

  useEffect(() => {
    const read = () => {
      const invite = readWatchInvite(roomId);
      if (invite) setPrivateInvite(invite);
      captureWatchInvite(roomId);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [locationHash, roomId]);

  // Room details: name, host, schedule, and whether registration gates the page.
  useEffect(() => {
    if (!roomId) { setRoomError('missing'); return; }
    const controller = new AbortController();
    setRoomError(null);
    requestJson<WatchRoom>(`/api/watch/${encodeURIComponent(roomId)}`, { signal: controller.signal })
      .then((data) => {
        if (!data || typeof data.id !== 'string' || typeof data.name !== 'string') throw new Error('Invalid room response');
        if (controller.signal.aborted) return;
        setRoom(data);
        if (data.id !== roomId) setWatchAccess((current) => current || readWatchAccess(data.id));
        // An older /watch/<roomId> link: show the canonical address from now on.
        const canonical = canonicalWatchPath(roomId, data.id, window.location.pathname);
        if (canonical) {
          try { window.history.replaceState(window.history.state, '', `${canonical}${window.location.search}${window.location.hash}`); } catch { /* Keep the old address. */ }
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRoomError(error instanceof ApiRequestError && error.status === 404 ? 'missing' : 'failed');
      });
    return () => controller.abort();
  }, [roomId, retry]);

  const protectedWatch = Boolean(room?.registration?.enabled || room?.registration?.inviteOnly);
  const watchAccessToken = protectedWatch && isWatchAccess(watchAccess) ? watchAccess.token : undefined;
  const gated = protectedWatch && !watchAccessToken;
  const ready = Boolean(room) && !roomError && !gated;
  // The media server publishes under the canonical watch id (an old link may carry the room id).
  const watchId = room?.id || roomId;

  const clearWatchAccess = useCallback(() => {
    setWatchAccess(null);
    saveWatchAccess(roomId, null);
    saveWatchAccess(watchId, null);
    setStatus(null);
    setPremiere(null);
    setWasLive(false);
  }, [roomId, watchId]);

  useEffect(() => {
    if (!watchAccess) return;
    const delay = Math.max(0, Date.parse(watchAccess.expiresAt) - Date.now());
    const timeout = window.setTimeout(clearWatchAccess, delay);
    return () => window.clearTimeout(timeout);
  }, [clearWatchAccess, watchAccess]);

  // Wait for room details and registration before requesting any live media.
  useEffect(() => {
    if (!ready || !mediaHttpUrl) return;
    const statusUrl = new URL(`${mediaHttpUrl}/watch/${encodeURIComponent(watchId)}/status`);
    if (watchAccessToken) statusUrl.searchParams.set('watchToken', watchAccessToken);
    return pollWatchStatus(statusUrl.href, (next) => {
      setStatus(next);
      setStatusFailed(false);
      if (next.live) setWasLive(true);
    }, (httpStatus) => {
      if (httpStatus === 401 && watchAccessToken) clearWatchAccess();
      else setStatusFailed(true);
    });
  }, [ready, mediaHttpUrl, watchId, retry, watchAccessToken, clearWatchAccess]);

  const premiereEligible = ready && Boolean(watchAccessToken && room?.registration?.inviteOnly && room.premiere && room.scheduledFor);
  useEffect(() => {
    if (!premiereEligible || !mediaHttpUrl || !watchAccessToken) return;
    const url = new URL(`${mediaHttpUrl}/premieres/${encodeURIComponent(watchId)}/status`);
    url.searchParams.set('watchToken', watchAccessToken);
    const controller = new AbortController();
    let timer: number | undefined;
    const check = async () => {
      let delay = 30_000;
      try {
        const started = Date.now();
        const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (response.status === 401) { clearWatchAccess(); return; }
        if (!response.ok) throw new Error('Premiere status is unavailable');
        const next = await response.json() as PremiereStatus;
        premiereClock.current = next.serverTime - (started + Date.now()) / 2;
        setPremiere(next);
        if (next.phase === 'ended') return;
        if (next.phase === 'playing') delay = Math.min(5_000, Math.max(250, next.startsAt! + next.durationMs! - next.serverTime));
        if (next.phase === 'scheduled') delay = Math.min(30_000, Math.max(250, next.startsAt! - next.serverTime));
      } catch { /* A normal scheduled show has no premiere. Continue checking for live HLS. */ }
      if (!controller.signal.aborted) timer = window.setTimeout(check, delay);
    };
    void check();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [clearWatchAccess, mediaHttpUrl, premiereEligible, retry, watchAccessToken, watchId]);

  const premiereLive = premiereEligible && premiere?.phase === 'playing' && !status?.live;
  const premiereUrl = premiereLive ? `${mediaHttpUrl}/premieres/${encodeURIComponent(watchId)}/video?watchToken=${encodeURIComponent(watchAccessToken || '')}` : '';
  const premiereStart = premiere?.startsAt;
  const seekToPremiere = useCallback((video: HTMLVideoElement) => {
    if (premiereStart && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(Math.max(0, video.duration - 0.1), Math.max(0, (Date.now() + premiereClock.current - premiereStart) / 1000));
    }
  }, [premiereStart]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !premiereUrl || !premiereStart) return;
    let active = true;
    setNeedsTap(false);
    setPlayerError('');
    const play = () => {
      seekToPremiere(video);
      void video.play().catch(() => { if (active) setNeedsTap(true); });
    };
    const fail = () => setPlayerError('The premiere could not play. Please retry.');
    video.addEventListener('loadedmetadata', play, { once: true });
    video.addEventListener('error', fail);
    video.src = premiereUrl;
    return () => {
      active = false;
      video.removeEventListener('loadedmetadata', play);
      video.removeEventListener('error', fail);
      video.removeAttribute('src');
      video.load();
    };
  }, [premiereStart, premiereUrl, retry, seekToPremiere]);

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
    const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
    const onNativeError = () => {
      if (cancelled) return;
      // Safari's player stops on a missing playlist or segment; retry like hls.js does.
      const step = recovery.next({ type: 'networkError', details: 'nativePlaybackError' });
      if (step.action !== 'reload') return;
      retryTimer = window.setTimeout(() => {
        if (cancelled) return;
        video.src = playlistUrl;
        video.addEventListener('loadedmetadata', tryPlay, { once: true });
      }, step.delayMs);
    };
    const onNativeProgress = () => recovery.recovered();
    const playNatively = () => {
      if (!nativeHls) return false;
      video.addEventListener('error', onNativeError);
      video.addEventListener('playing', onNativeProgress);
      video.src = playlistUrl;
      video.addEventListener('loadedmetadata', tryPlay, { once: true });
      return true;
    };
    // Safari (the only browser with AirPlay) plays HLS natively, which keeps
    // AirPlay, lock-screen playback, and battery life; hls.js would turn AirPlay off.
    // Elsewhere hls.js is preferred (Android's native HLS lags further behind live).
    if (nativeHls && 'WebKitPlaybackTargetAvailabilityEvent' in window) {
      playNatively();
    } else {
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
        // The player chunk failed to load (offline, or a stale deploy); a browser with native HLS can still play.
        if (!cancelled && !playNatively()) setPlayerError('The player could not load. Please retry.');
      });
    }
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      video.removeEventListener('loadedmetadata', tryPlay);
      video.removeEventListener('error', onNativeError);
      video.removeEventListener('playing', onNativeProgress);
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
      const result = await requestJson<{ access?: WatchAccess }>(`/api/watch/${encodeURIComponent(watchId)}/registrants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: form.name.trim(), email: form.email.trim(), invite: privateInvite || undefined }),
      });
      if (!isWatchAccess(result.access)) throw new Error('Protected viewing is not ready. Please try again.');
      saveWatchAccess(watchId, result.access);
      if (roomId !== watchId) saveWatchAccess(roomId, result.access);
      try { localStorage.setItem(registeredNameKey(watchId), form.name.trim()); } catch { /* Private mode. */ }
      setWatchAccess(result.access);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Registration failed. Please try again.');
    } finally {
      setFormBusy(false);
    }
  }, [form.email, form.name, privateInvite, roomId, watchId]);

  const title = room?.name || 'Live broadcast';
  const schedule = formatSchedule(room?.scheduledFor);
  const live = ready && Boolean(status?.live || premiereLive);
  const ended = !live && (wasLive || premiereEligible && premiere?.phase === 'ended');

  return (
    <div className="watch-page">
      <header className="watch-header">
        <a href="/" className="entry-wordmark"><StudioIcon name="video" /><span>Live Stream Studio</span></a>
        {live && <span className="watch-live-badge" role="status"><i />LIVE{typeof status?.viewers === 'number' && status.viewers > 0 ? ` · ${status.viewers} watching` : ''}</span>}
      </header>
      <main className="watch-main">
        {roomError === 'missing' ? (
          <section className="watch-card" role="alert">
            {looksLikeReplacedWatchLink(roomId) ? (
              <>
                <h1>This watch link was replaced</h1>
                <p>The studio now uses a new watch link. Ask the host for the new link.</p>
              </>
            ) : (
              <>
                <h1>Broadcast not found</h1>
                <p>This link doesn't point to a studio. Check the link you were given.</p>
              </>
            )}
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
            {room?.registration?.inviteOnly && !privateInvite ? (
              <p>Ask the host for a private viewing link for this event.</p>
            ) : (
            <form className="watch-form" onSubmit={(event) => void submitRegistration(event)}>
              <label>Your name<input required autoComplete="name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
              <label>Email<input required type="email" autoComplete="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></label>
              {formError && <p className="watch-error" role="alert">{formError}</p>}
              <button type="submit" disabled={formBusy || !form.name.trim() || !form.email.trim()}>{formBusy ? 'Registering…' : 'Register and watch'}</button>
            </form>
            )}
          </section>
        ) : (
          <>
            <div className={`watch-player${live ? ' is-live' : ''}`}>
              <video ref={videoRef} playsInline controls={live} muted={false} aria-hidden={!live} aria-label={`${title} live video`} />
              {!live && (
                <div className="watch-placeholder">
                  {ended ? (
                    <><h2>This broadcast has ended</h2><p>Thank you for watching.</p></>
                  ) : premiereEligible && premiere?.phase === 'scheduled' ? (
                    <><h2>Premiere starts soon</h2><p>Scheduled for {schedule}. The video starts automatically.</p></>
                  ) : statusFailed ? (
                    <><h2>Connection interrupted</h2><p>Trying to reconnect to the broadcast…</p></>
                  ) : !room || status === null ? (
                    <><h2>Connecting…</h2><p>Checking whether the broadcast is live.</p></>
                  ) : (
                    <><h2>Not live yet</h2><p>{schedule ? `Scheduled for ${schedule}. ` : ''}This page starts playing on its own when the host goes live.</p></>
                  )}
                </div>
              )}
              {live && playerError && <div className="watch-placeholder" role="alert"><p>{playerError}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry playback</button></div>}
              {live && statusFailed && !premiereLive && <p className="watch-error" role="status">Connection interrupted. Reconnecting…</p>}
              <ReactionOverlay reactions={floatingReactions} />
              {live && captionsAvailable && <WatchCaptions watchId={watchId} watchAccessToken={watchAccessToken} readPlaybackTime={getWatchPlaybackTime} />}
              {live && needsTap && !playerError && (
                <button type="button" className="watch-tap" onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (premiereLive) seekToPremiere(video);
                  void video.play().then(() => setNeedsTap(false)).catch(() => undefined);
                }}>
                  Tap to play
                </button>
              )}
            </div>
            <section className="watch-details">
              <h1>{title}</h1>
              {room?.hostName && <p className="watch-host">Hosted by {room.hostName}</p>}
              {schedule && !live && !ended && <p className="watch-schedule">{schedule}</p>}
            </section>
            {room && !ended && <WatchPollCard watchId={watchId} watchAccessToken={watchAccessToken} />}
            {room && !ended && <WatchChatPanel watchId={watchId} watchAccessToken={watchAccessToken} registeredName={form.name.trim() || savedName} onFloat={floatReactions} onCaptionsAvailable={setCaptionsAvailable} />}
          </>
        )}
      </main>
    </div>
  );
}

export default WatchPage;
