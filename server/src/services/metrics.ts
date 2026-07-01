import { getRooms } from './signaling.js';

type LabelSet = Record<string, string>;

interface SignalingMetricsRoomState {
  room: { status: string };
  participants: Map<string, { participant: { role: string; status: string } }>;
  chatMessages: { size: number };
  qaQuestions: { size: number };
  polls: Map<string, { status: string }>;
  liveStreamStartedAt?: string;
  recordingStartedAt?: string;
}

export type SignalingRoomsMap = Map<string, SignalingMetricsRoomState>;

const ROOM_STATUSES = ['waiting', 'scheduled', 'live', 'recording', 'ended'] as const;
const PARTICIPANT_ROLES = ['host', 'co-host', 'guest'] as const;
const PARTICIPANT_STAGES = ['green-room', 'on-stage', 'backstage'] as const;

export interface SignalingMetricsSnapshot {
  roomsTotal: number;
  roomsByStatus: Record<string, number>;
  participantsTotal: number;
  participantsByRole: Record<string, number>;
  participantsByStage: Record<string, number>;
  waitingGuestsTotal: number;
  activeLiveStreamsTotal: number;
  activeRecordingSessionsTotal: number;
  chatMessagesTotal: number;
  qaQuestionsTotal: number;
  activePollsTotal: number;
}

export function escapePrometheusLabelValue(value: string): string {
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

function emptyCounts(values: readonly string[]): Record<string, number> {
  return Object.fromEntries(values.map((value) => [value, 0]));
}

export function buildSignalingMetricsSnapshot(rooms: SignalingRoomsMap = getRooms()): SignalingMetricsSnapshot {
  const roomsByStatus = emptyCounts(ROOM_STATUSES);
  const participantsByRole = emptyCounts(PARTICIPANT_ROLES);
  const participantsByStage = emptyCounts(PARTICIPANT_STAGES);
  const snapshot: SignalingMetricsSnapshot = {
    roomsTotal: rooms.size,
    roomsByStatus,
    participantsTotal: 0,
    participantsByRole,
    participantsByStage,
    waitingGuestsTotal: 0,
    activeLiveStreamsTotal: 0,
    activeRecordingSessionsTotal: 0,
    chatMessagesTotal: 0,
    qaQuestionsTotal: 0,
    activePollsTotal: 0,
  };

  for (const roomState of rooms.values()) {
    const status = roomState.room.status;
    roomsByStatus[status] = (roomsByStatus[status] || 0) + 1;
    if (roomState.liveStreamStartedAt) snapshot.activeLiveStreamsTotal++;
    if (roomState.recordingStartedAt) snapshot.activeRecordingSessionsTotal++;
    snapshot.chatMessagesTotal += roomState.chatMessages.size;
    snapshot.qaQuestionsTotal += roomState.qaQuestions.size;
    snapshot.activePollsTotal += Array.from(roomState.polls.values()).filter((poll) => poll.status === 'open').length;

    for (const { participant } of roomState.participants.values()) {
      snapshot.participantsTotal++;
      participantsByRole[participant.role] = (participantsByRole[participant.role] || 0) + 1;
      participantsByStage[participant.status] = (participantsByStage[participant.status] || 0) + 1;
      if (participant.role === 'guest' && participant.status === 'green-room') {
        snapshot.waitingGuestsTotal++;
      }
    }
  }

  return snapshot;
}

export function buildSignalingPrometheusMetrics(rooms: SignalingRoomsMap = getRooms()): string {
  const snapshot = buildSignalingMetricsSnapshot(rooms);
  const lines = [
    formatGauge('livestream_studio_signaling_rooms_total', 'Active signaling rooms in memory.', [
      { value: snapshot.roomsTotal },
    ]),
    formatGauge(
      'livestream_studio_signaling_rooms_by_status',
      'Active signaling rooms by current room status.',
      Object.entries(snapshot.roomsByStatus).map(([status, value]) => ({ labels: { status }, value }))
    ),
    formatGauge('livestream_studio_signaling_participants_total', 'Connected signaling participants.', [
      { value: snapshot.participantsTotal },
    ]),
    formatGauge(
      'livestream_studio_signaling_participants_by_role',
      'Connected signaling participants by studio role.',
      Object.entries(snapshot.participantsByRole).map(([role, value]) => ({ labels: { role }, value }))
    ),
    formatGauge(
      'livestream_studio_signaling_participants_by_stage',
      'Connected signaling participants by stage location.',
      Object.entries(snapshot.participantsByStage).map(([stage, value]) => ({ labels: { stage }, value }))
    ),
    formatGauge('livestream_studio_signaling_waiting_guests_total', 'Guests currently waiting in green rooms.', [
      { value: snapshot.waitingGuestsTotal },
    ]),
    formatGauge('livestream_studio_signaling_live_streams_total', 'Rooms with an active live stream.', [
      { value: snapshot.activeLiveStreamsTotal },
    ]),
    formatGauge('livestream_studio_signaling_recording_sessions_total', 'Rooms with an active recording session.', [
      { value: snapshot.activeRecordingSessionsTotal },
    ]),
    formatGauge('livestream_studio_signaling_chat_messages_total', 'Chat messages retained across active rooms.', [
      { value: snapshot.chatMessagesTotal },
    ]),
    formatGauge('livestream_studio_signaling_qa_questions_total', 'Q&A questions retained across active rooms.', [
      { value: snapshot.qaQuestionsTotal },
    ]),
    formatGauge('livestream_studio_signaling_active_polls_total', 'Open live polls across active rooms.', [
      { value: snapshot.activePollsTotal },
    ]),
  ];
  return `${lines.join('\n')}\n`;
}
