import type { SessionHealthCheck, SessionHealthSummary, HealthStatus } from '../hooks/useSessionHealth.ts';
import { buildMediaServerParityDiagnostics } from '../utils/mediaServerHealth.ts';
import type { MediaServerParityFeatureStatus, MediaServerParityDiagnostics } from '../utils/mediaServerHealth.ts';
import type { MeshCapacityPlan, MeshCapacityStatus } from '../utils/meshCapacityPlanner.ts';
import type { SfuTransportStatus } from '../utils/sfuRuntime.ts';

interface SessionHealthPanelProps {
  summary: SessionHealthSummary;
  meshCapacity?: MeshCapacityPlan | null;
  sfuMediaStatus?: SfuTransportStatus;
  onClose: () => void;
}

function meshStatusColor(status: MeshCapacityStatus): string {
  switch (status) {
    case 'comfortable': return 'var(--success)';
    case 'tight': return 'var(--warning)';
    case 'over': return 'var(--error)';
  }
}

function mediaTransportColor(status: SfuTransportStatus | undefined, meshStatus: MeshCapacityStatus): string {
  if (status === 'active') return 'var(--success)';
  if (status === 'connecting' || status === 'ready' || status === 'fallback') return 'var(--warning)';
  return meshStatusColor(meshStatus);
}

