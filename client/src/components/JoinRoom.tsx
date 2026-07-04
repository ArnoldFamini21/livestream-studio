import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  getScheduledGuestOpenAtMs,
  isScheduledGuestAccessBlocked,
  type RoomRegistrantResponse,
  type RoomRegistrationSettings,
} from '@studio/shared';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';
import { acquireAudioContext, releaseAudioContext } from '../utils/audioContext.ts';
import {
  readPreferredAudioProcessing,
  readPreferredVideoQuality,
  VIDEO_QUALITY_PRESETS,
  writePreferredAudioProcessing,
  writePreferredVideoQuality,
  type VideoQualityPresetId,
} from '../utils/mediaPreferences.ts';
import { createSpeakerTestToneBlob } from '../utils/speakerTestTone.ts';
import {
  clearUrlHostToken,
  getHostSession,
  getSavedHostStudio,
  getStoredUserName,
  getUrlHostToken,
  persistLegacyHostSession,
  persistHostSession,
  upsertSavedHostStudio,
} from '../utils/hostSession.ts';
import { getApiErrorMessage, getJson, isAbortError, postJson } from '../utils/apiClient.ts';
import { getGuestInviteToken, getInviteStudioName } from '../utils/inviteLinks.ts';
import {
  GUEST_REGISTRATION_EMAIL_STORAGE_KEY,
  getRegistrationSessionKey,
  isValidRegistrantEmail,
} from '../utils/webinarRegistration.ts';

const HOST_ACCESS_MISSING_MESSAGE = 'Host access is missing in this browser. Open this studio from Your Studios, use your private host link, or create a new studio.';

interface RoomExistsResponse {
  name: string;
  participantCount: number;
  status?: string;
  hostName?: string;
  scheduledFor?: string;
  passwordProtected?: boolean;
  registration?: RoomRegistrationSettings;
}

