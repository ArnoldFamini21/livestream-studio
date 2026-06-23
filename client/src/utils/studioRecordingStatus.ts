export interface StudioRecordingStatusInput {
  mixRecording: boolean;
  mixFormattedTime: string;
  localRecording: boolean;
  localFormattedTime: string;
  sessionStartedAt: string | null;
  sessionElapsedSeconds: number;
}

export interface StudioRecordingStatus {
  active: boolean;
  formattedTime: string;
  source: 'mix' | 'session' | 'local' | null;
}

export function formatStudioRecordingDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function getStudioRecordingStatus(input: StudioRecordingStatusInput): StudioRecordingStatus {
  if (input.mixRecording) {
    return {
      active: true,
      formattedTime: input.mixFormattedTime || '0:00',
      source: 'mix',
    };
  }

  if (input.sessionStartedAt) {
    return {
      active: true,
      formattedTime: formatStudioRecordingDuration(input.sessionElapsedSeconds),
      source: 'session',
    };
  }

  if (input.localRecording) {
    return {
      active: true,
      formattedTime: input.localFormattedTime || '0:00',
      source: 'local',
    };
  }

  return {
    active: false,
    formattedTime: '0:00',
    source: null,
  };
}
