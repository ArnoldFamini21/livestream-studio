import type { SessionHealthCheck, SessionHealthSummary, HealthStatus } from '../hooks/useSessionHealth.ts';

interface SessionHealthPanelProps {
  summary: SessionHealthSummary;
  onClose: () => void;
}

function statusColor(status: HealthStatus): string {
  switch (status) {
    case 'good': return 'var(--success)';
    case 'warning': return 'var(--warning)';
    case 'bad': return 'var(--danger)';
  }
}

function statusLabel(status: HealthStatus): string {
  switch (status) {
    case 'good': return 'Good';
    case 'warning': return 'Attention';
    case 'bad': return 'Blocked';
  }
}

function encodingMetricLabel(status: SessionHealthSummary['encoding']['status']): string {
  switch (status) {
    case 'ready': return 'Ready';
    case 'limited': return 'Limited';
    case 'unsupported': return 'Blocked';
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatRemoteLinkMetric(summary: SessionHealthSummary): string {
  const peerConnections = summary.peerConnections;
  if (peerConnections.remoteCount === 0) return 'None';
  if (peerConnections.poorCount > 0) return `${peerConnections.poorCount} poor`;
  if (peerConnections.fairCount > 0) return `${peerConnections.fairCount} fair`;
  if (peerConnections.unknownCount > 0) return `${peerConnections.unknownCount} warming up`;
  return `${peerConnections.goodCount}/${peerConnections.remoteCount} good`;
}

function formatTurnMetric(summary: SessionHealthSummary): string {
  const ice = summary.ice;
  if (ice.turnReady) return `${ice.turnServerCount} ready`;
  if (ice.usingFallbackTurn) return 'Fallback';
  if (ice.hasTurn) return 'Review';
  return 'Missing';
}

function CheckRow({ check }: { check: SessionHealthCheck }) {
  const color = statusColor(check.status);
  return (
    <div style={styles.checkRow}>
      <div style={{ ...styles.checkDot, background: color }} />
      <div style={styles.checkBody}>
        <div style={styles.checkTop}>
          <span style={styles.checkLabel}>{check.label}</span>
          <span style={{ ...styles.checkStatus, color }}>{statusLabel(check.status)}</span>
        </div>
        <p style={styles.checkDetail}>{check.detail}</p>
      </div>
    </div>
  );
}

export function SessionHealthPanel({ summary, onClose }: SessionHealthPanelProps) {
  return (
    <div style={styles.overlay} role="dialog" aria-modal="true" aria-label="Session health">
      <div style={styles.panel}>
        <div style={styles.header}>
          <div>
            <h3 style={styles.title}>Session Health</h3>
            <p style={styles.subtitle}>Broadcast and recording readiness</p>
          </div>
          <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose} aria-label="Close session health">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={styles.scoreWrap}>
          <div style={{ ...styles.scoreRing, borderColor: statusColor(summary.status) }}>
            <span style={styles.scoreNumber}>{summary.score}</span>
          </div>
          <div style={styles.scoreCopy}>
            <span style={{ ...styles.summaryBadge, color: statusColor(summary.status), borderColor: statusColor(summary.status) }}>
              {summary.label}
            </span>
            <p style={styles.summaryText}>
              {summary.status === 'good'
                ? 'This browser is ready for a production session.'
                : summary.status === 'warning'
                  ? 'You can continue, but review the items below before going live.'
                  : 'Resolve blocked items before recording or streaming.'}
            </p>
          </div>
        </div>

        <div style={styles.metricGrid}>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Network</span>
            <span style={styles.metricValue}>
              {summary.network.online ? summary.network.effectiveType?.toUpperCase() || 'Online' : 'Offline'}
            </span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Storage Used</span>
            <span style={styles.metricValue}>{summary.storage.percentUsed !== null ? `${summary.storage.percentUsed}%` : 'Unknown'}</span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Quota</span>
            <span style={styles.metricValue}>{formatBytes(summary.storage.quota)}</span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Camera</span>
            <span style={styles.metricValue}>{summary.media.videoTrack ? 'Ready' : 'Missing'}</span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Encoder</span>
            <span style={styles.metricValue}>{encodingMetricLabel(summary.encoding.status)}</span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>TURN Relay</span>
            <span style={styles.metricValue}>{formatTurnMetric(summary)}</span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Remote Links</span>
            <span style={styles.metricValue}>{formatRemoteLinkMetric(summary)}</span>
          </div>
        </div>

        <div style={styles.list}>
          {summary.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 900,
    background: 'rgba(0, 0, 0, 0.48)',
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'stretch',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
  },
  panel: {
    width: 380,
    maxWidth: '100%',
    height: '100%',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    boxShadow: '-16px 0 40px rgba(0, 0, 0, 0.35)',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '16px 18px 14px',
    borderBottom: '1px solid var(--border)',
  },
  title: { fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: 0 },
  subtitle: { fontSize: 12, color: 'var(--text-muted)', margin: '3px 0 0' },
  closeBtn: {
    width: 32,
    height: 32,
    padding: 0,
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreWrap: {
    display: 'flex',
    gap: 16,
    padding: 18,
    borderBottom: '1px solid var(--border)',
  },
  scoreRing: {
    width: 82,
    height: 82,
    borderRadius: '50%',
    border: '5px solid',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: 'rgba(255,255,255,0.03)',
  },
  scoreNumber: {
    fontSize: 24,
    fontWeight: 800,
    color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
  },
  scoreCopy: { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, minWidth: 0 },
  summaryBadge: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: 700,
    padding: '4px 8px',
    borderRadius: 999,
    border: '1px solid',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  summaryText: { margin: 0, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.45 },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    padding: '14px 18px',
    borderBottom: '1px solid var(--border)',
  },
  metric: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 12px',
    minWidth: 0,
  },
  metricLabel: {
    display: 'block',
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0,
    marginBottom: 5,
  },
  metricValue: {
    display: 'block',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 650,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  list: {
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  checkRow: {
    display: 'flex',
    gap: 10,
    padding: '11px 12px',
    background: 'rgba(255, 255, 255, 0.035)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  },
  checkDot: {
    width: 9,
    height: 9,
    borderRadius: '50%',
    marginTop: 4,
    flexShrink: 0,
  },
  checkBody: { flex: 1, minWidth: 0 },
  checkTop: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' },
  checkLabel: { fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' },
  checkStatus: { fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, flexShrink: 0 },
  checkDetail: { margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.4 },
};
