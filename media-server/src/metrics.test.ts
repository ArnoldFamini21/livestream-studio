import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMediaRelayMetricsSnapshot,
  buildMediaRelayPrometheusMetrics,
  type MediaRelayMetricsSession,
} from './metrics.js';

function makeSession(overrides: Partial<MediaRelayMetricsSession> = {}): MediaRelayMetricsSession {
  return {
    started: false,
    stopping: false,
    destinations: [],
    relays: new Map(),
    stopTimers: new Map(),
    restartTimers: new Map(),
    restartAttempts: new Map(),
    ...overrides,
  };
}

describe('media relay Prometheus metrics', () => {
  it('summarizes active relay sessions and FFmpeg process state', () => {
    const sessions = new Map([
      ['socket-1', makeSession({
        started: true,
        destinations: [{ id: 'youtube' }, { id: 'facebook' }],
        relays: new Map([
          ['youtube', { live: true, exited: false }],
          ['facebook', { live: true, exited: true }],
        ]),
        restartTimers: new Map([['facebook', {}]]),
        restartAttempts: new Map([['facebook', 2]]),
      })],
      ['socket-2', makeSession({
        stopping: true,
        stopTimers: new Map([['custom', {}]]),
      })],
    ]);

    const snapshot = buildMediaRelayMetricsSnapshot(sessions);

    assert.equal(snapshot.sessionsTotal, 2);
    assert.equal(snapshot.startedSessionsTotal, 1);
    assert.equal(snapshot.stoppingSessionsTotal, 1);
    assert.equal(snapshot.destinationsTotal, 2);
    assert.equal(snapshot.ffmpegRelaysTotal, 2);
    assert.equal(snapshot.liveRelaysTotal, 2);
    assert.equal(snapshot.exitedRelaysTotal, 1);
    assert.equal(snapshot.restartingRelaysTotal, 1);
    assert.equal(snapshot.stopTimersTotal, 1);
    assert.equal(snapshot.restartAttemptsTotal, 2);
  });

  it('formats relay metrics as Prometheus gauges', () => {
    const sessions = new Map([
      ['socket-1', makeSession({
        started: true,
        destinations: [{ id: 'youtube' }],
        relays: new Map([['youtube', { live: false, exited: false }]]),
      })],
    ]);

    const metrics = buildMediaRelayPrometheusMetrics(sessions);

    assert.match(metrics, /# TYPE livestream_studio_media_relay_sessions_total gauge/);
    assert.match(metrics, /livestream_studio_media_relay_sessions_total 1/);
    assert.match(metrics, /livestream_studio_media_relay_sessions_by_state\{state="started"\} 1/);
    assert.match(metrics, /livestream_studio_media_destinations_total 1/);
    assert.match(metrics, /livestream_studio_media_ffmpeg_relays_total 1/);
  });
});
