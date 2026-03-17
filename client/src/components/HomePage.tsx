import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || '';
const INVITE_BASE_URL = 'https://studio.arnoldfamini.com';

export function HomePage() {
  const [roomName, setRoomName] = useState('');
  const [hostName, setHostName] = useState('');
  const [loading, setLoading] = useState(false);
  const [schedulingLoading, setSchedulingLoading] = useState(false);
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);

  // Invite link modal state
  const [scheduledRoom, setScheduledRoom] = useState<{ id: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const createRoom = async () => {
    if (!roomName.trim() || !hostName.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, hostName }),
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        setError(`Failed to create room: ${res.status} ${errorText}`);
        return;
      }
      const room = await res.json();
      sessionStorage.setItem('userName', hostName);
      sessionStorage.setItem('userRole', 'host');
      navigate(`/studio/${room.id}`);
    } catch (err) {
      console.error('Failed to create room:', err);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const scheduleRoom = async () => {
    if (!roomName.trim() || !hostName.trim()) return;
    setSchedulingLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/rooms/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, hostName }),
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        setError(`Failed to schedule room: ${res.status} ${errorText}`);
        return;
      }
      const room = await res.json();
      setScheduledRoom({ id: room.id, name: room.name });
      setCopied(false);
    } catch (err) {
      console.error('Failed to schedule room:', err);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSchedulingLoading(false);
    }
  };

  const inviteLink = scheduledRoom ? `${INVITE_BASE_URL}/join/${scheduledRoom.id}` : '';

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-HTTPS contexts
      const textArea = document.createElement('textarea');
      textArea.value = inviteLink;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const goToStudioAsHost = () => {
    if (!scheduledRoom) return;
    sessionStorage.setItem('userName', hostName);
    sessionStorage.setItem('userRole', 'host');
    navigate(`/studio/${scheduledRoom.id}`);
  };

  const closeModal = () => {
    setScheduledRoom(null);
    setCopied(false);
    setRoomName('');
    setHostName('');
  };

  return (
    <div style={styles.page}>
      {/* Background glow effects */}
      <div style={styles.bgGlow1} />
      <div style={styles.bgGlow2} />

      <div style={styles.container}>
        {/* Logo / Brand */}
        <div style={styles.brand}>
          <div style={styles.logoMark}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="10" fill="url(#grad)" />
              <path d="M10 12L16 8L22 12V20L16 24L10 20V12Z" stroke="white" strokeWidth="1.5" fill="none" />
              <circle cx="16" cy="16" r="3" fill="white" />
              <defs>
                <linearGradient id="grad" x1="0" y1="0" x2="32" y2="32">
                  <stop stopColor="#a78bfa" />
                  <stop offset="1" stopColor="#67e8f9" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 style={styles.title}>Studio</h1>
        </div>

        <p style={styles.poweredBy}>
          Powered by{' '}
          <a href="https://arnoldfamini.com" target="_blank" rel="noopener noreferrer" style={styles.poweredByLink}>
            ArnoldFamini.com
          </a>
        </p>

        <p style={styles.tagline}>
          Professional live streaming & recording, right in your browser.
        </p>

        {/* Card */}
        <div style={styles.card}>
          <div style={styles.cardInner}>
            <h2 style={styles.cardTitle}>Create a studio</h2>
            <p style={styles.cardSub}>Set up your broadcast in seconds</p>

            <div style={styles.field}>
              <label style={styles.label}>Studio name</label>
              <input
                style={styles.input}
                placeholder="e.g. The Morning Show"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createRoom()}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Your name</label>
              <input
                style={styles.input}
                placeholder="How guests will see you"
                value={hostName}
                onChange={(e) => setHostName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createRoom()}
              />
            </div>

            {error && (
              <p style={styles.error}>{error}</p>
            )}

            <button
              className="btn-primary"
              style={styles.button}
              onClick={createRoom}
              disabled={loading || !roomName.trim() || !hostName.trim()}
            >
              {loading ? (
                <span style={styles.loadingInner}>
                  <span style={styles.loadingDot} />
                  Creating...
                </span>
              ) : (
                'Create Studio'
              )}
            </button>

            <div style={styles.divider}>
              <span style={styles.dividerLine} />
              <span style={styles.dividerText}>or</span>
              <span style={styles.dividerLine} />
            </div>

            <button
              style={styles.scheduleButton}
              onClick={scheduleRoom}
              disabled={schedulingLoading || !roomName.trim() || !hostName.trim()}
            >
              {schedulingLoading ? (
                <span style={styles.loadingInner}>
                  <span style={{ ...styles.loadingDot, background: 'var(--accent)' }} />
                  Scheduling...
                </span>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, flexShrink: 0 }}>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  Schedule & Get Invite Link
                </>
              )}
            </button>
          </div>
        </div>

        <p style={styles.hint}>
          Have an invite link? Just open it to join as a guest -- no sign-up needed.
        </p>

        <div style={styles.legalLinks}>
          <Link to="/privacy" style={styles.legalLink}>Privacy Policy</Link>
          <span style={styles.legalSep}>|</span>
          <Link to="/terms" style={styles.legalLink}>Terms of Service</Link>
        </div>
      </div>

      {/* Invite Link Modal */}
      {scheduledRoom && (
        <div style={styles.modalOverlay} onClick={closeModal}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <button style={styles.modalClose} onClick={closeModal}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>

            <div style={styles.modalIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>

            <h3 style={styles.modalTitle}>Studio Scheduled</h3>
            <p style={styles.modalSub}>
              <strong>{scheduledRoom.name}</strong> is ready. Share this invite link with your guests.
            </p>

            <div style={styles.linkBox}>
              <input
                style={styles.linkInput}
                value={inviteLink}
                readOnly
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button style={styles.copyButton} onClick={copyToClipboard}>
                {copied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div style={styles.modalActions}>
              <button
                className="btn-primary"
                style={styles.modalStartButton}
                onClick={goToStudioAsHost}
              >
                Start Studio Now
              </button>
              <button style={styles.modalDoneButton} onClick={closeModal}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
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
    overflow: 'hidden',
  },
  bgGlow1: {
    position: 'absolute',
    top: '-20%',
    left: '-10%',
    width: 600,
    height: 600,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(167, 139, 250, 0.06) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  bgGlow2: {
    position: 'absolute',
    bottom: '-30%',
    right: '-10%',
    width: 500,
    height: 500,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(103, 232, 249, 0.04) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '100%',
    maxWidth: 420,
    position: 'relative',
    zIndex: 1,
    animation: 'slideUp 0.5s ease-out',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  logoMark: {
    display: 'flex',
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--text-primary)',
  },
  poweredBy: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 8,
    textAlign: 'center',
    opacity: 0.7,
    letterSpacing: '0.03em',
  } as React.CSSProperties,
  poweredByLink: {
    color: '#67e8f9',
    textDecoration: 'none',
    fontWeight: 500,
  } as React.CSSProperties,
  tagline: {
    fontSize: 15,
    color: 'var(--text-secondary)',
    marginBottom: 36,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  card: {
    width: '100%',
    background: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
    overflow: 'hidden',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  cardInner: {
    padding: '28px 28px 32px',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 4,
    letterSpacing: '-0.01em',
    color: 'rgba(226, 232, 240, 0.92)',
  },
  cardSub: {
    fontSize: 13,
    color: 'var(--text-muted)',
    marginBottom: 24,
  },
  field: {
    marginBottom: 16,
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
  button: {
    width: '100%',
    padding: '12px 20px',
    fontSize: 15,
    fontWeight: 600,
    marginTop: 8,
    letterSpacing: '-0.01em',
    borderRadius: 12,
  },
  loadingInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'white',
    animation: 'pulse 1s infinite',
  },
  error: {
    fontSize: 13,
    color: '#ef4444',
    marginTop: 0,
    marginBottom: 8,
    lineHeight: 1.4,
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '16px 0',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: 'rgba(255, 255, 255, 0.06)',
  },
  dividerText: {
    fontSize: 12,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  scheduleButton: {
    width: '100%',
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    background: 'transparent',
    color: '#67e8f9',
    border: '1.5px solid rgba(103, 232, 249, 0.3)',
    borderRadius: 12,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.18s ease',
    letterSpacing: '-0.01em',
  },
  hint: {
    marginTop: 20,
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center',
  },

  // Modal styles
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 24,
    animation: 'fadeIn 0.2s ease-out',
  },
  modal: {
    background: 'rgba(15, 23, 42, 0.95)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.45)',
    padding: '32px 28px',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    position: 'relative',
    animation: 'scaleIn 0.3s ease-out',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  modalClose: {
    position: 'absolute',
    top: 12,
    right: 12,
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    borderRadius: 6,
  },
  modalIcon: {
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 8,
    letterSpacing: '-0.01em',
  },
  modalSub: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    marginBottom: 24,
    lineHeight: 1.5,
  },
  linkBox: {
    display: 'flex',
    gap: 8,
    marginBottom: 24,
  },
  linkInput: {
    flex: 1,
    fontSize: 13,
    padding: '10px 12px',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  copyButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    background: 'var(--accent-solid)',
    color: 'white',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background 0.18s ease',
  },
  modalActions: {
    display: 'flex',
    gap: 10,
  },
  modalStartButton: {
    flex: 1,
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    borderRadius: 12,
  },
  modalDoneButton: {
    flex: 1,
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-secondary)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'all 0.18s ease',
  },
  legalLinks: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 16,
  },
  legalLink: {
    fontSize: 12,
    color: 'var(--text-muted)',
    textDecoration: 'none',
    opacity: 0.7,
  },
  legalSep: {
    fontSize: 12,
    color: 'var(--text-muted)',
    opacity: 0.4,
  },
};