function getStoredGuestEmail(): string {
  try {
    return localStorage.getItem(GUEST_REGISTRATION_EMAIL_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function hasStoredRegistration(roomId?: string): boolean {
  if (!roomId) return false;
  try {
    return Boolean(sessionStorage.getItem(getRegistrationSessionKey(roomId)));
  } catch {
    return false;
  }
}

function formatGuestOpenCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function JoinRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const savedHostStudio = roomId ? getSavedHostStudio(roomId) : null;
  const urlHostToken = roomId ? getUrlHostToken() : '';
  const hostSession = roomId ? getHostSession(roomId, urlHostToken) : null;
  const hostToken = hostSession?.hostToken || '';
  const isHostEntryRequested = searchParams.get('role') === 'host';
  const coHostInviteToken = searchParams.get('invite') || searchParams.get('token') || '';
  const isCoHostInvite = searchParams.get('role') === 'co-host' && coHostInviteToken.length > 0;
  const guestInviteToken = getGuestInviteToken(searchParams);
  const isSecureGuestInvite = !isCoHostInvite && guestInviteToken.length > 0;
  const inviteStudioName = getInviteStudioName(searchParams);
  const isHostSession = Boolean(hostSession);
  const hostEntryMode = isHostSession || isHostEntryRequested;
  const hostAccessMissing = Boolean(isHostEntryRequested && !hostSession);
  const initialName = hostSession
    ? hostSession.hostName
    : isHostEntryRequested
      ? savedHostStudio?.hostName || getStoredUserName() || ''
      : getStoredUserName() || savedHostStudio?.hostName || '';
  // Auto-fill from sessionStorage for Hosts
  const [guestName, setGuestName] = useState(initialName);
  const [guestEmail, setGuestEmail] = useState(() => getStoredGuestEmail());
  const [roomInfo, setRoomInfo] = useState<RoomExistsResponse | null>(null);
  const [roomPassword, setRoomPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [registrationSubmitted, setRegistrationSubmitted] = useState(() => hasStoredRegistration(roomId));
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const needsRoomPassword = Boolean(roomInfo?.passwordProtected && !hostEntryMode && !isCoHostInvite && !isSecureGuestInvite);
  const guestOpenAtMs = getScheduledGuestOpenAtMs(roomInfo?.scheduledFor);
  const scheduledGuestBlocked = Boolean(
    !hostEntryMode &&
    !isCoHostInvite &&
    isScheduledGuestAccessBlocked(roomInfo?.scheduledFor, nowMs)
  );
  const registrationRequired = Boolean(
    roomInfo?.registration?.enabled &&
    !hostEntryMode &&
    !isCoHostInvite
  );
  const canSubmitRegistration = Boolean(
    registrationRequired &&
    guestName.trim() &&
    isValidRegistrantEmail(guestEmail)
  );
  const guestOpenLabel = guestOpenAtMs !== null
    ? new Date(guestOpenAtMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const guestOpenCountdown = scheduledGuestBlocked
    ? formatGuestOpenCountdown((guestOpenAtMs ?? nowMs) - nowMs)
    : '';
  
  // Advanced Audio Settings
  const [echoCancellation, setEchoCancellation] = useState(() => readPreferredAudioProcessing().echoCancellation);
  const [noiseSuppression, setNoiseSuppression] = useState(() => readPreferredAudioProcessing().noiseSuppression);
  const [voiceIsolation, setVoiceIsolation] = useState(() => readPreferredAudioProcessing().voiceIsolation);

  // Media preview
  const {
    localStream,
    audioEnabled,
    videoEnabled,
    startMedia,
    stopMedia,
    toggleAudio,
    toggleVideo,
    audioDevices,
    videoDevices,
    audioOutputDevices,
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    selectedAudioOutputDeviceId,
    videoQuality,
    recommendedVideoQuality,
    switchAudioDevice,
    switchVideoDevice,
    updateVideoQuality,
    applyAudioOutput,
    onAudioOutputDeviceChange,
  } = useMediaDevices();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const audioEnabledRef = useRef(audioEnabled);
  const videoEnabledRef = useRef(videoEnabled);
  const speakerTestAudioRef = useRef<HTMLAudioElement | null>(null);
  const speakerTestUrlRef = useRef<string>('');
  const [audioLevel, setAudioLevel] = useState(0);
  const [speakerTestPlaying, setSpeakerTestPlaying] = useState(false);

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);

  useEffect(() => {
    videoEnabledRef.current = videoEnabled;
  }, [videoEnabled]);

  // Start camera preview on mount
  useEffect(() => {
    startMedia(undefined, undefined, {
      echoCancellation,
      noiseSuppression,
      voiceIsolation,
      videoQuality: readPreferredVideoQuality(),
      audioEnabled: audioEnabledRef.current,
      videoEnabled: videoEnabledRef.current,
    });
    return () => {
      stopMedia();
    };
  }, [startMedia, stopMedia, echoCancellation, noiseSuppression, voiceIsolation]);

  // Attach local stream to preview video
  useEffect(() => {
    if (videoRef.current && localStream) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Audio level meter
  const updateAudioLevel = useCallback(() => {
    if (analyserRef.current) {
      const data = new Uint8Array(analyserRef.current.fftSize);
      analyserRef.current.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const val = (data[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / data.length);
      setAudioLevel(Math.min(1, rms * 4));
    }
    animFrameRef.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  useEffect(() => {
    if (localStream && audioEnabled) {
      try {
        const ctx = acquireAudioContext();
        const source = ctx.createMediaStreamSource(localStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        animFrameRef.current = requestAnimationFrame(updateAudioLevel);
      } catch (err) {
        // AudioContext may fail in some environments
      }
    } else {
      setAudioLevel(0);
    }
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (audioContextRef.current) {
        releaseAudioContext();
      }
      audioContextRef.current = null;
      analyserRef.current = null;
    };
  }, [localStream, audioEnabled, updateAudioLevel]);

  // Fetch room info
  useEffect(() => {
    if (!roomId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    getJson<RoomExistsResponse>(`/api/rooms/${encodeURIComponent(roomId)}/exists`, { signal: controller.signal })
      .then((data) => {
        setRoomInfo(data);
        setLoading(false);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setNotFound(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [roomId]);

  useEffect(() => {
    if (!scheduledGuestBlocked) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [scheduledGuestBlocked]);

  useEffect(() => {
    if (!roomId || !hostSession) return;
    if (hostSession.source === 'legacy') {
      persistLegacyHostSession({ roomId, hostName: hostSession.hostName });
      return;
    }
    persistHostSession({ roomId, hostName: hostSession.hostName, hostToken: hostSession.hostToken });
    if (hostSession.source === 'url') {
      clearUrlHostToken();
    }
  }, [roomId, hostSession?.hostName, hostSession?.hostToken, hostSession?.source]);

  useEffect(() => {
    if (!roomId || !hostSession || !roomInfo || !hostSession.hostToken) return;
    upsertSavedHostStudio({
      id: roomId,
      name: roomInfo.name,
      hostName: roomInfo.hostName || hostSession.hostName,
      hostToken: hostSession.hostToken,
      createdAt: savedHostStudio?.createdAt || new Date().toISOString(),
      scheduledFor: roomInfo.scheduledFor,
      passwordProtected: Boolean(roomInfo.passwordProtected),
      status: roomInfo.status,
    });
  }, [roomId, hostSession?.hostName, hostSession?.hostToken, roomInfo, savedHostStudio?.createdAt]);

  useEffect(() => {
    return () => {
      const audio = speakerTestAudioRef.current;
      if (audio) {
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
        audio.src = '';
      }
      if (speakerTestUrlRef.current) {
        URL.revokeObjectURL(speakerTestUrlRef.current);
        speakerTestUrlRef.current = '';
      }
    };
  }, []);

  const joinStudio = () => {
    void joinStudioAsync();
  };

  const submitGuestRegistration = async (): Promise<boolean> => {
    if (!roomId || !registrationRequired || registrationSubmitted) return true;
    if (!guestName.trim()) {
      setRegistrationError('Enter your name to register.');
      return false;
    }
    if (!isValidRegistrantEmail(guestEmail)) {
      setRegistrationError('Enter a valid email address to register.');
      return false;
    }

    setRegistrationError(null);
    setJoining(true);
    try {
      const response = await postJson<RoomRegistrantResponse>(
        `/api/rooms/${encodeURIComponent(roomId)}/registrants`,
        {
          name: guestName.trim(),
          email: guestEmail.trim(),
        },
        { timeoutMs: 15_000 }
      );
      try {
        sessionStorage.setItem(getRegistrationSessionKey(roomId), response.registrant.id);
        localStorage.setItem(GUEST_REGISTRATION_EMAIL_STORAGE_KEY, response.registrant.email);
      } catch {
        // Storage is best-effort; registration still succeeded server-side.
      }
      setRegistrationSubmitted(true);
      return true;
    } catch (err) {
      setRegistrationError(getApiErrorMessage(err, 'Registration failed. Please try again.'));
      return false;
    } finally {
      setJoining(false);
    }
  };

  const joinStudioAsync = async () => {
    if (!guestName.trim()) return;
    if (hostAccessMissing) return;
    if (scheduledGuestBlocked) {
      if (registrationRequired && !registrationSubmitted) {
        await submitGuestRegistration();
      }
      return;
    }
    if (needsRoomPassword && !roomPassword.trim()) return;
    if (registrationRequired && !registrationSubmitted) {
      const registered = await submitGuestRegistration();
      if (!registered) return;
    }

    stopMedia();
    
    if (isHostSession) {
      if (roomId) {
        if (hostSession?.source === 'legacy') {
          persistLegacyHostSession({ roomId, hostName: guestName.trim() });
        } else {
          persistHostSession({ roomId, hostName: guestName.trim(), hostToken });
        }
      }
    } else if (isCoHostInvite && roomId) {
      sessionStorage.setItem('userRole', 'co-host');
      sessionStorage.setItem(`coHostInviteToken:${roomId}`, coHostInviteToken);
    } else {
      sessionStorage.setItem('userRole', 'guest');
      if (roomId) {
        sessionStorage.removeItem(`coHostInviteToken:${roomId}`);
        if (isSecureGuestInvite) {
          sessionStorage.setItem(`guestInviteToken:${roomId}`, guestInviteToken);
        } else {
          sessionStorage.removeItem(`guestInviteToken:${roomId}`);
        }
      }
    }
    sessionStorage.setItem('userName', guestName);
    sessionStorage.setItem('preferredAudioEnabled', String(audioEnabled));
    sessionStorage.setItem('preferredVideoEnabled', String(videoEnabled));
    writePreferredAudioProcessing({ echoCancellation, noiseSuppression, voiceIsolation });
    writePreferredVideoQuality(videoQuality);
    if (roomId && needsRoomPassword) {
      sessionStorage.setItem(`roomPassword:${roomId}`, roomPassword);
    } else if (roomId) {
      sessionStorage.removeItem(`roomPassword:${roomId}`);
    }
    navigate(`/studio/${roomId}`);
  };

  const joinDisabled = Boolean(
    joining ||
    !guestName.trim() ||
    hostAccessMissing ||
    (scheduledGuestBlocked && (!registrationRequired || registrationSubmitted)) ||
    (registrationRequired && !registrationSubmitted && !canSubmitRegistration) ||
    (needsRoomPassword && !roomPassword.trim())
  );

  const joinButtonLabel = hostAccessMissing
    ? 'Host Access Missing'
    : joining
      ? registrationSubmitted ? 'Joining...' : 'Registering...'
      : scheduledGuestBlocked
        ? registrationRequired && !registrationSubmitted ? 'Register for Studio' : 'Not Open Yet'
        : isHostSession
          ? 'Enter as Host'
          : isCoHostInvite
            ? 'Join as Co-host'
            : registrationRequired && !registrationSubmitted
              ? 'Register & Join Studio'
              : 'Join Studio';

  const onAudioDeviceChange = async (deviceId: string) => {
    try {
      await switchAudioDevice(deviceId, { echoCancellation, noiseSuppression, voiceIsolation });
    } catch (err) {
      // Device switch failed
    }
  };

  const onVideoDeviceChange = async (deviceId: string) => {
    try {
      await switchVideoDevice(deviceId, videoQuality);
    } catch (err) {
      // Device switch failed
    }
  };

  const onVideoQualityChange = async (next: VideoQualityPresetId) => {
    try {
      await updateVideoQuality(next);
    } catch (err) {
      // Quality switch failed
    }
  };

  const onSpeakerDeviceChange = async (deviceId: string) => {
    try {
      await onAudioOutputDeviceChange(deviceId);
    } catch (err) {
      // Speaker switch failed
    }
  };

  const playSpeakerTest = useCallback(async () => {
    const audio = speakerTestAudioRef.current || new Audio();
    speakerTestAudioRef.current = audio;
    if (!speakerTestUrlRef.current) {
      speakerTestUrlRef.current = URL.createObjectURL(createSpeakerTestToneBlob());
    }

    try {
      audio.pause();
      audio.currentTime = 0;
      audio.src = speakerTestUrlRef.current;
      audio.onended = () => setSpeakerTestPlaying(false);
      audio.onerror = () => setSpeakerTestPlaying(false);
      setSpeakerTestPlaying(true);
      await applyAudioOutput(audio);
      await audio.play();
    } catch (err) {
      setSpeakerTestPlaying(false);
    }
  }, [applyAudioOutput]);

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingWrap}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Looking for {inviteStudioName || 'studio'}...</p>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.errorIcon}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
          </div>
          <h2 style={styles.cardTitle}>Studio not found</h2>
          <p style={styles.text}>
            {inviteStudioName
              ? `${inviteStudioName} does not exist or has already ended.`
              : "This session doesn't exist or has already ended."}
          </p>
          <button className="btn-primary" style={styles.joinButton} onClick={() => navigate('/')}>
            Go to homepage
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.bgGlow} />

      <div style={styles.card}>
        {/* Studio info badge */}
        <div style={styles.studioInfo}>
          <div style={{
            ...styles.liveDot,
            background: roomInfo?.status === 'scheduled' ? '#f59e0b' : 'var(--accent)',
          }} />
          <span style={styles.studioName}>{roomInfo?.name}</span>
          {roomInfo?.status === 'scheduled' && (
            <span style={styles.scheduledBadge}>Scheduled</span>
          )}
          {roomInfo?.passwordProtected && (
            <span style={styles.scheduledBadge}>Password</span>
          )}
          {hostEntryMode && (
            <span style={styles.scheduledBadge}>Host</span>
          )}
          {isCoHostInvite && (
            <span style={styles.scheduledBadge}>Co-host</span>
          )}
          {isSecureGuestInvite && (
            <span style={styles.scheduledBadge}>Secure guest</span>
          )}
        </div>

        <h2 style={styles.cardTitle}>You're invited</h2>
        <p style={styles.text}>
          {hostAccessMissing
            ? HOST_ACCESS_MISSING_MESSAGE
            : isHostSession
            ? `Hosted by ${roomInfo?.hostName || savedHostStudio?.hostName || 'you'}`
            : roomInfo?.status === 'scheduled'
            ? `Hosted by ${roomInfo?.hostName || 'the organizer'}. Enter your name to join when the session starts.`
            : isCoHostInvite
              ? 'You were invited as a co-host'
              : isSecureGuestInvite
                ? 'You were invited with a secure guest link'
              : roomInfo?.participantCount === 0
              ? 'Be the first to join this studio'
              : `${roomInfo?.participantCount} participant${roomInfo?.participantCount !== 1 ? 's' : ''} already here`}
        </p>
        {roomInfo?.scheduledFor && (
          <p style={styles.scheduleText}>
            {new Date(roomInfo.scheduledFor).toLocaleString([], {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        )}
        {scheduledGuestBlocked && (
          <div style={styles.guestOpenNotice}>
            <strong>Guest access opens {guestOpenLabel}</strong>
            <span>Hosts and co-hosts can enter now to prepare the studio.</span>
            <span>{guestOpenCountdown} remaining</span>
            {registrationRequired && registrationSubmitted && (
              <span>You're registered. Keep this link and return when access opens.</span>
            )}
          </div>
        )}
        {hostAccessMissing && (
          <div style={styles.hostAccessNotice}>
            <strong>Use a host entry</strong>
            <span>The guest invite link cannot prove host ownership by name alone.</span>
            <button style={styles.hostAccessAction} onClick={() => navigate('/')}>
              Open Your Studios
            </button>
          </div>
        )}

        {/* Camera Preview */}
        <div style={styles.previewContainer}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{
              ...styles.previewVideo,
              ...(videoEnabled ? {} : { display: 'none' }),
            }}
          />
          {!videoEnabled && (
            <div style={styles.previewOff}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
              <span style={styles.previewOffText}>Camera off</span>
            </div>
          )}

          {/* Audio level indicator */}
          {audioEnabled && (
            <div style={styles.audioLevelWrap}>
              <div style={styles.audioLevelTrack}>
                <div
                  style={{
                    ...styles.audioLevelFill,
                    width: `${Math.max(4, audioLevel * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* AV toggle buttons */}
        <div style={styles.toggleRow}>
          <button
            style={{
              ...styles.toggleBtn,
              ...(audioEnabled ? styles.toggleBtnOn : styles.toggleBtnOff),
            }}
            onClick={toggleAudio}
            title={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
            aria-label="Toggle microphone"
          >
            {audioEnabled ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            )}
          </button>
          <button
            style={{
              ...styles.toggleBtn,
              ...(videoEnabled ? styles.toggleBtnOn : styles.toggleBtnOff),
            }}
            onClick={toggleVideo}
            title={videoEnabled ? 'Turn off camera' : 'Turn on camera'}
            aria-label="Toggle camera"
          >
            {videoEnabled ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </button>
        </div>

        {/* Device selectors */}
        <div style={styles.deviceSelectors}>
          {audioDevices.length > 0 && (
            <div style={styles.deviceField}>
              <label style={styles.deviceLabel}>Microphone</label>
              <select
                style={styles.deviceSelect}
                value={selectedAudioDeviceId}
                onChange={(e) => onAudioDeviceChange(e.target.value)}
              >
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            </div>
          )}
          {videoDevices.length > 0 && (
            <div style={styles.deviceField}>
              <label style={styles.deviceLabel}>Camera</label>
              <select
                style={styles.deviceSelect}
                value={selectedVideoDeviceId}
                onChange={(e) => onVideoDeviceChange(e.target.value)}
              >
                {videoDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                ))}
              </select>
            </div>
          )}
          {videoDevices.length > 0 && (
            <div style={styles.deviceField}>
              <label style={styles.deviceLabel}>Camera Quality</label>
              <div style={styles.qualityGrid} role="group" aria-label="Camera quality">
                {VIDEO_QUALITY_PRESETS.map((preset) => {
                  const active = preset.id === videoQuality;
                  const recommended = preset.id === recommendedVideoQuality;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      style={{
                        ...styles.qualityButton,
                        ...(active ? styles.qualityButtonActive : {}),
                      }}
                      onClick={() => onVideoQualityChange(preset.id)}
                      aria-pressed={active}
                    >
                      <span style={styles.qualityButtonLabelRow}>
                        <span style={styles.qualityButtonLabel}>{preset.label}</span>
                        {recommended && <span style={styles.qualityButtonBadge}>Suggested</span>}
                      </span>
                      <span style={styles.qualityButtonText}>{preset.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {audioOutputDevices.length > 0 && (
            <div style={styles.deviceField}>
              <label style={styles.deviceLabel}>Speaker</label>
              <div style={styles.speakerControlRow}>
                <select
                  style={{ ...styles.deviceSelect, ...styles.speakerSelect }}
                  value={selectedAudioOutputDeviceId}
                  onChange={(e) => onSpeakerDeviceChange(e.target.value)}
                >
                  <option value="">System default</option>
                  {audioOutputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  style={{
                    ...styles.speakerTestButton,
                    ...(speakerTestPlaying ? styles.speakerTestButtonActive : {}),
                  }}
                  onClick={() => void playSpeakerTest()}
                  disabled={speakerTestPlaying}
                  title="Play speaker test sound"
                  aria-label="Play speaker test sound"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                  {speakerTestPlaying ? 'Playing' : 'Test'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Advanced Audio Options */}
        <div style={styles.advancedAudio}>
          <label style={styles.deviceLabel}>Audio Settings</label>
          <div style={styles.checkboxRow}>
            <label style={styles.checkboxLabel}>
              <input type="checkbox" checked={echoCancellation} onChange={(e) => setEchoCancellation(e.target.checked)} />
              Echo Cancellation
            </label>
            <label style={styles.checkboxLabel}>
              <input type="checkbox" checked={noiseSuppression} onChange={(e) => setNoiseSuppression(e.target.checked)} />
              Noise Suppression
            </label>
            <label style={styles.checkboxLabel}>
              <input type="checkbox" checked={voiceIsolation} onChange={(e) => setVoiceIsolation(e.target.checked)} />
              Studio Voice Cleanup
            </label>
          </div>
        </div>

        {/* Name input */}
        <div style={styles.field}>
          <label style={styles.label}>Your name</label>
          <input
            style={styles.input}
            placeholder="Enter your name"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && joinStudio()}
            autoFocus
            maxLength={50}
          />
        </div>

        {registrationRequired && (
          <div style={styles.registrationBox}>
            <div style={styles.registrationHeader}>
              <span style={styles.registrationTitle}>Webinar registration</span>
              {registrationSubmitted && <span style={styles.registrationBadge}>Registered</span>}
            </div>
            <p style={styles.registrationText}>
              {registrationSubmitted
                ? 'Your spot is saved for this studio.'
                : 'Enter your email so the host can manage this scheduled guest list.'}
            </p>
            {!registrationSubmitted && (
              <input
                style={styles.input}
                type="email"
                placeholder="name@example.com"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && joinStudio()}
                maxLength={254}
                autoComplete="email"
              />
            )}
            {registrationError && (
              <p style={styles.registrationError}>{registrationError}</p>
            )}
          </div>
        )}

        {needsRoomPassword && (
          <div style={styles.field}>
            <label style={styles.label}>Room password</label>
            <input
              style={styles.input}
              type="password"
              placeholder="Enter room password"
              value={roomPassword}
              onChange={(e) => setRoomPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && joinStudio()}
              maxLength={100}
              autoComplete="current-password"
            />
          </div>
        )}

        <button
          className="btn-primary"
          style={styles.joinButton}
          onClick={joinStudio}
          disabled={joinDisabled}
        >
          {joinButtonLabel}
        </button>

        <p style={styles.finePrint}>No account or download required</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: 24,
    position: 'relative',
  },
  bgGlow: {
    position: 'absolute',
    top: '30%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 500,
    height: 500,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(103, 232, 249, 0.05) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
    padding: '32px 28px',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    position: 'relative',
    zIndex: 1,
    animation: 'scaleIn 0.3s ease-out',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  studioInfo: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px',
    background: 'rgba(167, 139, 250, 0.1)',
    borderRadius: 20,
    marginBottom: 16,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--accent)',
  },
  studioName: {
    fontSize: 13,
    fontWeight: 600,
    color: '#c4b5fd',
  },
  scheduledBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: '#f59e0b',
    background: 'rgba(245, 158, 11, 0.1)',
    padding: '2px 8px',
    borderRadius: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 6,
    letterSpacing: '-0.01em',
  },
  text: {
    color: 'var(--text-secondary)',
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 1.5,
  },
  scheduleText: {
    color: 'var(--accent-hover)',
    fontSize: 13,
    fontWeight: 600,
    marginTop: -10,
    marginBottom: 16,
  },
  guestOpenNotice: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 14px',
    marginBottom: 16,
    border: '1px solid rgba(245, 158, 11, 0.32)',
    borderRadius: 10,
    background: 'rgba(245, 158, 11, 0.1)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    lineHeight: 1.4,
    textAlign: 'left',
  },
  hostAccessNotice: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'stretch',
    gap: 8,
    padding: '12px 14px',
    marginBottom: 16,
    border: '1px solid rgba(245, 158, 11, 0.32)',
    borderRadius: 10,
    background: 'rgba(245, 158, 11, 0.1)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    lineHeight: 1.4,
    textAlign: 'left',
  },
  hostAccessAction: {
    alignSelf: 'flex-start',
    border: '1px solid rgba(245, 158, 11, 0.42)',
    borderRadius: 8,
    background: 'rgba(245, 158, 11, 0.16)',
    color: '#fbbf24',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    padding: '7px 10px',
  },

  // Camera preview
  previewContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 14,
    overflow: 'hidden',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    marginBottom: 12,
  },
  previewVideo: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: 'scaleX(-1)',
  },
  previewOff: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    gap: 8,
  },
  previewOffText: {
    fontSize: 13,
    color: 'var(--text-muted)',
    fontWeight: 500,
  },

  // Audio level indicator
  audioLevelWrap: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
  },
  audioLevelTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    background: 'rgba(0, 0, 0, 0.4)',
    overflow: 'hidden',
  },
  audioLevelFill: {
    height: '100%',
    borderRadius: 2,
    background: 'var(--success)',
    transition: 'width 0.08s ease',
  },

  // Toggle buttons
  toggleRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 16,
  },
  toggleBtn: {
    width: 48,
    height: 48,
    borderRadius: '50%',
    border: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    transition: 'all 0.15s ease',
  },
  toggleBtnOn: {
    background: 'rgba(255, 255, 255, 0.06)',
    color: 'var(--text-primary)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  toggleBtnOff: {
    background: 'var(--danger)',
    color: 'white',
    borderColor: 'var(--danger)',
  },

  // Device selectors
  deviceSelectors: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    marginBottom: 16,
    textAlign: 'left' as const,
  },
  deviceField: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  deviceLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  deviceSelect: {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  qualityGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 6,
  },
  qualityButton: {
    minWidth: 0,
    minHeight: 58,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    padding: '7px 5px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
  qualityButtonActive: {
    background: 'rgba(124, 58, 237, 0.22)',
    borderColor: 'rgba(167, 139, 250, 0.62)',
    color: '#ede9fe',
  },
  qualityButtonLabel: {
    fontSize: 12,
    fontWeight: 900,
    lineHeight: 1.1,
  },
  qualityButtonLabelRow: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    flexWrap: 'wrap',
  },
  qualityButtonBadge: {
    maxWidth: '100%',
    padding: '1px 4px',
    borderRadius: 5,
    background: 'rgba(103, 232, 249, 0.12)',
    border: '1px solid rgba(103, 232, 249, 0.28)',
    color: '#a5f3fc',
    fontSize: 7,
    fontWeight: 900,
    lineHeight: 1.1,
    textTransform: 'uppercase' as const,
  },
  qualityButtonText: {
    fontSize: 8,
    lineHeight: 1.2,
    color: 'var(--text-muted)',
  },
  speakerControlRow: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 8,
  },
  speakerSelect: {
    flex: 1,
    minWidth: 0,
  },
  speakerTestButton: {
    minWidth: 86,
    borderRadius: 'var(--radius-sm)',
    border: '1px solid rgba(103, 232, 249, 0.26)',
    background: 'rgba(103, 232, 249, 0.08)',
    color: '#67e8f9',
    fontSize: 12,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    cursor: 'pointer',
    padding: '0 10px',
  },
  speakerTestButtonActive: {
    opacity: 0.78,
    cursor: 'wait',
  },
  
  advancedAudio: {
    marginBottom: 16,
    textAlign: 'left' as const,
    background: 'rgba(255,255,255,0.03)',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.05)',
  },
  checkboxRow: {
    display: 'flex',
    gap: 16,
    marginTop: 6,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },

  // Name field
  field: {
    marginBottom: 16,
    textAlign: 'left' as const,
  },
  label: {
    display: 'block',
    fontSize: 13,
    color: 'var(--text-secondary)',
    marginBottom: 6,
    fontWeight: 500,
  },
  input: {
    width: '100%',
  },
  registrationBox: {
    marginBottom: 16,
    padding: '12px 14px',
    borderRadius: 12,
    border: '1px solid rgba(103, 232, 249, 0.16)',
    background: 'rgba(103, 232, 249, 0.07)',
    textAlign: 'left' as const,
  },
  registrationHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 6,
  },
  registrationTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#a5f3fc',
  },
  registrationBadge: {
    fontSize: 10,
    fontWeight: 800,
    color: '#22c55e',
    background: 'rgba(34, 197, 94, 0.12)',
    border: '1px solid rgba(34, 197, 94, 0.2)',
    borderRadius: 999,
    padding: '3px 7px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  registrationText: {
    margin: '0 0 10px',
    color: 'var(--text-secondary)',
    fontSize: 12,
    lineHeight: 1.4,
  },
  registrationError: {
    margin: '8px 0 0',
    color: '#fca5a5',
    fontSize: 12,
    lineHeight: 1.35,
  },

  joinButton: {
    width: '100%',
    padding: '12px 20px',
    fontSize: 15,
    fontWeight: 600,
    borderRadius: 12,
  },
  finePrint: {
    marginTop: 14,
    fontSize: 12,
    color: 'var(--text-muted)',
  },

  // Loading / error
  loadingWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 16,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '2.5px solid rgba(255, 255, 255, 0.08)',
    borderTopColor: '#a78bfa',
    borderRadius: '50%',
    animation: 'spin 0.7s linear infinite',
  },
  loadingText: {
    color: 'var(--text-secondary)',
    fontSize: 14,
  },
  errorIcon: {
    marginBottom: 16,
  },
};
