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

const PLATFORMS: Array<{ value: StreamDestination['platform']; label: string; color: string; dashUrl?: string }> = [
  { value: 'youtube', label: 'YouTube', color: '#FF0000', dashUrl: 'https://studio.youtube.com/channel/UC/livestreaming' },
  { value: 'facebook', label: 'Facebook', color: '#1877F2', dashUrl: 'https://www.facebook.com/live/producer' },
  { value: 'twitch', label: 'Twitch', color: '#9146FF', dashUrl: 'https://dashboard.twitch.tv/broadcast' },
  { value: 'linkedin', label: 'LinkedIn', color: '#0A66C2', dashUrl: 'https://www.linkedin.com/video/golive/now/' },
  { value: 'instagram', label: 'Instagram', color: '#E4405F', dashUrl: 'https://www.instagram.com/live/producer/' },
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
  const [formError, setFormError] = useState<string | null>(null);

  const handleAdd = () => {
    const platformInfo = PLATFORMS.find((p) => p.value === platform);
    const finalRtmp = rtmpUrl.trim() || getDefaultRtmpUrl(platform);
    const issue = getDestinationIssue({ rtmpUrl: finalRtmp, streamKey });
    if (issue) {
      setFormError(issue);
      return;
    }

    onAdd({
      platform,
      name: name.trim() || platformInfo?.label || 'Stream',
      rtmpUrl: finalRtmp,
      streamKey: streamKey.trim(),
      enabled: true,
    });
    setShowForm(false);
    setName('');
    setRtmpUrl('');
    setStreamKey('');
    setFormError(null);
  };

  const enabledDestinations = destinations.filter((d) => d.enabled);
  const enabledIssues = enabledDestinations
    .map((dest) => ({ dest, issue: getDestinationIssue(dest) }))
    .filter((item): item is { dest: StreamDestination; issue: string } => Boolean(item.issue));
  const enabledCount = enabledDestinations.length;
  // RTMP relay (the media-server) is not implemented yet. Disable Go Live so users
  // don't believe they're broadcasting when nothing is being pushed upstream.
  // Flip this to `enabledCount > 0 && enabledIssues.length === 0` once the relay ships.
  const RTMP_RELAY_AVAILABLE = false;
  const canGoLive = RTMP_RELAY_AVAILABLE && enabledCount > 0 && enabledIssues.length === 0;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Stream Destinations</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <p style={styles.subtitle}>{destinations.length} destination{destinations.length !== 1 ? 's' : ''}</p>
            {enabledCount > 1 && (
              <span style={styles.multistreamBadge}>Multistreaming ({enabledCount})</span>
            )}
          </div>
        </div>
        <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose} aria-label="Close destinations panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        {!RTMP_RELAY_AVAILABLE && (
          <div style={{ ...styles.preflight, ...styles.preflightWarn }}>
            <div style={styles.preflightTop}>
              <span style={styles.preflightLabel}>RTMP relay coming soon</span>
            </div>
            <div style={styles.preflightIssue}>
              You can save destinations and stream keys here, but the server-side RTMP push isn't live yet,
              so clicking Go Live won't actually broadcast. Use your platform's own producer dashboard for now.
            </div>
          </div>
        )}
        {RTMP_RELAY_AVAILABLE && destinations.length > 0 && (
          <div style={{ ...styles.preflight, ...(canGoLive ? styles.preflightReady : styles.preflightWarn) }}>
            <div style={styles.preflightTop}>
              <span style={styles.preflightLabel}>{canGoLive ? 'Ready to stream' : 'Needs setup'}</span>
              <span style={styles.preflightCount}>{enabledCount} enabled</span>
            </div>
            {enabledIssues.length > 0 && (
              <div style={styles.preflightIssue}>
                {enabledIssues[0].dest.name}: {enabledIssues[0].issue}
              </div>
            )}
          </div>
        )}

        {/* Destinations list */}
        {destinations.map((dest) => {
          const platformInfo = PLATFORMS.find((p) => p.value === dest.platform);
          const issue = dest.enabled ? getDestinationIssue(dest) : null;
          return (
            <div key={dest.id} className="participant-item" style={styles.destCard}>
              <div style={styles.destHeader}>
                <div style={{ ...styles.platformDot, background: platformInfo?.color }} />
                <div style={styles.destInfo}>
                  <span style={styles.destName}>{dest.name}</span>
                  <span style={styles.destPlatform}>{platformInfo?.label}</span>
                </div>
                <div style={styles.destActions}>
                  <span style={{
                    ...styles.statusBadge,
                    background: dest.status === 'live' ? 'rgba(34,197,94,0.12)' : dest.status === 'connecting' ? 'rgba(96,165,250,0.12)' : dest.status === 'error' || issue ? 'rgba(239,68,68,0.12)' : 'var(--bg-surface)',
                    color: dest.status === 'live' ? '#22c55e' : dest.status === 'connecting' ? '#60a5fa' : dest.status === 'error' || issue ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {issue ? 'error' : dest.status}
                  </span>
                  <button
                    type="button"
                    style={{ ...styles.toggleBtn, background: dest.enabled ? 'var(--success)' : 'var(--bg-surface)', color: dest.enabled ? 'white' : 'var(--text-muted)', opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }}
                    onClick={() => onToggle(dest.id)}
                    disabled={isLive}
                  >
                    {dest.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button type="button" className="participant-action-btn" style={{ ...styles.removeBtn, opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }} onClick={() => onRemove(dest.id)} disabled={isLive} aria-label="Remove destination">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
              <div style={styles.destKey}>
                Key: {maskStreamKey(dest.streamKey)}
              </div>
              <div style={styles.destRtmp}>{dest.rtmpUrl}</div>
              {issue && <div style={styles.destIssue}>{issue}</div>}
            </div>
          );
        })}

        {/* Add destination form */}
        {showForm ? (
          <form style={styles.form} onSubmit={(e) => { e.preventDefault(); handleAdd(); }}>
            <div style={styles.platformGrid}>
              {PLATFORMS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  className="hover-scale"
                  style={{
                    ...styles.platformBtn,
                    borderColor: platform === p.value ? p.color : 'var(--border)',
                    background: platform === p.value ? p.color + '15' : 'var(--bg-tertiary)',
                    color: platform === p.value ? p.color : 'var(--text-secondary)',
                  }}
                  onClick={() => {
                    setPlatform(p.value);
                    setRtmpUrl(getDefaultRtmpUrl(p.value)); // prefill RTMP visually
                    setFormError(null);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Name (optional)</label>
              <input 
                style={styles.input} 
                placeholder={`e.g. My ${PLATFORMS.find(p => p.value === platform)?.label} Channel`} 
                value={name} 
                onChange={(e) => { setName(e.target.value); setFormError(null); }}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>RTMP Server URL</label>
              <input 
                style={{ 
                  ...styles.input, 
                  ...(platform !== 'custom' ? { background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' } : {}) 
                }} 
                placeholder="rtmp://" 
                value={rtmpUrl || getDefaultRtmpUrl(platform)} 
                onChange={(e) => { setRtmpUrl(e.target.value); setFormError(null); }}
                readOnly={platform !== 'custom'} 
              />
            </div>

            <div style={styles.inputGroup}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
                <label style={{...styles.inputLabel, margin: 0}}>Stream Key</label>
                {PLATFORMS.find(p => p.value === platform)?.dashUrl && (
                  <a 
                    href={PLATFORMS.find(p => p.value === platform)?.dashUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    style={styles.keyLink}
                  >
                    Get {PLATFORMS.find(p => p.value === platform)?.label} Key
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                )}
              </div>
              <input 
                style={styles.input} 
                placeholder="Paste key here" 
                type="password" 
                autoComplete="off"
                value={streamKey} 
                onChange={(e) => { setStreamKey(e.target.value); setFormError(null); }}
              />
            </div>

            {formError && <div style={styles.formError}>{formError}</div>}

            <div style={styles.formActions}>
              <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} disabled={!streamKey.trim() || isLive}>Add Destination</button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn-secondary" style={{ ...styles.addBtn, opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }} onClick={() => {
            setShowForm(true);
            setRtmpUrl(getDefaultRtmpUrl(platform)); // Ensure initial mount has pre-filled RTMP
          }} disabled={isLive}>
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
              type="button"
              className="btn-primary"
              style={{ ...styles.liveBtn, background: canGoLive ? '#ef4444' : 'var(--bg-surface)', color: canGoLive ? 'white' : 'var(--text-muted)' }}
              onClick={onGoLive}
              disabled={!canGoLive}
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
    case 'linkedin': return 'rtmps://rtmp-api.linkedin.com:443/rtmp/';
    case 'instagram': return 'rtmps://live-upload.instagram.com:443/rtmp/';
    default: return '';
  }
}

function isValidRtmpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'rtmp:' || parsed.protocol === 'rtmps:';
  } catch {
    return false;
  }
}

function getDestinationIssue(dest: Pick<StreamDestination, 'rtmpUrl' | 'streamKey'>): string | null {
  if (!dest.rtmpUrl.trim()) return 'Missing RTMP server URL';
  if (!isValidRtmpUrl(dest.rtmpUrl.trim())) return 'RTMP URL must start with rtmp:// or rtmps://';
  if (!dest.streamKey.trim()) return 'Missing stream key';
  return null;
}

function maskStreamKey(streamKey: string): string {
  const trimmed = streamKey.trim();
  if (trimmed.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(trimmed.length - 4, 12))}${trimmed.slice(-4)}`;
}

const styles: Record<string, React.CSSProperties> = {
  panel: { width: 320, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', height: '100%' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  subtitle: { fontSize: 11, color: 'var(--text-muted)', margin: 0 },
  multistreamBadge: { 
    fontSize: 9, 
    fontWeight: 700, 
    background: 'rgba(167, 139, 250, 0.15)', 
    color: '#c4b5fd', 
    padding: '2px 6px', 
    borderRadius: 6, 
    textTransform: 'uppercase',
    letterSpacing: '0.04em'
  },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex' },
  body: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  preflight: { borderRadius: 8, padding: '10px 12px', border: '1px solid', display: 'flex', flexDirection: 'column', gap: 4 },
  preflightReady: { background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.22)' },
  preflightWarn: { background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.22)' },
  preflightTop: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  preflightLabel: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  preflightCount: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' },
  preflightIssue: { fontSize: 11, color: '#fbbf24', lineHeight: 1.35 },
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
  destRtmp: { fontSize: 10, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' },
  destIssue: { fontSize: 10, color: '#ef4444', marginTop: 5, lineHeight: 1.3 },
  form: { background: 'var(--bg-tertiary)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 12, border: '1px solid var(--border)' },
  platformGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 },
  platformBtn: { fontSize: 11, fontWeight: 500, padding: '6px 4px', borderRadius: 6, border: '1px solid', cursor: 'pointer', background: 'var(--bg-tertiary)', textAlign: 'center' as const },
  inputGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  inputLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' },
  keyLink: { fontSize: 10, color: '#60a5fa', textDecoration: 'none', display: 'flex', alignItems: 'center', fontWeight: 500 },
  input: { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' },
  formError: { fontSize: 11, color: '#fca5a5', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: 6, padding: '7px 9px', lineHeight: 1.35 },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  addBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, padding: '10px', width: '100%' },
  liveSection: { marginTop: 'auto', paddingTop: 8 },
  liveBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 600, padding: '12px 16px' },
  liveDotAnim: { width: 10, height: 10, borderRadius: '50%', background: 'white', animation: 'livePulse 1.5s infinite' },
};
