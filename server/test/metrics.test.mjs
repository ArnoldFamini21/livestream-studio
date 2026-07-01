import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSignalingMetricsSnapshot,
  buildSignalingPrometheusMetrics,
  escapePrometheusLabelValue,
} from '../dist/services/metrics.js';

function makeRoomState(overrides = {}) {
  return {
    room: { status: 'waiting' },
    participants: new Map(),
    chatMessages: new Map(),
    qaQuestions: new Map(),
    polls: new Map(),
    ...overrides,
  };
}

describe('signaling Prometheus metrics', () => {
  it('builds a room and participant snapshot from active signaling state', () => {
    const rooms = new Map([
      ['room-live', makeRoomState({
        room: { status: 'live' },
        liveStreamStartedAt: '2026-07-01T12:00:00.000Z',
        recordingStartedAt: '2026-07-01T12:01:00.000Z',
        participants: new Map([
          ['host-1', { participant: { role: 'host', status: 'on-stage' } }],
          ['guest-1', { participant: { role: 'guest', status: 'green-room' } }],
          ['cohost-1', { participant: { role: 'co-host', status: 'backstage' } }],
        ]),
        chatMessages: new Map([['chat-1', {}], ['chat-2', {}]]),
        qaQuestions: new Map([['qa-1', {}]]),
        polls: new Map([['poll-1', { status: 'open' }], ['poll-2', { status: 'closed' }]]),
      })],
      ['room-scheduled', makeRoomState({ room: { status: 'scheduled' } })],
    ]);

    const snapshot = buildSignalingMetricsSnapshot(rooms);

    assert.equal(snapshot.roomsTotal, 2);
    assert.equal(snapshot.roomsByStatus.live, 1);
    assert.equal(snapshot.roomsByStatus.scheduled, 1);
    assert.equal(snapshot.participantsTotal, 3);
    assert.equal(snapshot.participantsByRole.host, 1);
    assert.equal(snapshot.participantsByRole['co-host'], 1);
    assert.equal(snapshot.participantsByStage.backstage, 1);
    assert.equal(snapshot.waitingGuestsTotal, 1);
    assert.equal(snapshot.activeLiveStreamsTotal, 1);
    assert.equal(snapshot.activeRecordingSessionsTotal, 1);
    assert.equal(snapshot.chatMessagesTotal, 2);
    assert.equal(snapshot.qaQuestionsTotal, 1);
    assert.equal(snapshot.activePollsTotal, 1);
  });

  it('formats Prometheus gauges with stable labels', () => {
    const rooms = new Map([
      ['room-1', makeRoomState({
        room: { status: 'recording' },
        participants: new Map([
          ['host-1', { participant: { role: 'host', status: 'on-stage' } }],
        ]),
      })],
    ]);

    const metrics = buildSignalingPrometheusMetrics(rooms);

    assert.match(metrics, /# TYPE livestream_studio_signaling_rooms_total gauge/);
    assert.match(metrics, /livestream_studio_signaling_rooms_total 1/);
    assert.match(metrics, /livestream_studio_signaling_rooms_by_status\{status="recording"\} 1/);
    assert.match(metrics, /livestream_studio_signaling_participants_by_role\{role="host"\} 1/);
    assert.match(metrics, /livestream_studio_signaling_participants_by_stage\{stage="on-stage"\} 1/);
    assert.equal(escapePrometheusLabelValue('quoted "value" \\ next\nline'), String.raw`quoted \"value\" \\ next\nline`);
  });
});
