import type {
  RecordingUploadSessionResponse,
  RecordingUploadTrackKind,
  RecordingUploadTrackManifest,
  RecordingUploadTrackStatus,
} from '@studio/shared';
import type { RecordingCaptureMetadata } from './recordingCaptureMetadata.ts';
import { resolveMediaHttpUrl } from './apiClient.ts';

export const RECORDING_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export interface RecordingUploadFileInput {
  label: string;
  blob: Blob;
  kind?: RecordingUploadTrackKind;
  fileName?: string;
  capture?: RecordingCaptureMetadata;
}

export interface UploadRecordingToMediaServerInput {
  token: string;
  roomId: string;
  sessionId?: string | null;
  files: RecordingUploadFileInput[];
  mediaHttpUrl?: string;
  chunkSizeBytes?: number;
  onProgress?: (progress: RecordingUploadProgress) => void;
}

export interface RecordingUploadProgress {
  uploadId: string;
  trackId: string;
  trackLabel: string;
  bytesUploaded: number;
  totalBytes: number;
  trackBytesUploaded: number;
  trackBytesTotal: number;
}

export interface RecordingUploadSummary {
  uploadId: string;
  roomId: string;
  sessionId?: string;
  uploadedTracks: number;
  skippedTracks: number;
  bytesReceived: number;
  tracks: RecordingUploadTrackStatus[];
}

interface UploadableRecordingTrack {
  file: RecordingUploadFileInput;
  manifest: RecordingUploadTrackManifest;
}

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required for recording upload`);
  return trimmed;
}

function sanitizeTrackId(value: string, index: number): string {
  const cleaned = value
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return cleaned || `track-${index + 1}`;
}

function uniqueTrackId(baseId: string, seen: Set<string>): string {
  let candidate = baseId;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${baseId}-${suffix}`.slice(0, 120);
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function normalizeTrackKind(kind: RecordingUploadFileInput['kind'], mimeType: string): RecordingUploadTrackKind {
  if (kind && ['audio', 'video', 'screen', 'program', 'iso'].includes(kind)) return kind;
  return mimeType.startsWith('audio/') ? 'audio' : 'video';
}

function getWebmMimeType(file: RecordingUploadFileInput): string | null {
  const mimeType = file.blob.type.trim().toLowerCase();
  if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) return mimeType;
  if (!file.fileName || !/\.webm$/i.test(file.fileName)) return null;
  return file.kind === 'audio' ? 'audio/webm' : 'video/webm';
}

export function buildRecordingUploadTracks(files: RecordingUploadFileInput[]): {
  tracks: UploadableRecordingTrack[];
  skippedTracks: number;
} {
  const seenIds = new Set<string>();
  const tracks: UploadableRecordingTrack[] = [];
  let skippedTracks = 0;

  files.forEach((file, index) => {
    if (!file.blob || file.blob.size <= 0) {
      skippedTracks += 1;
      return;
    }
    const mimeType = getWebmMimeType(file);
    if (!mimeType) {
      skippedTracks += 1;
      return;
    }
    const id = uniqueTrackId(sanitizeTrackId(file.fileName || file.label, index), seenIds);
    const kind = normalizeTrackKind(file.kind, mimeType);
    tracks.push({
      file,
      manifest: {
        id,
        label: file.label.trim() || `Track ${index + 1}`,
        kind,
        mimeType,
        expectedBytes: file.blob.size,
        durationMs: file.capture?.durationMs,
        capture: file.capture as unknown as Record<string, unknown> | undefined,
      },
    });
  });

  return { tracks, skippedTracks };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const message = parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : `Media server returned ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function buildMediaUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function getChunkSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return RECORDING_UPLOAD_CHUNK_BYTES;
  return Math.max(256 * 1024, Math.min(RECORDING_UPLOAD_CHUNK_BYTES, Math.floor(value as number)));
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(response);
}

async function cleanupUpload(baseUrl: string, uploadId: string, token: string): Promise<void> {
  await fetch(buildMediaUrl(baseUrl, `/recordings/uploads/${encodeURIComponent(uploadId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export async function uploadRecordingToMediaServer(
  input: UploadRecordingToMediaServerInput
): Promise<RecordingUploadSummary> {
  const token = assertNonEmpty(input.token, 'A host upload token');
  const roomId = assertNonEmpty(input.roomId, 'Room id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  const { tracks, skippedTracks } = buildRecordingUploadTracks(input.files);
  if (tracks.length === 0) {
    throw new Error('No WebM recording tracks are available for media-server upload');
  }

  const totalBytes = tracks.reduce((sum, track) => sum + track.file.blob.size, 0);
  const chunkSize = getChunkSize(input.chunkSizeBytes);
  let uploadedBytes = 0;
  let uploadId = '';

  try {
    const session = await postJson<RecordingUploadSessionResponse>(
      buildMediaUrl(mediaHttpUrl, '/recordings/uploads'),
      token,
      {
        roomId,
        sessionId: input.sessionId || undefined,
        tracks: tracks.map((track) => track.manifest),
        maxBytes: totalBytes,
      }
    );
    uploadId = session.uploadId;

    for (const track of tracks) {
      let offset = 0;
      let sequence = 0;
      while (offset < track.file.blob.size) {
        const nextOffset = Math.min(track.file.blob.size, offset + chunkSize);
        const chunk = track.file.blob.slice(offset, nextOffset, track.manifest.mimeType);
        const final = nextOffset >= track.file.blob.size;
        const chunkUrl = buildMediaUrl(
          mediaHttpUrl,
          `/recordings/uploads/${encodeURIComponent(uploadId)}/tracks/${encodeURIComponent(track.manifest.id)}/chunks` +
            `?sequence=${sequence}&offset=${offset}${final ? '&final=1' : ''}`
        );
        const response = await fetch(chunkUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': track.manifest.mimeType,
          },
          body: chunk,
        });
        await parseJsonResponse(response);
        uploadedBytes += chunk.size;
        input.onProgress?.({
          uploadId,
          trackId: track.manifest.id,
          trackLabel: track.manifest.label,
          bytesUploaded: uploadedBytes,
          totalBytes,
          trackBytesUploaded: nextOffset,
          trackBytesTotal: track.file.blob.size,
        });
        offset = nextOffset;
        sequence += 1;
      }
    }

    const complete = await postJson<RecordingUploadSessionResponse>(
      buildMediaUrl(mediaHttpUrl, `/recordings/uploads/${encodeURIComponent(uploadId)}/complete`),
      token,
      {}
    );

    return {
      uploadId: complete.uploadId,
      roomId: complete.roomId,
      sessionId: complete.sessionId,
      uploadedTracks: tracks.length,
      skippedTracks,
      bytesReceived: complete.bytesReceived,
      tracks: complete.tracks,
    };
  } catch (err) {
    if (uploadId) await cleanupUpload(mediaHttpUrl, uploadId, token);
    throw err;
  }
}
