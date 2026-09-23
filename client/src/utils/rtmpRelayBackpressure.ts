/**
 * The live relay cannot drop WebM chunks without corrupting the container,
 * so a slow uplink shows up as a growing WebSocket send buffer. Measured in
 * seconds of video at the target bitrate, a small backlog is a warning; a
 * large one means viewers are watching the past, and the relay should
 * reconnect at the live edge rather than grow memory without bound.
 */

export const RELAY_BACKLOG_WARNING_SECONDS = 3;
export const RELAY_BACKLOG_RECONNECT_SECONDS = 20;

export type RelayBacklogLevel = 'ok' | 'warning' | 'critical';

export interface RelayBacklog {
  seconds: number;
  level: RelayBacklogLevel;
}

export function getRelaySendBacklog(bufferedBytes: number, targetBitsPerSecond: number): RelayBacklog {
  if (!Number.isFinite(bufferedBytes) || bufferedBytes <= 0 || !Number.isFinite(targetBitsPerSecond) || targetBitsPerSecond <= 0) {
    return { seconds: 0, level: 'ok' };
  }
  const seconds = Math.round(((bufferedBytes * 8) / targetBitsPerSecond) * 10) / 10;
  const level: RelayBacklogLevel = seconds >= RELAY_BACKLOG_RECONNECT_SECONDS
    ? 'critical'
    : seconds >= RELAY_BACKLOG_WARNING_SECONDS
      ? 'warning'
      : 'ok';
  return { seconds, level };
}

export function formatRelayBacklog(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0.5) return 'None';
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}
