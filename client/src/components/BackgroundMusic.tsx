import { useState, useRef, useCallback, useEffect } from 'react';

interface BackgroundMusicProps {
  onClose: () => void;
}

interface Track {
  id: string;
  name: string;
  url: string;
  duration: number;
}

export function BackgroundMusic({ onClose }: BackgroundMusicProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(70);
  const [loop, setLoop] = useState(false);
  const [fadeEnabled, setFadeEnabled] = useState(false);
  const [fadeDuration, setFadeDuration] = useState(2);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fadeFrameRef = useRef<number | null>(null);
  const isFadingRef = useRef(false);

  // Keep a stable reference to the target volume for fades
  const targetVolumeRef = useRef(volume / 100);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Initialize audio element
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audioRef.current = audio;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => {
      if (!audio.loop) {
        setIsPlaying(false);
        setCurrentTime(0);
      }
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.pause();
      audio.src = '';
      if (fadeFrameRef.current !== null) {
        cancelAnimationFrame(fadeFrameRef.current);
      }
      // Revoke all blob URLs on unmount
      setTracks((prev) => {
        prev.forEach((t) => URL.revokeObjectURL(t.url));
        return [];
      });
    };
  }, []);

  // Sync loop
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.loop = loop;
    }
  }, [loop]);

  // Sync volume (when not fading)
  useEffect(() => {
    targetVolumeRef.current = volume / 100;
    if (audioRef.current && !isFadingRef.current) {
      audioRef.current.volume = volume / 100;
    }
  }, [volume]);

  // Fade helper
  const fadeAudio = useCallback(
    (from: number, to: number, durationSec: number, onComplete?: () => void) => {
      const audio = audioRef.current;
      if (!audio) return;

      if (fadeFrameRef.current !== null) {
        cancelAnimationFrame(fadeFrameRef.current);
      }

      isFadingRef.current = true;
      const startTime = performance.now();
      const durationMs = durationSec * 1000;

      const step = () => {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / durationMs, 1);
        // Ease in-out
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        audio.volume = from + (to - from) * eased;

        if (progress < 1) {
          fadeFrameRef.current = requestAnimationFrame(step);
        } else {
          audio.volume = to;
          isFadingRef.current = false;
          fadeFrameRef.current = null;
          onComplete?.();
        }
      };

      fadeFrameRef.current = requestAnimationFrame(step);
    },
    []
  );

  const loadTrack = useCallback(
    (track: Track) => {
      const audio = audioRef.current;
      if (!audio) return;

      // Stop current fade
      if (fadeFrameRef.current !== null) {
        cancelAnimationFrame(fadeFrameRef.current);
        fadeFrameRef.current = null;
        isFadingRef.current = false;
      }

      audio.src = track.url;
      audio.load();
      setCurrentTrackId(track.id);
      setCurrentTime(0);
      setDuration(track.duration || 0);
    },
    []
  );

  const playTrack = useCallback(
    (track?: Track) => {
      const audio = audioRef.current;
      if (!audio) return;

      if (track && track.id !== currentTrackId) {
        loadTrack(track);
      }

      if (fadeEnabled && fadeDuration > 0) {
        audio.volume = 0;
        audio.play().then(() => {
          fadeAudio(0, targetVolumeRef.current, fadeDuration);
        }).catch(() => {});
      } else {
        audio.volume = targetVolumeRef.current;
        audio.play().catch(() => {});
      }
      setIsPlaying(true);
    },
    [currentTrackId, fadeEnabled, fadeDuration, loadTrack, fadeAudio]
  );

  const pauseTrack = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (fadeEnabled && fadeDuration > 0) {
      fadeAudio(audio.volume, 0, fadeDuration, () => {
        audio.pause();
        setIsPlaying(false);
      });
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, [fadeEnabled, fadeDuration, fadeAudio]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) {
      pauseTrack();
    } else {
      const currentTrack = tracks.find((t) => t.id === currentTrackId);
      if (currentTrack) {
        playTrack();
      } else if (tracks.length > 0) {
        playTrack(tracks[0]);
      }
    }
  }, [isPlaying, pauseTrack, playTrack, tracks, currentTrackId]);

  const skipTrack = useCallback(
    (direction: 1 | -1) => {
      if (tracks.length === 0) return;
      const idx = tracks.findIndex((t) => t.id === currentTrackId);
      let nextIdx = idx + direction;
      if (nextIdx < 0) nextIdx = tracks.length - 1;
      if (nextIdx >= tracks.length) nextIdx = 0;
      playTrack(tracks[nextIdx]);
    },
    [tracks, currentTrackId, playTrack]
  );

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      Array.from(files).forEach((file) => {
        if (!file.type.startsWith('audio/')) return;

        const url = URL.createObjectURL(file);
        const name = file.name.replace(/\.[^/.]+$/, '');
        const id = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Get duration from a temporary audio element
        const tempAudio = new Audio();
        tempAudio.preload = 'metadata';
        tempAudio.src = url;
        tempAudio.addEventListener('loadedmetadata', () => {
          setTracks((prev) => [
            ...prev,
            { id, name, url, duration: tempAudio.duration },
          ]);
        });
        // Fallback if metadata doesn't load
        tempAudio.addEventListener('error', () => {
          setTracks((prev) => [...prev, { id, name, url, duration: 0 }]);
        });
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    []
  );

  const removeTrack = useCallback(
    (id: string) => {
      const track = tracks.find((t) => t.id === id);
      if (track) {
        URL.revokeObjectURL(track.url);
      }
      if (id === currentTrackId) {
        const audio = audioRef.current;
        if (audio) {
          audio.pause();
          audio.src = '';
        }
        setIsPlaying(false);
        setCurrentTrackId(null);
        setCurrentTime(0);
        setDuration(0);
      }
      setTracks((prev) => prev.filter((t) => t.id !== id));
    },
    [tracks, currentTrackId]
  );

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const currentTrack = tracks.find((t) => t.id === currentTrackId);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div style={styles.overlay} onClick={handleOverlayClick}>
      <div style={styles.panel}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span style={styles.headerTitle}>Background Music</span>
          </div>
          <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose} title="Close">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Now Playing */}
        {currentTrack && (
          <div style={styles.nowPlaying}>
            <div style={styles.nowPlayingIndicator}>
              {isPlaying && (
                <div style={styles.barsContainer}>
                  <div style={{ ...styles.bar, animationDelay: '0s' }} />
                  <div style={{ ...styles.bar, animationDelay: '0.15s' }} />
                  <div style={{ ...styles.bar, animationDelay: '0.3s' }} />
                </div>
              )}
              <span style={styles.nowPlayingLabel}>
                {isPlaying ? 'Now Playing' : 'Paused'}
              </span>
            </div>
            <div style={styles.nowPlayingName}>{currentTrack.name}</div>
            <div style={styles.timeRow}>
              <span style={styles.timeText}>{formatTime(currentTime)}</span>
              <div style={styles.progressBar}>
                <div
                  style={{
                    ...styles.progressFill,
                    width:
                      duration > 0
                        ? `${(currentTime / duration) * 100}%`
                        : '0%',
                  }}
                />
              </div>
              <span style={styles.timeText}>{formatTime(duration)}</span>
            </div>
          </div>
        )}

        {/* Transport Controls */}
        <div style={styles.transport}>
          <button
            style={styles.transportBtn}
            onClick={() => skipTrack(-1)}
            title="Previous"
            disabled={tracks.length === 0}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>
          <button
            style={{
              ...styles.playPauseBtn,
              background: tracks.length > 0 ? 'var(--accent)' : 'var(--bg-tertiary)',
              cursor: tracks.length > 0 ? 'pointer' : 'default',
            }}
            onClick={togglePlayPause}
            disabled={tracks.length === 0}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="white"
              >
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="white"
              >
                <polygon points="6 3 20 12 6 21 6 3" />
              </svg>
            )}
          </button>
          <button
            style={styles.transportBtn}
            onClick={() => skipTrack(1)}
            title="Next"
            disabled={tracks.length === 0}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>
          <div style={styles.transportDivider} />
          <button
            style={{
              ...styles.transportToggle,
              color: loop ? 'var(--accent)' : 'var(--text-muted)',
              background: loop ? 'var(--accent-subtle)' : 'transparent',
            }}
            onClick={() => setLoop((l) => !l)}
            title="Loop"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          </button>
        </div>

        {/* Volume */}
        <div style={styles.volumeRow}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            {volume > 0 && volume <= 50 && (
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            )}
            {volume > 50 && (
              <>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </>
            )}
          </svg>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={volume}
            onChange={(e) => setVolume(parseInt(e.target.value, 10))}
            style={styles.volumeSlider}
          />
          <span style={styles.volumeLabel}>{volume}%</span>
        </div>

        {/* Fade Controls */}
        <div style={styles.fadeSection}>
          <div style={styles.fadeSectionHeader}>
            <span style={styles.sectionLabel}>Fade</span>
            <button
              style={{
                ...styles.fadeToggle,
                background: fadeEnabled ? 'var(--accent)' : 'var(--bg-tertiary)',
                justifyContent: fadeEnabled ? 'flex-end' : 'flex-start',
              }}
              onClick={() => setFadeEnabled((f) => !f)}
              title={fadeEnabled ? 'Disable fade' : 'Enable fade'}
            >
              <div style={styles.fadeToggleKnob} />
            </button>
          </div>
          {fadeEnabled && (
            <div style={styles.fadeSliderRow}>
              <span style={styles.fadeLabel}>Duration</span>
              <input
                type="range"
                min="0"
                max="5"
                step="0.1"
                value={fadeDuration}
                onChange={(e) => setFadeDuration(parseFloat(e.target.value))}
                style={styles.volumeSlider}
              />
              <span style={styles.fadeValue}>{fadeDuration.toFixed(1)}s</span>
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={styles.divider} />

        {/* Track List */}
        <div style={styles.trackListSection}>
          <span style={styles.sectionLabel}>Tracks ({tracks.length})</span>
          {tracks.length === 0 ? (
            <div style={styles.emptyState}>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.5 }}
              >
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
              <span style={styles.emptyText}>
                Upload MP3 or WAV files to get started
              </span>
            </div>
          ) : (
            <div style={styles.trackList}>
              {tracks.map((track) => {
                const isCurrent = track.id === currentTrackId;
                const isActive = isCurrent && isPlaying;
                return (
                  <div
                    key={track.id}
                    className="participant-item"
                    style={{
                      ...styles.trackItem,
                      background: isCurrent
                        ? 'var(--accent-subtle)'
                        : 'var(--bg-tertiary)',
                      borderColor: isCurrent
                        ? 'var(--accent)'
                        : 'var(--border)',
                    }}
                  >
                    <button
                      style={styles.trackPlayBtn}
                      onClick={() => {
                        if (isActive) {
                          pauseTrack();
                        } else {
                          playTrack(track);
                        }
                      }}
                      title={isActive ? 'Pause' : 'Play'}
                    >
                      {isActive ? (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="var(--accent)"
                        >
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill={
                            isCurrent
                              ? 'var(--accent)'
                              : 'var(--text-muted)'
                          }
                        >
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                      )}
                    </button>
                    <div style={styles.trackInfo}>
                      <span
                        style={{
                          ...styles.trackName,
                          color: isCurrent
                            ? 'var(--accent)'
                            : 'var(--text-primary)',
                        }}
                      >
                        {track.name}
                      </span>
                      <span style={styles.trackDuration}>
                        {formatTime(track.duration)}
                      </span>
                    </div>
                    <button
                      style={styles.removeBtn}
                      onClick={() => removeTrack(track.id)}
                      title="Remove"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Upload */}
        <div style={styles.divider} />
        <div style={styles.uploadSection}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.wav,audio/mpeg,audio/wav"
            multiple
            onChange={handleFileUpload}
            style={styles.fileInput}
            id="bg-music-upload"
          />
          <label htmlFor="bg-music-upload" style={styles.uploadLabel}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Upload MP3 / WAV files</span>
          </label>
        </div>
      </div>

      {/* Keyframe animation for the "now playing" bars */}
      <style>{`
        @keyframes bgm-bar-bounce {
          0%, 100% { height: 3px; }
          50% { height: 12px; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(4px)',
  },
  panel: {
    width: 420,
    maxWidth: '92vw',
    maxHeight: '85vh',
    overflowY: 'auto',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-primary)',
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },

  // Now playing
  nowPlaying: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
  },
  nowPlayingIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  barsContainer: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 2,
    height: 12,
  },
  bar: {
    width: 3,
    borderRadius: 1,
    background: 'var(--accent)',
    animation: 'bgm-bar-bounce 0.6s ease-in-out infinite',
  },
  nowPlayingLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--accent)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  nowPlayingName: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 8,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  timeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  timeText: {
    fontSize: 10,
    fontWeight: 500,
    color: 'var(--text-muted)',
    minWidth: 30,
    fontVariantNumeric: 'tabular-nums',
  },
  progressBar: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    background: 'var(--bg-tertiary)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    background: 'var(--accent)',
    transition: 'width 0.3s linear',
  },

  // Transport
  transport: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
  },
  transportBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'var(--transition-fast)',
  },
  playPauseBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'var(--transition-fast)',
  },
  transportDivider: {
    width: 1,
    height: 20,
    background: 'var(--border)',
    margin: '0 4px',
  },
  transportToggle: {
    width: 32,
    height: 32,
    borderRadius: 8,
    border: '1px solid var(--border)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    transition: 'var(--transition-fast)',
  },

  // Volume
  volumeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-muted)',
  },
  volumeSlider: {
    flex: 1,
    height: 4,
    cursor: 'pointer',
    accentColor: 'var(--accent)',
  },
  volumeLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    minWidth: 32,
    textAlign: 'right' as const,
  },

  // Fade
  fadeSection: {
    padding: '10px 16px',
    borderBottom: '1px solid var(--border)',
  },
  fadeSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fadeToggle: {
    width: 36,
    height: 20,
    borderRadius: 10,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: 2,
    transition: 'var(--transition-fast)',
  },
  fadeToggleKnob: {
    width: 16,
    height: 16,
    borderRadius: 8,
    background: 'white',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    transition: 'var(--transition-fast)',
  },
  fadeSliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  fadeLabel: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    minWidth: 50,
  },
  fadeValue: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    minWidth: 30,
    textAlign: 'right' as const,
  },

  // Track list
  trackListSection: {
    padding: '12px 16px',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginBottom: 8,
    display: 'block',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '20px 0',
  },
  emptyText: {
    fontSize: 12,
    color: 'var(--text-muted)',
  },
  trackList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    maxHeight: 200,
    overflowY: 'auto' as const,
  },
  trackItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    transition: 'var(--transition-fast)',
  },
  trackPlayBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
  },
  trackInfo: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  trackName: {
    fontSize: 12,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  },
  trackDuration: {
    fontSize: 10,
    fontWeight: 500,
    color: 'var(--text-muted)',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
  },

  // Upload
  divider: {
    height: 1,
    background: 'var(--border)',
    margin: '0 16px',
  },
  uploadSection: {
    padding: '12px 16px 16px',
  },
  fileInput: {
    display: 'none',
  },
  uploadLabel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '12px',
    borderRadius: 8,
    border: '1px dashed var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'var(--transition-fast)',
  },
};
