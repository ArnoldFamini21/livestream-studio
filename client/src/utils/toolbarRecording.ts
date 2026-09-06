import type { RecordingUploadFileInput } from './recordingUpload.ts';
import { getRecordingFileExtension, summarizeRecordingFileFormats } from './recordingMimeTypes.ts';
import type { RecordingTrackResult } from '../hooks/useRecording.ts';

function sanitizeRecordingFileNamePart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function formatRecordingTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

export function makeToolbarRecordingFileName(name: string, blob: Blob, timestamp: string): string {
  const label = sanitizeRecordingFileNamePart(name, 'recording');
  return `${label}_${timestamp}.${getRecordingFileExtension(blob.type)}`;
}

export function buildToolbarRecordingUploadFiles(
  recordings: Map<string, RecordingTrackResult>,
  timestamp: string
): RecordingUploadFileInput[] {
  return Array.from(recordings.values())
    .filter(({ blob }) => blob.size > 0)
    .map(({ name, blob, kind }) => ({
      label: name.trim() || 'Recording',
      blob,
      fileName: makeToolbarRecordingFileName(name, blob, timestamp),
      kind: kind || (blob.type.toLowerCase().startsWith('audio/') ? 'audio' : 'iso'),
    }));
}

export function getToolbarRecordingFallbackToast(files: RecordingUploadFileInput[]): string {
  const summary = summarizeRecordingFileFormats(files);
  if (summary.allBrowserMp4Compatible) {
    return 'Media-server final MP4 mix unavailable. Saved browser-native MP4/M4A recording tracks.';
  }
  if (summary.hasBrowserMp4CompatibleFiles) {
    return 'Media-server final MP4 mix unavailable. Saved MP4/M4A and browser fallback tracks separately.';
  }
  return 'MP4 export was unavailable. Saved original recording tracks instead.';
}

/** Match the button action to the same recording sources displayed by the toolbar. */
export function getToolbarRecordingAction(state: {
  mixRecording: boolean;
  sessionStartedAt: string | null;
  localRecording: boolean;
}): 'stop-mix' | 'stop-session' | 'stop-local' | 'start' {
  if (state.mixRecording) return 'stop-mix';
  if (state.sessionStartedAt) return 'stop-session';
  if (state.localRecording) return 'stop-local';
  return 'start';
}
