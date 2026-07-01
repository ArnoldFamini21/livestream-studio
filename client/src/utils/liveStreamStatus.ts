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