function mediaTransportLabel(status: SfuTransportStatus | undefined, meshStatus: MeshCapacityStatus): string {
  if (status === 'active') return 'SFU active';
  if (status === 'connecting') return 'Connecting';
  if (status === 'ready') return 'Negotiating';
  if (status === 'fallback') return 'Mesh fallback';
  return meshStatus === 'comfortable' ? 'Comfortable' : meshStatus === 'tight' ? 'Tight' : 'Over budget';
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

function formatMediaServerMetric(summary: SessionHealthSummary): string {
  switch (summary.mediaServer?.status) {
    case 'ready': return 'Ready';
    case 'checking': return 'Checking';
    case 'unavailable': return 'Blocked';
    default: return 'Unknown';
  }
}

function diagnosticStatusColor(status: MediaServerParityDiagnostics['status']): string {
  switch (status) {
    case 'ready': return 'var(--success)';
    case 'checking': return 'var(--warning)';
    case 'degraded': return 'var(--warning)';
    case 'blocked': return 'var(--danger)';
  }
}

function diagnosticStatusLabel(status: MediaServerParityDiagnostics['status']): string {
  switch (status) {
    case 'ready': return 'Ready';
    case 'checking': return 'Checking';
    case 'degraded': return 'Review';
    case 'blocked': return 'Blocked';
  }
}

function featureStatusColor(status: MediaServerParityFeatureStatus): string {
  switch (status) {
    case 'ready': return 'var(--success)';
    case 'checking': return 'var(--warning)';
    case 'degraded': return 'var(--warning)';
    case 'blocked': return 'var(--danger)';
  }
}

function featureStatusLabel(status: MediaServerParityFeatureStatus): string {
  switch (status) {
    case 'ready': return 'Ready';
    case 'checking': return 'Checking';
    case 'degraded': return 'Review';
    case 'blocked': return 'Blocked';
  }
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

function MediaServerDiagnosticsCard({ diagnostics }: { diagnostics: MediaServerParityDiagnostics }) {
  const statusColorValue = diagnosticStatusColor(diagnostics.status);
  return (
    <div style={styles.diagnosticCard}>
      <div style={styles.diagnosticTop}>
        <div style={styles.diagnosticTitle}>Media-Server Features</div>
        <span style={{ ...styles.diagnosticBadge, color: statusColorValue, borderColor: statusColorValue }}>
          {diagnosticStatusLabel(diagnostics.status)}
        </span>
      </div>
      <p style={styles.diagnosticHeadline}>{diagnostics.headline}</p>
      <p style={styles.diagnosticDetail}>{diagnostics.detail}</p>

      <div style={styles.featureList}>
        {diagnostics.features.map((feature) => {
          const color = featureStatusColor(feature.status);
          return (
            <div key={feature.id} style={styles.featureRow}>
              <span style={{ ...styles.featureDot, background: color }} />
              <div style={styles.featureBody}>
                <div style={styles.featureTop}>
                  <span style={styles.featureLabel}>{feature.label}</span>
                  <span style={{ ...styles.featureStatus, color }}>{featureStatusLabel(feature.status)}</span>
                </div>
                <p style={styles.featureDetail}>{feature.detail}</p>
              </div>
            </div>
          );
        })}
      </div>

      {diagnostics.actions.length > 0 && (
        <div style={styles.actionList}>
          <div style={styles.actionTitle}>Next Actions</div>
          {diagnostics.actions.map((action) => (
            <div key={action.id} style={styles.actionItem}>{action.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionHealthPanel({ summary, meshCapacity, sfuMediaStatus, onClose }: SessionHealthPanelProps) {
  const mediaServerDiagnostics = buildMediaServerParityDiagnostics(summary.mediaServer);
  const showMeshCapacity = Boolean(meshCapacity && meshCapacity.outgoingPeerCount > 0);

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

        {showMeshCapacity && meshCapacity && (
          <div
            style={{
              ...styles.meshCard,
              borderColor: mediaTransportColor(sfuMediaStatus, meshCapacity.status),
            }}
          >
            <div style={styles.meshHeader}>
              <span style={styles.meshTitle}>Media transport</span>
              <span style={{ ...styles.meshBadge, color: mediaTransportColor(sfuMediaStatus, meshCapacity.status), borderColor: mediaTransportColor(sfuMediaStatus, meshCapacity.status) }}>
                {mediaTransportLabel(sfuMediaStatus, meshCapacity.status)}
              </span>
            </div>
            <div style={styles.meshMetrics}>
              <span>{sfuMediaStatus === 'active' ? '1 SFU media upload' : `${meshCapacity.outgoingPeerCount} mesh upload${meshCapacity.outgoingPeerCount === 1 ? '' : 's'}`}</span>
              <span>·</span>
              <span>{sfuMediaStatus === 'active' ? 'SFU audio + video' : `${meshCapacity.recommendedTier} target`}</span>
              <span>·</span>
              <span>{sfuMediaStatus === 'active' ? 'Adaptive video layers' : `~${Math.round(meshCapacity.aggregateUploadKbps / 100) / 10} Mbps up`}</span>
            </div>
            <p style={styles.meshNote}>
              {sfuMediaStatus === 'active'
                ? 'The media server is carrying one audio/video upload and selectively forwarding adaptive media to the stage.'
                : sfuMediaStatus === 'connecting' || sfuMediaStatus === 'ready'
                  ? 'SFU media is negotiating. Mesh stays active until every advertised remote track arrives.'
                  : sfuMediaStatus === 'fallback'
                    ? 'SFU media is unavailable. Mesh audio and video were restored automatically and will retry in the background.'
                    : meshCapacity.note}
            </p>
            {meshCapacity.sfuRecommended && sfuMediaStatus !== 'active' && (
              <p style={styles.meshSfuNote}>The media-server SFU is recommended for stages this size.</p>
            )}
          </div>
        )}

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
            <span style={styles.metricLabel}>Media Server</span>
            <span style={styles.metricValue}>{formatMediaServerMetric(summary)}</span>
          </div>
          <div style={styles.metric}>
            <span style={styles.metricLabel}>Remote Links</span>
            <span style={styles.metricValue}>{formatRemoteLinkMetric(summary)}</span>
          </div>
        </div>

        <div style={styles.diagnosticWrap}>
          <MediaServerDiagnosticsCard diagnostics={mediaServerDiagnostics} />
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
  meshCard: {
    margin: '0 18px 14px',
    padding: 12,
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  meshHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  meshTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  meshBadge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    border: '1px solid',
    borderRadius: 999,
    padding: '2px 8px',
  },
  meshMetrics: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    fontSize: 11,
    color: 'var(--text-secondary)',
    fontVariantNumeric: 'tabular-nums',
  },
  meshNote: {
    margin: 0,
    fontSize: 11,
    lineHeight: 1.45,
    color: 'var(--text-muted)',
  },
  meshSfuNote: {
    margin: 0,
    fontSize: 11,
    lineHeight: 1.45,
    color: 'var(--accent)',
    fontWeight: 600,
  },
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
  diagnosticWrap: {
    padding: '0 18px 14px',
    borderBottom: '1px solid var(--border)',
  },
  diagnosticCard: {
    background: 'rgba(255, 255, 255, 0.035)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
  },
  diagnosticTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  diagnosticTitle: {
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 800,
    minWidth: 0,
  },
  diagnosticBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 900,
    textTransform: 'uppercase',
    borderRadius: 999,
    border: '1px solid',
    padding: '3px 7px',
    letterSpacing: 0,
  },
  diagnosticHeadline: { margin: 0, color: 'var(--text-primary)', fontSize: 12, fontWeight: 750, lineHeight: 1.35 },
  diagnosticDetail: { margin: '-4px 0 0', color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.35 },
  featureList: { display: 'flex', flexDirection: 'column', gap: 7 },
  featureRow: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
  featureDot: { width: 8, height: 8, borderRadius: '50%', marginTop: 5, flexShrink: 0 },
  featureBody: { flex: 1, minWidth: 0 },
  featureTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  featureLabel: { color: 'var(--text-primary)', fontSize: 11, fontWeight: 750, minWidth: 0 },
  featureStatus: { fontSize: 9, fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0, flexShrink: 0 },
  featureDetail: { margin: '2px 0 0', color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.3 },
  actionList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    paddingTop: 8,
    borderTop: '1px solid var(--border)',
  },
  actionTitle: { fontSize: 10, fontWeight: 900, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0 },
  actionItem: {
    color: 'var(--text-secondary)',
    fontSize: 10,
    lineHeight: 1.35,
    padding: '6px 7px',
    borderRadius: 7,
    background: 'rgba(0,0,0,0.15)',
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
