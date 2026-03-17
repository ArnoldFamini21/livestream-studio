import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMediaDevices } from '../hooks/useMediaDevices.ts';

const API_URL = import.meta.env.VITE_API_URL || '';

export function JoinRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [guestName, setGuestName] = useState('');
  const [roomInfo, setRoomInfo] = useState<{ name: string; participantCount: number; status?: string; hostName?: string; scheduledFor?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

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
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    switchAudioDevice,
    switchVideoDevice,
  } = useMediaDevices();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const [audioLevel, setAudioLevel] = useState(0);

  // Start camera preview on mount
  useEffect(() => {
    startMedia();
    return () => {
      stopMedia();
    };
  }, [startMedia, stopMedia]);

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
        const ctx = new AudioContext();
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
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
      audioContextRef.current = null;
      analyserRef.current = null;
    };
  }, [localStream, audioEnabled, updateAudioLevel]);

  // Fetch room info
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_URL}/api/rooms/${roomId}/exists`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then((data) => {
        setRoomInfo(data);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setNotFound(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [roomId]);

  const joinStudio = () => {
    if (!guestName.trim()) return;
    stopMedia();
    sessionStorage.setItem('userName', guestName);
    sessionStorage.setItem('userRole', 'guest');
    navigate(`/studio/${roomId}`);
  };

  const onAudioDeviceChange = async (deviceId: string) => {
    try {
      await switchAudioDevice(deviceId);
    } catch (err) {
      // Device switch failed
    }
  };

  const onVideoDeviceChange = async (deviceId: string) => {
    try {
      await switchVideoDevice(deviceId);
    } catch (err) {
      // Device switch failed
    }
  };

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingWrap}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Looking for studio...</p>
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
          <p style={styles.text}>This session doesn't exist or has already ended.</p>
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
        </div>

        <h2 style={styles.cardTitle}>You're invited</h2>
        <p style={styles.text}>
          {roomInfo?.status === 'scheduled'
            ? `Hosted by ${roomInfo?.hostName || 'the organizer'}. Enter your name to join when the session starts.`
            : roomInfo?.participantCount === 0
              ? 'Be the first to join this studio'
              : `${roomInfo?.participantCount} participant${roomInfo?.participantCount !== 1 ? 's' : ''} already here`}
        </p>

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
          />
        </div>

        <button
          className="btn-primary"
          style={styles.joinButton}
          onClick={joinStudio}
          disabled={!guestName.trim()}
        >
          Join Studio
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
    background: 'var(--bg-primary)',
  },
  bgGlow: {
    position: 'absolute',
    top: '30%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 500,
    height: 500,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(124, 58, 237, 0.08) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  card: {
    background: 'var(--bg-secondary)',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-lg)',
    padding: '32px 28px',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    position: 'relative',
    zIndex: 1,
    animation: 'scaleIn 0.3s ease-out',
  },
  studioInfo: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px',
    background: 'var(--accent-subtle)',
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
    color: 'var(--accent-hover)',
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

  // Camera preview
  previewContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
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
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border-strong)',
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

  joinButton: {
    width: '100%',
    padding: '12px 20px',
    fontSize: 15,
    fontWeight: 600,
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
    border: '2.5px solid var(--border)',
    borderTopColor: 'var(--accent)',
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
