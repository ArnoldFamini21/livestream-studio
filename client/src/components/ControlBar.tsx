import { useState, useRef, useEffect } from 'react';

interface ControlBarProps {
  audioEnabled: boolean;
  videoEnabled: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onLeave: () => void;
  onOpenDeviceSettings: () => void;
  roomId: string;
  isHost: boolean;
  // New actions
  isRecording?: boolean;
  formattedTime?: string;
  onToggleRecording?: () => void;
  isScreenSharing?: boolean;
  onToggleScreenShare?: () => void;
  onOpenParticipants?: () => void;
  onOpenStreamDestinations?: () => void;
  onOpenSoundBoard?: () => void;
  onOpenTeleprompter?: () => void;
  onOpenMediaPanel?: () => void;
  onOpenBackgroundMusic?: () => void;
  participantCount?: number;
  isLive?: boolean;
}

export function ControlBar({
  audioEnabled,
  videoEnabled,
  onToggleAudio,
  onToggleVideo,
  onLeave,
  onOpenDeviceSettings,
  roomId,
  isHost,
  isRecording = false,
  formattedTime = '0:00',
  onToggleRecording,
  isScreenSharing = false,
  onToggleScreenShare,
  onOpenParticipants,
  onOpenStreamDestinations,
  onOpenSoundBoard,
  onOpenTeleprompter,
  onOpenMediaPanel,
  onOpenBackgroundMusic,
  participantCount = 0,
  isLive = false,
}: ControlBarProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inviteLink = `${window.location.origin}/join/${roomId}`;

  // Clear the copied timeout on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const copyInviteLink = () => {
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard write failed (e.g. permissions denied)
    });
  };

  return (
    <div style={styles.bar}>
      {/* Left: Core controls */}
      <div style={styles.section}>
        {/* Mic */}
        <div style={styles.btnGroup}>
          <button
            className={`btn-icon ${!audioEnabled ? 'active' : ''}`}
            onClick={onToggleAudio}
            title={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
            aria-label="Toggle microphone"
            aria-pressed={audioEnabled}
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
          <span style={styles.btnLabel}>{audioEnabled ? 'Mic' : 'Muted'}</span>
        </div>

        {/* Camera */}
        <div style={styles.btnGroup}>
          <button
            className={`btn-icon ${!videoEnabled ? 'active' : ''}`}
            onClick={onToggleVideo}
            title={videoEnabled ? 'Turn off camera' : 'Turn on camera'}
            aria-label="Toggle camera"
            aria-pressed={videoEnabled}
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
          <span style={styles.btnLabel}>{videoEnabled ? 'Camera' : 'Off'}</span>
        </div>

        {/* Screen Share */}
        {onToggleScreenShare && (
          <div style={styles.btnGroup}>
            <button
              className={`btn-icon ${isScreenSharing ? 'active' : ''}`}
              onClick={onToggleScreenShare}
              title={isScreenSharing ? 'Stop screen share' : 'Share screen'}
              aria-label="Share screen"
              aria-pressed={isScreenSharing}
              style={isScreenSharing ? { background: '#22c55e', borderColor: '#22c55e' } : undefined}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
            <span style={styles.btnLabel}>{isScreenSharing ? 'Sharing' : 'Screen'}</span>
          </div>
        )}

        {/* Record */}
        {onToggleRecording && (
          <div style={styles.btnGroup}>
            <button
              className="btn-icon"
              onClick={onToggleRecording}
              title={isRecording ? 'Stop recording' : 'Start recording'}
              aria-label="Toggle recording"
              aria-pressed={isRecording}
              style={isRecording ? { background: '#ef4444', borderColor: '#ef4444', color: 'white' } : undefined}
            >
              {isRecording ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="4" fill="currentColor" />
                </svg>
              )}
            </button>
            <span style={{ ...styles.btnLabel, color: isRecording ? '#ef4444' : undefined }}>{isRecording ? formattedTime : 'Record'}</span>
          </div>
        )}

        {/* Settings */}
        <div style={styles.btnGroup}>
          <button
            className="btn-icon"
            onClick={onOpenDeviceSettings}
            title="Device settings"
            aria-label="Device settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <span style={styles.btnLabel}>Settings</span>
        </div>
      </div>

      {/* Center: Invite + Feature Buttons */}
      <div style={styles.section}>
        {isHost && (
          <button
            className="btn-secondary"
            style={styles.inviteBtn}
            onClick={copyInviteLink}
            aria-label="Copy invite link"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <line x1="20" y1="8" x2="20" y2="14" />
              <line x1="23" y1="11" x2="17" y2="11" />
            </svg>
            {copied ? 'Copied!' : 'Invite'}
          </button>
        )}

        {/* Participants */}
        {onOpenParticipants && isHost && (
          <button
            className="btn-secondary"
            style={styles.featureBtn}
            onClick={onOpenParticipants}
            title="Manage participants"
            aria-label="Show participants"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span style={styles.featureBadge}>{participantCount}</span>
          </button>
        )}

        {/* Media */}
        {onOpenMediaPanel && (
          <button
            className="btn-secondary"
            style={styles.featureBtn}
            onClick={onOpenMediaPanel}
            title="Share media"
            aria-label="Show media panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Media
          </button>
        )}

        {/* Sound Board */}
        {onOpenSoundBoard && (
          <button
            className="btn-secondary"
            style={styles.featureBtn}
            onClick={onOpenSoundBoard}
            title="Sound effects"
            aria-label="Sound effects"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
            </svg>
            Sounds
          </button>
        )}

        {/* Background Music */}
        {onOpenBackgroundMusic && (
          <button
            className="btn-secondary"
            style={styles.featureBtn}
            onClick={onOpenBackgroundMusic}
            title="Background music"
            aria-label="Background music"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            Music
          </button>
        )}

        {/* Teleprompter */}
        {onOpenTeleprompter && isHost && (
          <button
            className="btn-secondary"
            style={styles.featureBtn}
            onClick={onOpenTeleprompter}
            title="Teleprompter"
            aria-label="Teleprompter"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            Script
          </button>
        )}

        {/* Stream / Go Live */}
        {onOpenStreamDestinations && isHost && (
          <button
            className={isLive ? 'btn-danger' : 'btn-primary'}
            style={styles.streamBtn}
            onClick={onOpenStreamDestinations}
            aria-label={isLive ? 'Stop streaming' : 'Go live'}
          >
            {isLive && <span style={styles.liveDot} />}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 17a24.12 24.12 0 0 1 0-10M7 15a12 12 0 0 1 0-6" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <path d="M17 15a12 12 0 0 0 0-6M21.5 17a24.12 24.12 0 0 0 0-10" />
            </svg>
            {isLive ? 'LIVE' : 'Stream'}
          </button>
        )}
      </div>

      {/* Right: Leave */}
      <div style={styles.section}>
        <button className="btn-danger" style={styles.leaveBtn} onClick={onLeave} aria-label="Leave session">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {isHost ? 'End' : 'Leave'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    background: 'var(--bg-secondary)',
    borderTop: '1px solid var(--border)',
  },
  section: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  btnGroup: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
  },
  btnLabel: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontWeight: 500,
    letterSpacing: '0.02em',
  },
  inviteBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 12,
    fontWeight: 500,
    padding: '8px 14px',
  },
  featureBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 11,
    fontWeight: 500,
    padding: '7px 12px',
  },
  featureBadge: {
    fontSize: 10,
    fontWeight: 700,
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    padding: '1px 5px',
    borderRadius: 8,
  },
  streamBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 600,
    padding: '8px 16px',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'white',
    animation: 'livePulse 1.5s infinite',
  },
  leaveBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    padding: '9px 16px',
  },
};
