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
  onOpenRecordingPanel?: () => void;
  onOpenProducerPanel?: () => void;
  onOpenWebinarQA?: () => void;
  onOpenChat?: () => void;
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
  onOpenRecordingPanel,
  onOpenProducerPanel,
  onOpenWebinarQA,
  onOpenChat,
  participantCount = 0,
  isLive = false,
}: ControlBarProps) {
  const [copied, setCopied] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const inviteLink = `${window.location.origin}/join/${roomId}`;

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Close "More" menu on outside click
  useEffect(() => {
    if (!showMore) return;
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && e.target instanceof Node && !moreRef.current.contains(e.target)) {
        setShowMore(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClick); };
  }, [showMore]);

  const copyInviteLink = () => {
    navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for browsers that don't support clipboard API
      try {
        const textArea = document.createElement('textarea');
        textArea.value = inviteLink;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setCopied(true);
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      } catch {
        console.warn('Failed to copy invite link to clipboard');
      }
    });
  };

  // Mic icon
  const micIcon = audioEnabled ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );

  // Camera icon
  const camIcon = videoEnabled ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );

  const chevronDown = (
    <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 8L1.5 3.5h9z" />
    </svg>
  );

  // ====== Guest Layout ======
  if (!isHost) {
    return (
      <div style={styles.bar}>
        <style>{focusStyles}</style>
        <div style={styles.barInner}>
          {/* Mic with device selector */}
          <div style={styles.mediaGroup}>
            <button
              className="cb-focusable"
              style={{ ...styles.mediaBtn, ...(audioEnabled ? {} : styles.mediaBtnOff) }}
              onClick={onToggleAudio}
              aria-label={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
              aria-pressed={audioEnabled}
              title={audioEnabled ? 'Mute' : 'Unmute'}
            >
              {micIcon}
            </button>
            <button
              className="cb-focusable"
              style={{ ...styles.chevronBtn, ...(audioEnabled ? {} : styles.chevronBtnOff) }}
              onClick={onOpenDeviceSettings}
              aria-label="Audio settings"
              title="Audio settings"
            >
              {chevronDown}
            </button>
          </div>

          {/* Camera with device selector */}
          <div style={styles.mediaGroup}>
            <button
              className="cb-focusable"
              style={{ ...styles.mediaBtn, ...(videoEnabled ? {} : styles.mediaBtnOff) }}
              onClick={onToggleVideo}
              aria-label={videoEnabled ? 'Turn camera off' : 'Turn camera on'}
              aria-pressed={videoEnabled}
              title={videoEnabled ? 'Camera off' : 'Camera on'}
            >
              {camIcon}
            </button>
            <button
              className="cb-focusable"
              style={{ ...styles.chevronBtn, ...(videoEnabled ? {} : styles.chevronBtnOff) }}
              onClick={onOpenDeviceSettings}
              aria-label="Camera settings"
              title="Camera settings"
            >
              {chevronDown}
            </button>
          </div>

          {/* Screen Share */}
          {onToggleScreenShare && (
            <button
              className="cb-focusable"
              style={{ ...styles.iconBtn, ...(isScreenSharing ? styles.iconBtnGreen : {}) }}
              onClick={onToggleScreenShare}
              aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
              aria-pressed={isScreenSharing}
              title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
          )}

          {/* Chat */}
          {onOpenChat && (
            <button
              className="cb-focusable"
              style={styles.iconBtn}
              onClick={onOpenChat}
              aria-label="Open chat"
              title="Chat"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}

          <div style={styles.sep} />

          {/* Leave */}
          <button className="cb-focusable" style={styles.endBtn} onClick={onLeave} aria-label="Leave studio">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Leave
          </button>
        </div>
      </div>
    );
  }

  // ====== Host Layout ======
  // Items for the "More" dropdown
  const moreItems: { label: string; icon: React.ReactNode; onClick: () => void }[] = [];
  if (onOpenMediaPanel) moreItems.push({
    label: 'Media',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
    onClick: () => { onOpenMediaPanel(); setShowMore(false); },
  });
  if (onOpenSoundBoard) moreItems.push({
    label: 'Sounds',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>,
    onClick: () => { onOpenSoundBoard(); setShowMore(false); },
  });
  if (onOpenBackgroundMusic) moreItems.push({
    label: 'Music',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
    onClick: () => { onOpenBackgroundMusic(); setShowMore(false); },
  });
  if (onOpenTeleprompter) moreItems.push({
    label: 'Script',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>,
    onClick: () => { onOpenTeleprompter(); setShowMore(false); },
  });
  if (onOpenRecordingPanel) moreItems.push({
    label: 'Local Rec',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
    onClick: () => { onOpenRecordingPanel(); setShowMore(false); },
  });
  if (onOpenProducerPanel) moreItems.push({
    label: 'Producer',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>,
    onClick: () => { onOpenProducerPanel(); setShowMore(false); },
  });
  if (onOpenWebinarQA) moreItems.push({
    label: 'Q&A',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>,
    onClick: () => { onOpenWebinarQA(); setShowMore(false); },
  });

  return (
    <div style={styles.bar}>
      <style>{focusStyles}</style>
      {/* Left: Media controls */}
      <div style={styles.leftGroup}>
        {/* Mic with device selector chevron */}
        <div style={styles.mediaGroup}>
          <button
            className="cb-focusable"
            style={{ ...styles.mediaBtn, ...(audioEnabled ? {} : styles.mediaBtnOff) }}
            onClick={onToggleAudio}
            aria-label={audioEnabled ? 'Mute microphone' : 'Unmute microphone'}
            aria-pressed={audioEnabled}
            title={audioEnabled ? 'Mute' : 'Unmute'}
          >
            {micIcon}
          </button>
          <button
            className="cb-focusable"
            style={{ ...styles.chevronBtn, ...(audioEnabled ? {} : styles.chevronBtnOff) }}
            onClick={onOpenDeviceSettings}
            aria-label="Audio settings"
            title="Audio settings"
          >
            {chevronDown}
          </button>
        </div>

        {/* Camera with device selector chevron */}
        <div style={styles.mediaGroup}>
          <button
            className="cb-focusable"
            style={{ ...styles.mediaBtn, ...(videoEnabled ? {} : styles.mediaBtnOff) }}
            onClick={onToggleVideo}
            aria-label={videoEnabled ? 'Turn camera off' : 'Turn camera on'}
            aria-pressed={videoEnabled}
            title={videoEnabled ? 'Camera off' : 'Camera on'}
          >
            {camIcon}
          </button>
          <button
            className="cb-focusable"
            style={{ ...styles.chevronBtn, ...(videoEnabled ? {} : styles.chevronBtnOff) }}
            onClick={onOpenDeviceSettings}
            aria-label="Camera settings"
            title="Camera settings"
          >
            {chevronDown}
          </button>
        </div>

        {/* Screen Share */}
        {onToggleScreenShare && (
          <button
            className="cb-focusable"
            style={{ ...styles.iconBtn, ...(isScreenSharing ? styles.iconBtnGreen : {}) }}
            onClick={onToggleScreenShare}
            aria-label={isScreenSharing ? 'Stop sharing screen' : 'Share screen'}
            aria-pressed={isScreenSharing}
            title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </button>
        )}
      </div>

      {/* Center: Essential actions */}
      <div style={styles.centerGroup}>
        {/* Record */}
        {onToggleRecording && (
          <button
            className="cb-focusable"
            style={{ ...styles.pill, ...(isRecording ? styles.pillRecording : {}) }}
            onClick={onToggleRecording}
            aria-label={isRecording ? 'Stop recording' : 'Start recording'}
            aria-pressed={isRecording}
            title={isRecording ? 'Stop recording' : 'Start recording'}
          >
            {isRecording ? (
              <span style={styles.recDot} />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="4" fill="currentColor" />
              </svg>
            )}
            {isRecording ? formattedTime : 'Record'}
          </button>
        )}

        {/* Invite */}
        <button
          className="cb-focusable"
          style={{ ...styles.pill, ...(copied ? styles.pillCopied : {}) }}
          onClick={copyInviteLink}
          aria-label="Copy invite link"
          title="Copy invite link"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <line x1="20" y1="8" x2="20" y2="14" />
            <line x1="23" y1="11" x2="17" y2="11" />
          </svg>
          {copied ? 'Copied!' : 'Invite'}
        </button>

        {/* Participants */}
        {onOpenParticipants && (
          <button className="cb-focusable" style={styles.pill} onClick={onOpenParticipants} aria-label={`Participants: ${participantCount}`} title="Participants">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span style={styles.pillBadge}>{participantCount}</span>
          </button>
        )}

        {/* More dropdown */}
        {moreItems.length > 0 && (
          <div ref={moreRef} style={{ position: 'relative' }}>
            <button
              className="cb-focusable"
              style={{ ...styles.pill, ...(showMore ? styles.pillActive : {}) }}
              onClick={() => setShowMore(!showMore)}
              aria-label="More tools"
              aria-expanded={showMore}
              title="More tools"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="5" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="12" cy="19" r="1.5" />
              </svg>
              More
            </button>
            {showMore && (
              <div style={styles.moreMenu} role="menu">
                {moreItems.map((item) => (
                  <button
                    key={item.label}
                    className="cb-focusable"
                    style={styles.moreItem}
                    onClick={item.onClick}
                    role="menuitem"
                    aria-label={item.label}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: Live + End */}
      <div style={styles.rightGroup}>
        {onOpenStreamDestinations && (
          <button
            className="cb-focusable"
            style={{ ...styles.liveBtn, ...(isLive ? styles.liveBtnActive : {}) }}
            onClick={onOpenStreamDestinations}
            aria-label={isLive ? 'Live: open stream destinations' : 'Go live: open stream destinations'}
          >
            {isLive && <span style={styles.liveDot} />}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 17a24.12 24.12 0 0 1 0-10M7 15a12 12 0 0 1 0-6" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <path d="M17 15a12 12 0 0 0 0-6M21.5 17a24.12 24.12 0 0 0 0-10" />
            </svg>
            {isLive ? 'LIVE' : 'Go Live'}
          </button>
        )}
        <button className="cb-focusable" style={styles.endBtn} onClick={onLeave} aria-label="End session">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          End
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
    padding: '6px 16px',
    background: 'rgba(15, 23, 42, 0.8)',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
    flexShrink: 0,
    gap: 12,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  barInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },

  leftGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  centerGroup: { display: 'flex', alignItems: 'center', gap: 4 },
  rightGroup: { display: 'flex', alignItems: 'center', gap: 8 },

  // Mic/Camera button group with chevron
  mediaGroup: {
    display: 'flex',
    alignItems: 'stretch',
    borderRadius: 22,
    overflow: 'hidden',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.06)',
  },
  mediaBtn: {
    width: 40,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    padding: 0,
    transition: 'all 0.12s ease',
  },
  mediaBtnOff: {
    background: 'var(--danger)',
    color: 'white',
  },
  chevronBtn: {
    width: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    borderLeft: '1px solid var(--border)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 0,
    transition: 'all 0.12s ease',
  },
  chevronBtnOff: {
    background: 'rgba(185, 28, 28, 0.8)',
    color: 'rgba(255,255,255,0.7)',
    borderLeftColor: 'rgba(255,255,255,0.2)',
  },

  // Standalone icon button (screen share)
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 22,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: 'var(--text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    transition: 'all 0.15s ease',
  },
  iconBtnGreen: {
    background: 'var(--success)',
    color: 'white',
    borderColor: 'var(--success)',
  },

  sep: {
    width: 1,
    height: 24,
    background: 'var(--border)',
    flexShrink: 0,
  },

  // Pill buttons
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 20,
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-secondary)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap' as const,
  },
  pillActive: {
    background: 'var(--accent-subtle)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  pillRecording: {
    background: 'rgba(239, 68, 68, 0.15)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
    color: '#ef4444',
    fontFamily: 'monospace',
    fontWeight: 600,
  },
  pillCopied: {
    background: 'var(--success-subtle)',
    borderColor: 'rgba(34, 197, 94, 0.25)',
    color: 'var(--success)',
  },
  pillBadge: {
    fontSize: 10,
    fontWeight: 700,
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    padding: '1px 5px',
    borderRadius: 8,
    lineHeight: '14px',
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#ef4444',
    animation: 'livePulse 1.5s infinite',
    flexShrink: 0,
  },

  // More dropdown menu
  moreMenu: {
    position: 'absolute',
    bottom: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    marginBottom: 6,
    background: 'rgba(15, 23, 42, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    padding: 4,
    minWidth: 140,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 1,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  moreItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    background: 'none',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'background 0.1s',
    textAlign: 'left' as const,
    width: '100%',
  },

  // Live button
  liveBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 20,
    background: 'var(--accent-solid)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    boxShadow: '0 0 12px rgba(167, 139, 250, 0.2)',
  },
  liveBtnActive: {
    background: '#ef4444',
    boxShadow: '0 0 0 3px rgba(239, 68, 68, 0.2)',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'white',
    animation: 'livePulse 1.5s infinite',
    flexShrink: 0,
  },

  // End button (host)
  endBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 20,
    background: 'var(--danger)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.12s ease',
  },
};

const focusStyles = `
  .cb-focusable:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .cb-focusable:hover:not(:disabled) {
    transform: translateY(-1px);
    filter: brightness(1.2);
  }
  .cb-focusable:active:not(:disabled) {
    transform: translateY(1px);
    filter: brightness(0.9);
  }
`;
