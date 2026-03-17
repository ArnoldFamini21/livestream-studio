import { useState } from 'react';
import type { StreamDestination } from '@studio/shared';

interface StreamDestinationsProps {
  destinations: StreamDestination[];
  onAdd: (dest: Omit<StreamDestination, 'id' | 'status'>) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  isLive: boolean;
  onGoLive: () => void;
  onStopLive: () => void;
  onClose: () => void;
}

const PLATFORMS: Array<{ value: StreamDestination['platform']; label: string; color: string }> = [
  { value: 'youtube', label: 'YouTube', color: '#FF0000' },
  { value: 'facebook', label: 'Facebook', color: '#1877F2' },
  { value: 'twitch', label: 'Twitch', color: '#9146FF' },
  { value: 'linkedin', label: 'LinkedIn', color: '#0A66C2' },
  { value: 'instagram', label: 'Instagram', color: '#E4405F' },
  { value: 'custom', label: 'Custom RTMP', color: '#71717a' },
];

export function StreamDestinations({
  destinations,
  onAdd,
  onRemove,
  onToggle,
  isLive,
  onGoLive,
  onStopLive,
  onClose,
}: StreamDestinationsProps) {
  const [showForm, setShowForm] = useState(false);
  const [platform, setPlatform] = useState<StreamDestination['platform']>('youtube');
  const [name, setName] = useState('');
  const [rtmpUrl, setRtmpUrl] = useState('');
  const [streamKey, setStreamKey] = useState('');

  const handleAdd = () => {
    if (!streamKey.trim()) return;
    const platformInfo = PLATFORMS.find((p) => p.value === platform);
    onAdd({
      platform,
      name: name.trim() || platformInfo?.label || 'Stream',
      rtmpUrl: rtmpUrl.trim() || getDefaultRtmpUrl(platform),
      streamKey: streamKey.trim(),
      enabled: true,
    });
    setShowForm(false);
    setName('');
    setRtmpUrl('');
    setStreamKey('');
  };

  const enabledCount = destinations.filter((d) => d.enabled).length;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Stream Destinations</h3>
          <p style={styles.subtitle}>{destinations.length} destination{destinations.length !== 1 ? 's' : ''} configured</p>
        </div>
        <button style={styles.closeBtn} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        {/* Destinations list */}
        {destinations.map((dest) => {
          const platformInfo = PLATFORMS.find((p) => p.value === dest.platform);
          return (
            <div key={dest.id} style={styles.destCard}>
              <div style={styles.destHeader}>
                <div style={{ ...styles.platformDot, background: platformInfo?.color }} />
                <div style={styles.destInfo}>
                  <span style={styles.destName}>{dest.name}</span>
                  <span style={styles.destPlatform}>{platformInfo?.label}</span>
                </div>
                <div style={styles.destActions}>
                  <span style={{
                    ...styles.statusBadge,
                    background: dest.status === 'live' ? 'rgba(34,197,94,0.12)' : dest.status === 'error' ? 'rgba(239,68,68,0.12)' : 'var(--bg-surface)',
                    color: dest.status === 'live' ? '#22c55e' : dest.status === 'error' ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {dest.status}
                  </span>
                  <button
                    style={{ ...styles.toggleBtn, background: dest.enabled ? 'var(--success)' : 'var(--bg-surface)', color: dest.enabled ? 'white' : 'var(--text-muted)' }}
                    onClick={() => onToggle(dest.id)}
                  >
                    {dest.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button style={styles.removeBtn} onClick={() => onRemove(dest.id)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
              <div style={styles.destKey}>
                Key: {'*'.repeat(Math.min(dest.streamKey.length || 12, 20))}
              </div>
            </div>
          );
        })}

        {/* Add destination form */}
        {showForm ? (
          <div style={styles.form}>
            <div style={styles.platformGrid}>
              {PLATFORMS.map((p) => (
                <button
                  key={p.value}
                  style={{
                    ...styles.platformBtn,
                    borderColor: platform === p.value ? p.color : 'var(--border)',
                    background: platform === p.value ? p.color + '15' : 'var(--bg-tertiary)',
                    color: platform === p.value ? p.color : 'var(--text-secondary)',
                  }}
                  onClick={() => setPlatform(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input style={styles.input} placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            {platform === 'custom' && (
              <input style={styles.input} placeholder="RTMP URL" value={rtmpUrl} onChange={(e) => setRtmpUrl(e.target.value)} />
            )}
            <input style={styles.input} placeholder="Stream Key" type="password" value={streamKey} onChange={(e) => setStreamKey(e.target.value)} />
            <div style={styles.formActions}>
              <button className="btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={handleAdd} disabled={!streamKey.trim()}>Add</button>
            </div>
          </div>
        ) : (
          <button className="btn-secondary" style={styles.addBtn} onClick={() => setShowForm(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Destination
          </button>
        )}

        {/* Go Live button */}
        <div style={styles.liveSection}>
          {isLive ? (
            <button className="btn-danger" style={styles.liveBtn} onClick={onStopLive}>
              <span style={styles.liveDotAnim} />
              Stop Streaming ({enabledCount} destination{enabledCount !== 1 ? 's' : ''})
            </button>
          ) : (
            <button
              className="btn-primary"
              style={{ ...styles.liveBtn, background: enabledCount > 0 ? '#ef4444' : 'var(--bg-surface)', color: enabledCount > 0 ? 'white' : 'var(--text-muted)' }}
              onClick={onGoLive}
              disabled={enabledCount === 0}
            >
              Go Live to {enabledCount} Destination{enabledCount !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function getDefaultRtmpUrl(platform: StreamDestination['platform']): string {
  switch (platform) {
    case 'youtube': return 'rtmp://a.rtmp.youtube.com/live2';
    case 'facebook': return 'rtmps://live-api-s.facebook.com:443/rtmp/';
    case 'twitch': return 'rtmp://live.twitch.tv/app/';
    case 'linkedin': return 'rtmp://rtmp-api.linkedin.com:443/rtmp/';
    case 'instagram': return 'rtmps://live-upload.instagram.com:443/rtmp/';
    default: return '';
  }
}

const styles: Record<string, React.CSSProperties> = {
  panel: { width: 320, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', height: '100%' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  subtitle: { fontSize: 11, color: 'var(--text-muted)', margin: 0, marginTop: 2 },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex' },
  body: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  destCard: { background: 'var(--bg-tertiary)', borderRadius: 10, padding: '10px 12px', border: '1px solid var(--border)' },
  destHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  platformDot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  destInfo: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  destName: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  destPlatform: { fontSize: 11, color: 'var(--text-muted)' },
  destActions: { display: 'flex', alignItems: 'center', gap: 4 },
  statusBadge: { fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' as const },
  toggleBtn: { fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' },
  removeBtn: { width: 22, height: 22, borderRadius: 5, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  destKey: { fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'monospace' },
  form: { background: 'var(--bg-tertiary)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)' },
  platformGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 },
  platformBtn: { fontSize: 11, fontWeight: 500, padding: '6px 4px', borderRadius: 6, border: '1px solid', cursor: 'pointer', background: 'var(--bg-tertiary)', textAlign: 'center' as const },
  input: { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 },
  addBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, padding: '10px', width: '100%' },
  liveSection: { marginTop: 'auto', paddingTop: 8 },
  liveBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 600, padding: '12px 16px' },
  liveDotAnim: { width: 10, height: 10, borderRadius: '50%', background: 'white', animation: 'livePulse 1.5s infinite' },
};
