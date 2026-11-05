import type { RtmpRelayDestinationStats, RtmpRelayEncoderStats, RtmpRelayVideoMode } from '@studio/shared';

/**
 * Health of the leg the browser cannot see: the media server's encoder and
 * each destination's uploader, from the FFmpeg progress the server reports
 * every ~2 s. A green upstream bitrate means little if the server cannot
 * keep up with it.
 */

/** Below this speed against real time the output falls behind and skips. */
export const RELAY_ENCODER_MIN_SPEED = 0.95;
/** A destination sending under this share of what the server receives is behind. */
export const RELAY_DESTINATION_MIN_SHARE = 0.7;
/** Reports older than this are treated as missing. */
export const RELAY_SERVER_STATS_STALE_MS = 8_000;

export type RelayServerHealthStatus = 'good' | 'warning' | 'poor' | 'unknown';

export interface RelayServerHealthItem {
  status: RelayServerHealthStatus;
  detail: string;
}

export interface RelayServerHealth {
  encoder: RelayServerHealthItem;
  destinations: Record<string, RelayServerHealthItem>;
  /** The worst problem, for the panel's headline; null when all is well or unknown. */
  headline: RelayServerHealthItem | null;
}

export function formatRelaySpeed(speed: number | null | undefined): string {
  return typeof speed === 'number' && Number.isFinite(speed) ? `${speed.toFixed(2)}x` : '--';
}

function formatKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function describeServerVideoMode(mode: RtmpRelayVideoMode | null | undefined): string {
  if (mode === 'copy') return 'Copy (H.264)';
  if (mode === 'transcode') return 'Re-encode';
  return '--';
}

function evaluateEncoder(
  encoder: RtmpRelayEncoderStats | null,
  videoMode: RtmpRelayVideoMode | null,
  now: number
): RelayServerHealthItem {
  const mode = encoder?.videoMode ?? videoMode;
  if (!encoder || now - encoder.at > RELAY_SERVER_STATS_STALE_MS) {
    return mode === 'transcode'
      ? { status: 'warning', detail: 'The server is re-encoding this stream (slow on the free tier). Waiting for encoder stats.' }
      : { status: 'unknown', detail: 'Waiting for the media server encoder report.' };
  }
  if (encoder.speed !== null && encoder.speed < RELAY_ENCODER_MIN_SPEED) {
    return {
      status: 'poor',
      detail: mode === 'transcode'
        ? `The server re-encode runs at ${formatRelaySpeed(encoder.speed)} real time, so viewers will see stutter and skips. Use a browser that uploads H.264 (current Chrome or Edge), or a lower output preset.`
        : `The server is processing at ${formatRelaySpeed(encoder.speed)} real time; viewers may see skips.`,
    };
  }
  if (mode === 'transcode') {
    return {
      status: 'warning',
      detail: `The server is re-encoding at ${formatRelaySpeed(encoder.speed)} real time (slow on the free tier).`,
    };
  }
  return { status: 'good', detail: `Server copies the browser's H.264 at ${formatRelaySpeed(encoder.speed)} real time.` };
}

function evaluateDestination(
  stats: RtmpRelayDestinationStats | undefined,
  upstreamKbps: number,
  now: number
): RelayServerHealthItem {
  if (!stats || now - stats.at > RELAY_SERVER_STATS_STALE_MS || stats.bitrateKbps === null) {
    return { status: 'unknown', detail: 'Waiting for the server upload report.' };
  }
  const sending = `Server sends ${formatKbps(stats.bitrateKbps)}`;
  if (upstreamKbps > 0 && stats.bitrateKbps < upstreamKbps * RELAY_DESTINATION_MIN_SHARE) {
    return {
      status: 'poor',
      detail: `${sending}, below the ${formatKbps(upstreamKbps)} it receives: this platform's connection is falling behind.`,
    };
  }
  if (stats.speed !== null && stats.speed < RELAY_ENCODER_MIN_SPEED) {
    return { status: 'poor', detail: `${sending} at ${formatRelaySpeed(stats.speed)} real time: falling behind.` };
  }
  return { status: 'good', detail: `${sending}.` };
}

const SEVERITY: Record<RelayServerHealthStatus, number> = { unknown: 0, good: 1, warning: 2, poor: 3 };

export function evaluateRelayServerHealth(input: {
  encoder: RtmpRelayEncoderStats | null;
  videoMode: RtmpRelayVideoMode | null;
  destinationStats: Record<string, RtmpRelayDestinationStats>;
  destinationIds: string[];
  /** What the browser is uploading, kbps. */
  upstreamKbps: number;
  now: number;
}): RelayServerHealth {
  const encoder = evaluateEncoder(input.encoder, input.videoMode, input.now);
  const destinations: Record<string, RelayServerHealthItem> = {};
  for (const id of input.destinationIds) {
    destinations[id] = evaluateDestination(input.destinationStats[id], input.upstreamKbps, input.now);
  }
  const candidates = [encoder, ...Object.values(destinations)];
  const worst = candidates.reduce((current, item) => (SEVERITY[item.status] > SEVERITY[current.status] ? item : current), encoder);
  return {
    encoder,
    destinations,
    headline: worst.status === 'poor' || worst.status === 'warning' ? worst : null,
  };
}
