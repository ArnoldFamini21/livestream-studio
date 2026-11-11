import type { RtmpRelayDestinationStats, StreamDestination } from '@studio/shared';
import { RELAY_SERVER_STATS_STALE_MS, type RelayServerHealthItem } from './relayServerHealth.ts';
import { getStreamPlatformGuide } from './streamDestinations.ts';

/**
 * Per-destination health for the Stream Health panel: whether each platform
 * is connected, reconnecting or failed (from the media server's
 * destination-status messages) and what the server is actually sending it
 * (from each uploader's FFmpeg progress), plus the total leaving the server.
 */

export type DestinationConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'failed' | 'idle';

export interface DestinationHealthRow {
  id: string;
  name: string;
  platformLabel: string;
  color: string;
  state: DestinationConnectionState;
  stateLabel: string;
  /** What the server sends this destination now; null when unknown or not sending. */
  bitrateKbps: number | null;
  /** The newest status line or server warning for this destination, if any. */
  detail: string | null;
  /** Severity of the server's own report for this destination. */
  serverStatus: RelayServerHealthItem['status'];
}

export interface DestinationHealthSummary {
  rows: DestinationHealthRow[];
  /** Sum of the fresh per-destination bitrates: the media server's RTMP upload. */
  totalOutgoingKbps: number;
  counts: Record<DestinationConnectionState, number>;
}

const STATE_LABELS: Record<DestinationConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  failed: 'Failed',
  idle: 'Waiting',
};

/** Both the media server and the browser say "Reconnecting ..." while they retry. */
const RECONNECTING_PATTERN = /reconnect/i;

export function getDestinationConnectionState(
  destination: Pick<StreamDestination, 'status' | 'statusMessage'>
): DestinationConnectionState {
  switch (destination.status) {
    case 'live': return 'connected';
    case 'error': return 'failed';
    case 'connecting':
      return destination.statusMessage && RECONNECTING_PATTERN.test(destination.statusMessage)
        ? 'reconnecting'
        : 'connecting';
    default: return 'idle';
  }
}

export function getDestinationStateLabel(state: DestinationConnectionState): string {
  return STATE_LABELS[state];
}

function freshBitrate(stats: RtmpRelayDestinationStats | undefined, now: number): number | null {
  if (!stats || stats.bitrateKbps === null || !Number.isFinite(stats.bitrateKbps)) return null;
  if (now - stats.at > RELAY_SERVER_STATS_STALE_MS) return null;
  return Math.max(0, stats.bitrateKbps);
}

export function buildDestinationHealth(input: {
  destinations: Array<Pick<StreamDestination, 'id' | 'name' | 'platform' | 'status' | 'statusMessage'>>;
  destinationStats: Record<string, RtmpRelayDestinationStats>;
  serverHealth?: Record<string, RelayServerHealthItem> | null;
  now: number;
}): DestinationHealthSummary {
  const counts: Record<DestinationConnectionState, number> = {
    connected: 0,
    connecting: 0,
    reconnecting: 0,
    failed: 0,
    idle: 0,
  };
  let totalOutgoingKbps = 0;
  const rows = input.destinations.map((destination): DestinationHealthRow => {
    const guide = getStreamPlatformGuide(destination.platform);
    const state = getDestinationConnectionState(destination);
    counts[state] += 1;
    // A failed or retrying uploader is not sending, whatever its last report said.
    const bitrateKbps = state === 'connected' ? freshBitrate(input.destinationStats[destination.id], input.now) : null;
    if (bitrateKbps !== null) totalOutgoingKbps += bitrateKbps;
    const server = input.serverHealth?.[destination.id];
    const serverStatus = server?.status ?? 'unknown';
    const serverDetail = server && (serverStatus === 'poor' || serverStatus === 'warning') ? server.detail : null;
    return {
      id: destination.id,
      name: destination.name,
      platformLabel: guide.label,
      color: guide.color,
      state,
      stateLabel: STATE_LABELS[state],
      bitrateKbps,
      detail: state === 'connected' ? (serverDetail || destination.statusMessage || null) : (destination.statusMessage || null),
      serverStatus,
    };
  });
  return { rows, totalOutgoingKbps: Math.round(totalOutgoingKbps), counts };
}

/** kbps sustained for an hour, in gigabytes (10^9 bytes, as hosting dashboards count). */
export function kbpsToGigabytesPerHour(kbps: number): number {
  if (!Number.isFinite(kbps) || kbps <= 0) return 0;
  return (kbps * 1000 / 8) * 3600 / 1e9;
}

export interface ServerUploadEstimate {
  destinationCount: number;
  perDestinationKbps: number;
  totalKbps: number;
  gigabytesPerHour: number;
}

/**
 * Copy-only fan-out sends every destination the full program, so the media
 * server's upload grows with the destination count even though its CPU does
 * not. Watch-page viewers come on top of this.
 */
export function estimateServerUpload(destinationCount: number, perDestinationKbps: number): ServerUploadEstimate {
  const count = Math.max(0, Math.floor(destinationCount));
  const perDestination = Math.max(0, Math.round(perDestinationKbps));
  const totalKbps = count * perDestination;
  return {
    destinationCount: count,
    perDestinationKbps: perDestination,
    totalKbps,
    gigabytesPerHour: kbpsToGigabytesPerHour(totalKbps),
  };
}

export function formatKbpsShort(kbps: number | null): string {
  if (kbps === null || !Number.isFinite(kbps)) return '--';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function formatGigabytesPerHour(gigabytes: number): string {
  if (gigabytes <= 0) return '0 GB/h';
  return `${gigabytes >= 10 ? gigabytes.toFixed(0) : gigabytes.toFixed(1)} GB/h`;
}

export function describeServerUploadEstimate(estimate: ServerUploadEstimate): string {
  if (estimate.destinationCount === 0) return 'No destinations enabled.';
  const each = formatKbpsShort(estimate.perDestinationKbps);
  const total = formatKbpsShort(estimate.totalKbps);
  const per = estimate.destinationCount === 1
    ? `1 destination at ${each}`
    : `${estimate.destinationCount} destinations × ${each}`;
  return `Server upload: ${per} ≈ ${total} (${formatGigabytesPerHour(estimate.gigabytesPerHour)}) plus watch-page viewers. Render's free plan limits monthly outbound bandwidth; check Usage in the Render dashboard.`;
}
