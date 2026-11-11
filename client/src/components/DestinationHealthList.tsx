import type { CSSProperties } from 'react';
import {
  formatGigabytesPerHour,
  formatKbpsShort,
  kbpsToGigabytesPerHour,
  type DestinationConnectionState,
  type DestinationHealthSummary,
} from '../utils/destinationHealth.ts';

interface DestinationHealthListProps {
  summary: DestinationHealthSummary;
}

const STATE_COLORS: Record<DestinationConnectionState, { color: string; background: string }> = {
  connected: { color: '#86efac', background: 'rgba(34,197,94,0.12)' },
  connecting: { color: '#93c5fd', background: 'rgba(96,165,250,0.12)' },
  reconnecting: { color: '#fcd34d', background: 'rgba(245,158,11,0.14)' },
  failed: { color: '#fca5a5', background: 'rgba(239,68,68,0.14)' },
  idle: { color: 'var(--text-muted)', background: 'var(--bg-surface)' },
};

/** One line per destination in Stream Health: state, what the server sends it, and the total. */
export function DestinationHealthList({ summary }: DestinationHealthListProps) {
  if (summary.rows.length === 0) return null;
  const { counts } = summary;
  const headline = [
    `${counts.connected}/${summary.rows.length} connected`,
    counts.reconnecting ? `${counts.reconnecting} reconnecting` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ].filter(Boolean).join(' · ');
  return (
    <section style={styles.section} aria-label="Destination health">
      <div style={styles.header}>
        <span style={styles.title}>Destinations</span>
        <span style={styles.headline}>{headline}</span>
      </div>
      <ul style={styles.list}>
        {summary.rows.map((row) => {
          const tone = STATE_COLORS[row.state];
          const detailColor = row.state === 'failed'
            ? '#fca5a5'
            : row.serverStatus === 'poor' || row.state === 'reconnecting'
              ? '#fcd34d'
              : 'var(--text-muted)';
          return (
            <li key={row.id} style={styles.row} data-destination-state={row.state}>
              <span style={{ ...styles.dot, background: row.color }} aria-hidden="true" />
              <div style={styles.body}>
                <div style={styles.topLine}>
                  <span style={styles.name} title={`${row.name} (${row.platformLabel})`}>{row.name}</span>
                  <span style={styles.bitrate}>{formatKbpsShort(row.bitrateKbps)}</span>
                  <span style={{ ...styles.state, color: tone.color, background: tone.background }}>{row.stateLabel}</span>
                </div>
                {row.detail && <span style={{ ...styles.detail, color: detailColor }}>{row.detail}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <div style={styles.total}>
        <span>Server upload to destinations</span>
        <span style={styles.totalValue}>
          {formatKbpsShort(summary.totalOutgoingKbps)} · {formatGigabytesPerHour(kbpsToGigabytesPerHour(summary.totalOutgoingKbps))}
        </span>
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', borderRadius: 7, background: 'rgba(0,0,0,0.16)' },
  header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' },
  headline: { fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'right' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  row: { display: 'grid', gridTemplateColumns: '8px minmax(0, 1fr)', gap: 7, alignItems: 'start' },
  dot: { width: 8, height: 8, borderRadius: 999, marginTop: 4 },
  body: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  topLine: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
  name: { flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bitrate: { flexShrink: 0, fontSize: 10, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' },
  state: { flexShrink: 0, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', borderRadius: 4, padding: '2px 5px' },
  detail: { fontSize: 10, lineHeight: 1.3, overflowWrap: 'anywhere' },
  total: { display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 5, borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--text-muted)' },
  totalValue: { color: 'var(--text-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
};
