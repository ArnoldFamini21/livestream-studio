export interface RecordingSummaryFile {
  size: number;
  kind?: string;
}

export interface RecordingSessionSummaryInput {
  durationSeconds: number | null;
  files: RecordingSummaryFile[];
  markerCount: number;
  captionCount?: number;
}

export interface RecordingSessionSummary {
  title: string;
  message: string;
  durationLabel: string;
  trackLabel: string;
  markerLabel: string;
  storageLabel: string;
  captionLabel: string | null;
  totalBytes: number;
}

export function formatRecordingSummaryDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatRecordingSummaryBytes(bytes: number): string {
  const safeBytes = Math.max(0, Math.floor(Number.isFinite(bytes) ? bytes : 0));
  if (safeBytes === 0) return '0 B';
  if (safeBytes < 1024) return `${safeBytes} B`;
  if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
  if (safeBytes < 1024 * 1024 * 1024) return `${(safeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(safeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function buildRecordingSessionSummary(input: RecordingSessionSummaryInput): RecordingSessionSummary {
  const files = input.files.filter((file) => file && Number.isFinite(file.size) && file.size > 0);
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, Math.floor(file.size)), 0);
  const trackCount = files.length;
  const markerCount = Math.max(0, Math.floor(Number.isFinite(input.markerCount) ? input.markerCount : 0));
  const captionCount = Math.max(0, Math.floor(Number.isFinite(input.captionCount) ? input.captionCount || 0 : 0));
  const durationLabel = formatRecordingSummaryDuration(input.durationSeconds);
  const trackLabel = pluralize(trackCount, 'track');
  const markerLabel = pluralize(markerCount, 'marker');
  const storageLabel = formatRecordingSummaryBytes(totalBytes);
  const captionLabel = captionCount > 0 ? pluralize(captionCount, 'caption') : null;

  const sidecars = [
    markerCount > 0 ? markerLabel : null,
    captionLabel,
  ].filter(Boolean);

  return {
    title: 'Recording saved',
    message: sidecars.length > 0
      ? `${durationLabel} captured across ${trackLabel}. Includes ${sidecars.join(' and ')}.`
      : `${durationLabel} captured across ${trackLabel}.`,
    durationLabel,
    trackLabel,
    markerLabel,
    storageLabel,
    captionLabel,
    totalBytes,
  };
}
