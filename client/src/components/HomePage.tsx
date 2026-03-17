import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || '';

export function HomePage() {
  const [roomName, setRoomName] = useState('');
  const [hostName, setHostName] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);

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
              <rect width="32" height="32" rx="8" fill="url(#grad)" />
              <path d="M10 12L16 8L22 12V20L16 24L10 20V12Z" stroke="white" strokeWidth="1.5" fill="none" />
              <circle cx="16" cy="16" r="3" fill="white" />
              <defs>
                <linearGradient id="grad" x1="0" y1="0" x2="32" y2="32">
                  <stop stopColor="#7c3aed" />
                  <stop offset="1" stopColor="#a78bfa" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 style={styles.title}>Studio</h1>
        </div>

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
          </div>
        </div>

        <p style={styles.hint}>
          Have an invite link? Just open it to join as a guest — no sign-up needed.
        </p>
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
    overflow: 'hidden',
  },
  bgGlow1: {
    position: 'absolute',
    top: '-20%',
    left: '-10%',
    width: 600,
    height: 600,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(124, 58, 237, 0.08) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  bgGlow2: {
    position: 'absolute',
    bottom: '-30%',
    right: '-10%',
    width: 500,
    height: 500,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(124, 58, 237, 0.05) 0%, transparent 70%)',
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
  tagline: {
    fontSize: 15,
    color: 'var(--text-secondary)',
    marginBottom: 36,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  card: {
    width: '100%',
    background: 'var(--bg-secondary)',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden',
  },
  cardInner: {
    padding: '28px 28px 32px',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 4,
    letterSpacing: '-0.01em',
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
  hint: {
    marginTop: 20,
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center',
  },
};
