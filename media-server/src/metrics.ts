type LabelSet = Record<string, string>;

export interface MediaRelayMetricsSession {
  started: boolean;
  stopping: boolean;
  destinations: unknown[];
  relays: Map<string, { live: boolean; exited: boolean }>;
  stopTimers: Map<string, unknown>;
  restartTimers: Map<string, unknown>;
  restartAttempts: Map<string, number>;
}

export type MediaRelaySessionsMap = Map<unknown, MediaRelayMetricsSession>;

export interface MediaRelayMetricsSnapshot {
  sessionsTotal: number;
  startedSessionsTotal: number;
  stoppingSessionsTotal: number;
  destinationsTotal: number;
  ffmpegRelaysTotal: number;
  liveRelaysTotal: number;
  exitedRelaysTotal: number;
  restartingRelaysTotal: number;
  stopTimersTotal: number;
  restartAttemptsTotal: number;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels?: LabelSet): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const entries = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapePrometheusLabelValue(value)}"`);
  return `{${entries.join(',')}}`;
}

function formatGauge(name: string, help: string, samples: Array<{ value: number; labels?: LabelSet }>): string {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...samples.map((sample) => `${name}${formatLabels(sample.labels)} ${sample.value}`),
  ].join('\n');
}

export function buildMediaRelayMetricsSnapshot(sessions: MediaRelaySessionsMap): MediaRelayMetricsSnapshot {
  const snapshot: MediaRelayMetricsSnapshot = {
    sessionsTotal: sessions.size,
    startedSessionsTotal: 0,
    stoppingSessionsTotal: 0,
    destinationsTotal: 0,
    ffmpegRelaysTotal: 0,
    liveRelaysTotal: 0,
    exitedRelaysTotal: 0,
    restartingRelaysTotal: 0,
    stopTimersTotal: 0,
    restartAttemptsTotal: 0,
  };

  for (const session of sessions.values()) {
    if (session.started) snapshot.startedSessionsTotal++;
    if (session.stopping) snapshot.stoppingSessionsTotal++;
    snapshot.destinationsTotal += session.destinations.length;
    snapshot.ffmpegRelaysTotal += session.relays.size;
    snapshot.restartingRelaysTotal += session.restartTimers.size;
    snapshot.stopTimersTotal += session.stopTimers.size;
    for (const attempts of session.restartAttempts.values()) {
      snapshot.restartAttemptsTotal += attempts;
    }
    for (const relay of session.relays.values()) {
      if (relay.live) snapshot.liveRelaysTotal++;
      if (relay.exited) snapshot.exitedRelaysTotal++;
    }
  }

  return snapshot;
}

export function buildMediaRelayPrometheusMetrics(sessions: MediaRelaySessionsMap): string {
  const snapshot = buildMediaRelayMetricsSnapshot(sessions);
  const lines = [
    formatGauge('livestream_studio_media_relay_sessions_total', 'Active RTMP relay WebSocket sessions.', [
      { value: snapshot.sessionsTotal },
    ]),
    formatGauge('livestream_studio_media_relay_sessions_by_state', 'RTMP relay sessions by lifecycle state.', [
      { labels: { state: 'started' }, value: snapshot.startedSessionsTotal },
      { labels: { state: 'stopping' }, value: snapshot.stoppingSessionsTotal },
      {
        labels: { state: 'idle' },
        value: Math.max(0, snapshot.sessionsTotal - snapshot.startedSessionsTotal - snapshot.stoppingSessionsTotal),
      },
    ]),
    formatGauge('livestream_studio_media_destinations_total', 'Configured RTMP destinations across active sessions.', [
      { value: snapshot.destinationsTotal },
    ]),
    formatGauge('livestream_studio_media_ffmpeg_relays_total', 'FFmpeg relay processes tracked by the media server.', [
      { value: snapshot.ffmpegRelaysTotal },
    ]),
    formatGauge('livestream_studio_media_ffmpeg_relays_live_total', 'FFmpeg relays that have received media chunks.', [
      { value: snapshot.liveRelaysTotal },
    ]),
    formatGauge('livestream_studio_media_ffmpeg_relays_exited_total', 'FFmpeg relays that have exited but remain tracked.', [
      { value: snapshot.exitedRelaysTotal },
    ]),
    formatGauge('livestream_studio_media_restarting_relays_total', 'RTMP destinations waiting for reconnect timers.', [
      { value: snapshot.restartingRelaysTotal },
    ]),
    formatGauge('livestream_studio_media_stop_timers_total', 'FFmpeg processes waiting for graceful stop timers.', [
      { value: snapshot.stopTimersTotal },
    ]),
    formatGauge('livestream_studio_media_restart_attempts_total', 'Destination restart attempts across active sessions.', [
      { value: snapshot.restartAttemptsTotal },
    ]),
  ];
  return `${lines.join('\n')}\n`;
}
