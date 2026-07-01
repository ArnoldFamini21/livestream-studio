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
}

export interface LiveSessionSummary {
  title: string;
  message: string;
  tone: 'success' | 'warning';
  formattedDuration: string;
  destinationLabel: string;
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

export function buildLiveSessionSummary(input: LiveSessionSummaryInput): LiveSessionSummary {
  const destinationCount = Number.isFinite(input.destinationCount) ? Math.floor(input.destinationCount) : 0;
  const errorCount = Number.isFinite(input.errorCount) ? Math.floor(input.errorCount || 0) : 0;
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
  };
}
