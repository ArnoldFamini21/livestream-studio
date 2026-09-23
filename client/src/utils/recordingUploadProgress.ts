import type { RecordingUploadProgressPayload } from '@studio/shared';
import {
  getProgressiveUploadPercent,
  type ProgressiveUploadState,
} from './progressiveRecordingUpload.ts';

export type RecordingUploadTone = 'active' | 'paused' | 'complete' | 'warning';

export interface RecordingUploadSummary {
  label: string;
  detail: string;
  tone: RecordingUploadTone;
  percent: number;
}

export function formatUploadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
  if (megabytes >= 10) return `${Math.round(megabytes)} MB`;
  return `${megabytes.toFixed(1)} MB`;
}

/** Host-facing summary of a participant's background upload. */
export function describeRecordingUploadProgress(
  progress: Pick<RecordingUploadProgressPayload, 'status' | 'recordedBytes' | 'uploadedBytes' | 'message'>
): RecordingUploadSummary {
  const percent = getProgressiveUploadPercent(progress);
  const detail = `${formatUploadBytes(progress.uploadedBytes)} of ${formatUploadBytes(progress.recordedBytes)}`;
  switch (progress.status) {
    case 'complete':
      return { label: 'Upload complete', detail: formatUploadBytes(progress.uploadedBytes), tone: 'complete', percent: 100 };
    case 'paused':
      return { label: `Upload paused · ${percent}%`, detail, tone: 'paused', percent };
    case 'finishing':
      return { label: `Finishing upload · ${percent}%`, detail, tone: 'active', percent };
    case 'error':
      return {
        label: 'Upload failed',
        detail: progress.message || 'The recording is saved on their device.',
        tone: 'warning',
        percent,
      };
    case 'uploading':
    default:
      return progress.message
        ? { label: `Upload retrying · ${percent}%`, detail: progress.message, tone: 'warning', percent }
        : { label: `Uploading · ${percent}%`, detail, tone: 'active', percent };
  }
}

/** Map local uploader state to the signaling report sent to hosts. */
export function toRecordingUploadProgressPayload(
  sessionId: string,
  state: ProgressiveUploadState
): RecordingUploadProgressPayload | null {
  if (state.status === 'idle') return null;
  const status = state.status === 'starting' ? 'uploading' : state.status;
  return {
    sessionId,
    status,
    recordedBytes: state.recordedBytes,
    uploadedBytes: Math.min(state.uploadedBytes, state.recordedBytes),
    trackCount: state.tracks.length,
    completedTrackCount: state.tracks.filter((track) => track.complete).length,
    ...(state.retrying && state.error ? { message: state.error.slice(0, 160) } : {}),
  };
}

/** Leaving before the upload completes would strand footage that only exists on this device. */
export function hasUnfinishedRecordingUpload(state: ProgressiveUploadState | null): boolean {
  if (!state) return false;
  return state.status === 'starting' || state.status === 'uploading' || state.status === 'paused' || state.status === 'finishing';
}
