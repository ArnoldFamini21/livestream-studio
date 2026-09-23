import { useEffect, useState, type CSSProperties } from 'react';
import {
  YOUTUBE_DESCRIPTION_MAX_LENGTH,
  YOUTUBE_TITLE_MAX_LENGTH,
  authorizeYouTube,
  createYouTubeLiveBroadcast,
  prepareYouTubeConnection,
  type YouTubeConnectedBroadcast,
  type YouTubeLatencyPreference,
  type YouTubePrivacyStatus,
} from '../utils/youtubeLiveBroadcast.ts';

const PRIVACY_OPTIONS: Array<{ value: YouTubePrivacyStatus; label: string }> = [
  { value: 'public', label: 'Public' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'private', label: 'Private' },
];

/**
 * StreamYard-style YouTube connection: sign in, describe the broadcast, and
 * the studio creates it with its stream key. The broadcast goes live on
 * YouTube automatically when the studio starts streaming.
 */
export function YouTubeConnectForm({ defaultTitle, disabled, onCreated, onUseStreamKey }: {
  defaultTitle: string;
  disabled?: boolean;
  onCreated: (broadcast: YouTubeConnectedBroadcast) => void;
  onUseStreamKey: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle.slice(0, YOUTUBE_TITLE_MAX_LENGTH));
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<YouTubePrivacyStatus>('public');
  const [latency, setLatency] = useState<YouTubeLatencyPreference>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Load Google sign-in ahead of the click so the popup opens from the user's gesture.
  useEffect(() => {
    void prepareYouTubeConnection().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Google sign-in could not load.');
    });
  }, []);

  const create = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      const token = await authorizeYouTube();
      const broadcast = await createYouTubeLiveBroadcast(
        { title, description, privacyStatus: privacy, latencyPreference: latency },
        { token }
      );
      onCreated(broadcast);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'YouTube could not create the broadcast.');
    } finally {
      setBusy(false);
    }
  };

  return <div style={styles.wrap}>
    <p style={styles.lead}>Sign in once and the studio creates the YouTube broadcast and its stream key. YouTube goes live when you do.</p>
    <label style={styles.field}>
      <span style={styles.label}>Title</span>
      <input style={styles.input} value={title} maxLength={YOUTUBE_TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} />
    </label>
    <label style={styles.field}>
      <span style={styles.label}>Description (optional)</span>
      <textarea style={{ ...styles.input, minHeight: 64, resize: 'vertical' }} value={description} maxLength={YOUTUBE_DESCRIPTION_MAX_LENGTH} onChange={(event) => setDescription(event.target.value)} />
    </label>
    <div style={styles.row}>
      <label style={{ ...styles.field, flex: 1 }}>
        <span style={styles.label}>Visibility</span>
        <select style={styles.input} value={privacy} onChange={(event) => setPrivacy(event.target.value as YouTubePrivacyStatus)}>
          {PRIVACY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label style={{ ...styles.field, flex: 1 }} title="Normal gives viewers the best quality; Low shortens the delay for live chat.">
        <span style={styles.label}>Latency</span>
        <select style={styles.input} value={latency} onChange={(event) => setLatency(event.target.value as YouTubeLatencyPreference)}>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </label>
    </div>
    {error && <div style={styles.error} role="alert">{error}</div>}
    <div style={styles.actions}>
      <button type="button" className="btn-ghost" style={styles.linkButton} onClick={onUseStreamKey}>Use a stream key instead</button>
      <button type="button" className="btn-primary" style={styles.primary} disabled={disabled || busy || !title.trim()} onClick={() => void create()}>
        {busy ? 'Creating broadcast…' : 'Sign in & create broadcast'}
      </button>
    </div>
  </div>;
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 10 },
  lead: { margin: 0, fontSize: 11, lineHeight: 1.45, color: 'var(--text-secondary)' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' },
  input: { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box', font: 'inherit' },
  row: { display: 'flex', gap: 8 },
  error: { fontSize: 11, color: '#fca5a5', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: 6, padding: '7px 9px', lineHeight: 1.35 },
  actions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 2 },
  linkButton: { fontSize: 11, padding: '6px 4px' },
  primary: { fontSize: 12, padding: '7px 14px', background: '#FF0000', borderColor: '#FF0000' },
};
