export const MAX_RELAY_LATENCY_MS = 30_000;

export function getRelayLatencyMs(now: number, sentAt: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(sentAt)) return null;
  const latencyMs = Math.round(now - sentAt);
  if (latencyMs < 0 || latencyMs > MAX_RELAY_LATENCY_MS) return null;
  return latencyMs;
}

export function formatRelayLatency(latencyMs: number | null): string {
  if (latencyMs === null || !Number.isFinite(latencyMs)) return 'waiting';
  if (latencyMs < 1000) return `${Math.max(0, Math.round(latencyMs))} ms`;
  return `${(latencyMs / 1000).toFixed(1)} s`;
}
