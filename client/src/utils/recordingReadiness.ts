export type RecordingReadinessStatus = 'good' | 'warning' | 'bad';

export interface RecordingParticipantReadiness {
  id: string;
  name: string;
  status: 'on-stage' | 'backstage' | 'green-room';
  isLocal?: boolean;
  hasStream: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  screenSharing?: boolean;
}

export interface RecordingScreenReadiness {
  active: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface RecordingReadinessOptions {
  participants: RecordingParticipantReadiness[];
  screen: RecordingScreenReadiness;
  mediaRecorderSupported: boolean;
  encodingReadiness?: RecordingEncodingReadiness;
  persistentStorageSupported: boolean;
  captionsEnabled: boolean;
  markerCount: number;
}

export interface RecordingEncodingReadiness {
  status: 'ready' | 'limited' | 'unsupported';
  detail: string;
}

export interface RecordingReadinessTrack {
  id: string;
  label: string;
  kind: 'audio' | 'video' | 'screen' | 'iso';
}

export interface RecordingReadinessItem {
  id: string;
  label: string;
  status: RecordingReadinessStatus;
  detail: string;
  blocksStart: boolean;
}

export interface RecordingReadinessSummary {
  status: RecordingReadinessStatus;
  label: string;
  canStart: boolean;
  blockingIssue: string | null;
  expectedTracks: RecordingReadinessTrack[];
  items: RecordingReadinessItem[];
}

function getStatusLabel(status: RecordingReadinessStatus): string {
  switch (status) {
    case 'good': return 'Ready';
    case 'warning': return 'Review';
    case 'bad': return 'Blocked';
  }
}

function getReadinessStatus(items: RecordingReadinessItem[]): RecordingReadinessStatus {
  if (items.some((item) => item.blocksStart && item.status === 'bad')) return 'bad';
  if (items.some((item) => item.status !== 'good')) return 'warning';
  return 'good';
}

function buildEncodingReadinessItem(encodingReadiness: RecordingEncodingReadiness | undefined): RecordingReadinessItem | null {
  if (!encodingReadiness) return null;

  switch (encodingReadiness.status) {
    case 'ready':
      return {
        id: 'encoding-quality',
        label: 'Encoding quality',
        status: 'good',
        detail: encodingReadiness.detail,
        blocksStart: false,
      };
    case 'limited':
      return {
        id: 'encoding-quality',
        label: 'Encoding quality',
        status: 'warning',
        detail: encodingReadiness.detail,
        blocksStart: false,
      };
    case 'unsupported':
      return {
        id: 'encoding-quality',
        label: 'Encoding quality',
        status: 'bad',
        detail: encodingReadiness.detail,
        blocksStart: true,
      };
  }
}

function buildExpectedTracks(options: RecordingReadinessOptions): RecordingReadinessTrack[] {
  const tracks: RecordingReadinessTrack[] = [];
  for (const participant of options.participants) {
    if (participant.status !== 'on-stage' || !participant.hasStream) continue;
    const prefix = participant.name || 'Participant';
    if (!participant.screenSharing && participant.hasAudio && participant.hasVideo) {
      tracks.push({
        id: `${participant.id}-iso`,
        label: `${prefix} ISO`,
        kind: 'iso',
      });
    }
    if (participant.hasAudio) {
      tracks.push({
        id: `${participant.id}-audio`,
        label: `${prefix} audio`,
        kind: 'audio',
      });
    }
    if (participant.hasVideo) {
      tracks.push({
        id: `${participant.id}-${participant.screenSharing ? 'screen' : 'camera'}`,
        label: `${prefix} ${participant.screenSharing ? 'screen' : 'camera'}`,
        kind: participant.screenSharing ? 'screen' : 'video',
      });
    }
  }

  if (options.screen.active && options.screen.hasVideo) {
    const local = options.participants.find((participant) => participant.isLocal);
    const prefix = local?.name || 'Host';
    tracks.push({
      id: 'local-screen',
      label: `${prefix} screen`,
      kind: 'screen',
    });
    if (local?.status === 'on-stage' && local.hasVideo) {
      tracks.push({
        id: 'local-screen-pip',
        label: `${prefix} screen PiP`,
        kind: 'screen',
      });
    }
  }
  if (options.screen.active && options.screen.hasAudio) {
    const local = options.participants.find((participant) => participant.isLocal);
    const prefix = local?.name || 'Host';
    tracks.push({
      id: 'local-screen-audio',
      label: `${prefix} screen audio`,
      kind: 'audio',
    });
  }

  return tracks;
}

export function buildRecordingReadinessSummary(options: RecordingReadinessOptions): RecordingReadinessSummary {
  const expectedTracks = buildExpectedTracks(options);
  const onStageParticipants = options.participants.filter((participant) => participant.status === 'on-stage');
  const missingRemoteStreams = onStageParticipants.filter((participant) => !participant.isLocal && !participant.hasStream);
  const missingMedia = onStageParticipants.filter((participant) => participant.hasStream && !participant.hasAudio && !participant.hasVideo);
  const recordingKinds = new Set(expectedTracks.map((track) => track.kind));
  const encodingItem = buildEncodingReadinessItem(options.encodingReadiness);

  const items: RecordingReadinessItem[] = [
    {
      id: 'browser-recorder',
      label: 'Browser recorder',
      status: options.mediaRecorderSupported ? 'good' : 'bad',
      detail: options.mediaRecorderSupported
        ? 'MediaRecorder is available for local track capture.'
        : 'This browser does not support MediaRecorder.',
      blocksStart: true,
    },
    ...(encodingItem ? [encodingItem] : []),
    {
      id: 'isolated-tracks',
      label: 'Isolated tracks',
      status: expectedTracks.length === 0 ? 'bad' : missingRemoteStreams.length > 0 || missingMedia.length > 0 ? 'warning' : 'good',
      detail: expectedTracks.length === 0
        ? 'No on-stage audio, camera, or screen tracks are available.'
        : `${expectedTracks.length} track${expectedTracks.length === 1 ? '' : 's'} ready${missingRemoteStreams.length > 0 ? `; ${missingRemoteStreams.length} remote stream${missingRemoteStreams.length === 1 ? '' : 's'} not connected` : ''}${missingMedia.length > 0 ? `; ${missingMedia.length} participant${missingMedia.length === 1 ? '' : 's'} have no live media` : ''}.`,
      blocksStart: true,
    },
    {
      id: 'track-coverage',
      label: 'Track coverage',
      status: recordingKinds.has('audio') && (recordingKinds.has('video') || recordingKinds.has('screen')) ? 'good' : 'warning',
      detail: recordingKinds.has('audio') && (recordingKinds.has('video') || recordingKinds.has('screen'))
        ? 'Audio plus camera or screen tracks are ready for editing.'
        : 'Recording can start, but at least one media type is missing.',
      blocksStart: false,
    },
    {
      id: 'storage',
      label: 'Recording storage',
      status: options.persistentStorageSupported ? 'good' : 'warning',
      detail: options.persistentStorageSupported
        ? 'Browser file storage is available for long recordings.'
        : 'This browser may keep recording chunks in memory.',
      blocksStart: false,
    },
    {
      id: 'editor-sidecars',
      label: 'Editor sidecars',
      status: options.captionsEnabled || options.markerCount > 0 ? 'good' : 'warning',
      detail: options.captionsEnabled || options.markerCount > 0
        ? `${options.captionsEnabled ? 'Captions' : 'No captions'} and ${options.markerCount} marker${options.markerCount === 1 ? '' : 's'} will be included when available.`
        : 'Add markers or captions for richer editor bundle exports.',
      blocksStart: false,
    },
  ];

  const status = getReadinessStatus(items);
  const blockingIssue = items.find((item) => item.blocksStart && item.status === 'bad')?.detail || null;

  return {
    status,
    label: getStatusLabel(status),
    canStart: status !== 'bad',
    blockingIssue,
    expectedTracks,
    items,
  };
}
