import { formatStudioRecordingDuration } from './studioRecordingStatus.ts';

export interface LiveStreamStatusInput {
  live: boolean;
  startedAt: string | null;
  elapsedSeconds: number;
}

export interface LiveStreamStatus {
  active: boolean;
  formattedTime: string;
  startedAt: string | null;
}

export interface LiveSessionSummaryInput {
  startedAt: string | null;
  stoppedAt?: string | null;
  destinationCount: number;
  errorCount?: number;
  relayError?: boolean;
  destinations?: LiveSessionDestinationInput[];
}

export interface LiveSessionDestinationInput {
  id?: string;
  name: string;
  enabled?: boolean;
  status?: 'idle' | 'connecting' | 'live' | 'error';
  statusMessage?: string;
}

export interface LiveSessionDestinationOutcome {
  id: string;
  name: string;
  status: 'success' | 'warning' | 'error';
  label: string;
  detail?: string;
}

export interface LiveSessionSummary {
  title: string;
  message: string;
  tone: 'success' | 'warning';
  formattedDuration: string;
  destinationLabel: string;
  destinationOutcomes: LiveSessionDestinationOutcome[];
}

export function getLiveStreamElapsedSeconds(startedAt: string | null, nowMs = Date.now()): number {
  if (!startedAt) return 0;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

export function getLiveStreamStatus(input: LiveStreamStatusInput): LiveStreamStatus {
  if (!input.live) {
    return {
      active: false,
      formattedTime: '0:00',
      startedAt: null,
    };
  }

  return {
    active: true,
    formattedTime: formatStudioRecordingDuration(input.elapsedSeconds),
    startedAt: input.startedAt,
  };
}

function pluralizeDestinations(count: number): string {
  return `${count} destination${count === 1 ? '' : 's'}`;
}

function buildDestinationOutcome(
  destination: LiveSessionDestinationInput,
  index: number,
  relayError: boolean
): LiveSessionDestinationOutcome {
  const id = destination.id || `destination-${index + 1}`;
  const name = destination.name.trim() || `Destination ${index + 1}`;
  if (relayError || destination.status === 'error') {
    return {
      id,
      name,
      status: 'error',
      label: 'Issue',
      detail: destination.statusMessage || 'Relay ended before this destination confirmed a clean stop.',
    };
  }
  if (destination.status === 'live') {
    return {
      id,
      name,
      status: 'success',
      label: 'Live',
      detail: destination.statusMessage || 'Destination reported live before the stream stopped.',
    };
  }
  if (destination.status === 'connecting') {
    return {
      id,
      name,
      status: 'warning',
      label: 'Connecting',
      detail: destination.statusMessage || 'Destination was still connecting when the stream ended.',
    };
  }
  return {
    id,
    name,
    status: 'warning',
    label: 'Not confirmed',
    detail: destination.statusMessage || 'No live confirmation was received before the stream ended.',
  };
}

export function buildLiveSessionSummary(input: LiveSessionSummaryInput): LiveSessionSummary {
  const destinationOutcomes = (input.destinations || [])
    .filter((destination) => destination.enabled !== false)
    .map((destination, index) => buildDestinationOutcome(destination, index, input.relayError === true));
  const destinationCount = destinationOutcomes.length > 0
    ? destinationOutcomes.length
    : Number.isFinite(input.destinationCount) ? Math.floor(input.destinationCount) : 0;
  const outcomeErrorCount = destinationOutcomes.filter((outcome) => outcome.status === 'error').length;
  const outcomeWarningCount = destinationOutcomes.filter((outcome) => outcome.status === 'warning').length;
  const errorCount = Number.isFinite(input.errorCount)
    ? Math.max(outcomeErrorCount, Math.floor(input.errorCount || 0))
    : outcomeErrorCount;
  const safeDestinationCount = Math.max(0, destinationCount);
  const safeErrorCount = Math.max(0, Math.min(safeDestinationCount, errorCount));
  const stoppedAtMs = input.stoppedAt ? Date.parse(input.stoppedAt) : Date.now();
  const durationSeconds = getLiveStreamElapsedSeconds(
    input.startedAt,
    Number.isFinite(stoppedAtMs) ? stoppedAtMs : Date.now(),
  );
  const formattedDuration = formatStudioRecordingDuration(durationSeconds);
  const destinationLabel = pluralizeDestinations(safeDestinationCount);

  if (safeErrorCount > 0) {
    return {
      title: 'Stream ended with issues',
      message: `Stream ran for ${formattedDuration}. ${safeErrorCount}/${safeDestinationCount} destination${safeDestinationCount === 1 ? '' : 's'} reported an error.`,
      tone: 'warning',
      formattedDuration,
      destinationLabel,
      destinationOutcomes,
    };
  }

  if (outcomeWarningCount > 0) {
    return {
      title: 'Stream ended; review destinations',
      message: `Stream ran for ${formattedDuration}. ${outcomeWarningCount}/${safeDestinationCount} destination${safeDestinationCount === 1 ? '' : 's'} did not confirm live delivery.`,
      tone: 'warning',
      formattedDuration,
      destinationLabel,
      destinationOutcomes,
    };
  }

  return {
    title: 'Stream ended',
    message: safeDestinationCount > 0
      ? `Stream ran for ${formattedDuration}. ${destinationLabel} finished cleanly.`
      : `Stream ran for ${formattedDuration}. No destinations were enabled.`,
    tone: 'success',
    formattedDuration,
    destinationLabel,
    destinationOutcomes,
  };
}
