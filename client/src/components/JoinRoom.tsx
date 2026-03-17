import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || '';

export function JoinRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [guestName, setGuestName] = useState('');
  const [roomInfo, setRoomInfo] = useState<{ name: string; participantCount: number; status?: string; hostName?: string; scheduledFor?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

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
    sessionStorage.setItem('userName', guestName);
    sessionStorage.setItem('userRole', 'guest');
    navigate(`/studio/${roomId}`);
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
          <button className="btn-primary" style={styles.button} onClick={() => navigate('/')}>
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
          style={styles.button}
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
  },
  bgGlow: {
    position: 'absolute',
    top: '30%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 400,
    height: 400,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(124, 58, 237, 0.06) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  card: {
    background: 'var(--bg-secondary)',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-lg)',
    padding: '32px 28px',
    width: '100%',
    maxWidth: 400,
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
    marginBottom: 20,
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
  cardTitle: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 6,
    letterSpacing: '-0.01em',
  },
  text: {
    color: 'var(--text-secondary)',
    fontSize: 14,
    marginBottom: 24,
    lineHeight: 1.5,
  },
  field: {
    marginBottom: 16,
    textAlign: 'left',
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
  },
  finePrint: {
    marginTop: 14,
    fontSize: 12,
    color: 'var(--text-muted)',
  },
  loadingWrap: {
    display: 'flex',
    flexDirection: 'column',
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
};
