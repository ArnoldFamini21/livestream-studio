import type {
  DistributedRecordingSessionResponse,
  RecordingExportArtifactFormat,
  RecordingExportJobResponse,
  RecordingExportVideoCodec,
  RecordingUploadSessionResponse,
  RecordingUploadTrackKind,
  RecordingUploadTrackManifest,
  RecordingUploadTrackStatus,
} from '@studio/shared';
import type { RecordingCaptureMetadata } from './recordingCaptureMetadata.ts';
import { resolveMediaHttpUrl } from './apiClient.ts';

export const RECORDING_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const RECORDING_EXPORT_POLL_INTERVAL_MS = 1_500;
export const RECORDING_EXPORT_POLL_TIMEOUT_MS = 15_000;

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
  participantId?: string;
  participantName?: string;
  files: RecordingUploadFileInput[];
  mediaHttpUrl?: string;
  chunkSizeBytes?: number;
  startExport?: boolean;
  exportBasename?: string;
  exportVideoCodec?: RecordingExportVideoCodec;
  includeAudioStems?: boolean;
  normalizeAudio?: boolean;
  exportPollIntervalMs?: number;
  exportPollTimeoutMs?: number;
  onProgress?: (progress: RecordingUploadProgress) => void;
}

export interface PollRecordingExportJobInput {
  token: string;
  uploadId: string;
  exportId: string;
  mediaHttpUrl?: string;
  intervalMs?: number;
  timeoutMs?: number;
  initialJob?: RecordingExportJobResponse;
}

export interface GetRecordingExportJobInput {
  token: string;
  uploadId: string;
  exportId: string;
  mediaHttpUrl?: string;
}

export interface RequestRecordingClipExportInput {
  token: string;
  uploadId: string;
  /** A single trimmed range. Mutually exclusive with `edl`. */
  clip?: { startSeconds: number; endSeconds: number; aspect?: 'source' | 'vertical' | 'square' };
  /** The kept ranges of a transcript edit. Mutually exclusive with `clip`. */
  edl?: {
    segments: Array<{ startSeconds: number; endSeconds: number }>;
    aspect?: 'source' | 'vertical' | 'square';
  };
  basename?: string;
  exportVideoCodec?: RecordingExportVideoCodec;
  includeAudioStems?: boolean;
  normalizeAudio?: boolean;
  mediaHttpUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface DownloadRecordingExportArtifactInput {
  token: string;
  uploadId: string;
  exportId: string;
  artifactId: string;
  artifactLabel?: string;
  format?: RecordingExportArtifactFormat;
  mediaHttpUrl?: string;
}

export interface RecordingExportArtifactDownload {
  blob: Blob;
  fileName: string;
  contentType: string;
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
  exportJob?: RecordingExportJobResponse;
  exportError?: string;
}

export interface DistributedRecordingSessionInput {
  token: string;
  roomId: string;
  sessionId: string;
  mediaHttpUrl?: string;
}

export interface WaitForDistributedRecordingSessionInput extends DistributedRecordingSessionInput {
  expectedUploads: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface ExportDistributedRecordingSessionInput extends DistributedRecordingSessionInput {
  basename?: string;
  includeAudioStems?: boolean;
  normalizeAudio?: boolean;
  exportVideoCodec?: RecordingExportVideoCodec;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
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

function getUploadableRecordingMimeType(file: RecordingUploadFileInput): string | null {
  const mimeType = file.blob.type.trim().toLowerCase();
  if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) return mimeType;
  if (mimeType.startsWith('audio/mp4') || mimeType.startsWith('video/mp4')) return mimeType;
  if (!file.fileName) return null;
  if (/\.webm$/i.test(file.fileName)) return file.kind === 'audio' ? 'audio/webm' : 'video/webm';
  if (/\.m4a$/i.test(file.fileName)) return 'audio/mp4';
  if (/\.mp4$/i.test(file.fileName)) return file.kind === 'audio' ? 'audio/mp4' : 'video/mp4';
  return null;
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
    const mimeType = getUploadableRecordingMimeType(file);
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

function getPollIntervalMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return RECORDING_EXPORT_POLL_INTERVAL_MS;
  return Math.max(0, Math.min(30_000, Math.floor(value as number)));
}

function getPollTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return RECORDING_EXPORT_POLL_TIMEOUT_MS;
  return Math.max(0, Math.min(10 * 60_000, Math.floor(value as number)));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function getExportArtifactExtension(format: RecordingExportArtifactFormat | undefined, contentType: string): string {
  if (format === 'json' || contentType.includes('application/json')) return 'json';
  if (format === 'wav' || contentType.includes('audio/wav')) return 'wav';
  if (format === 'mp3' || contentType.includes('audio/mpeg')) return 'mp3';
  return 'mp4';
}

function safeArtifactFileName(value: string, extension: string): string {
  const trimmed = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  const base = trimmed || 'recording-export';
  return new RegExp(`\\.${extension}$`, 'i').test(base) ? base : `${base}.${extension}`;
}

function parseContentDispositionFileName(value: string | null): string {
  if (!value) return '';
  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim());
    } catch {
      return encodedMatch[1].trim();
    }
  }
  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1].trim();
  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() || '';
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

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseJsonResponse<T>(response);
}

async function cleanupUpload(baseUrl: string, uploadId: string, token: string): Promise<void> {
  await fetch(buildMediaUrl(baseUrl, `/recordings/uploads/${encodeURIComponent(uploadId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

export async function pollRecordingExportJob(
  input: PollRecordingExportJobInput
): Promise<RecordingExportJobResponse> {
  const token = assertNonEmpty(input.token, 'A host upload token');
  const uploadId = assertNonEmpty(input.uploadId, 'Upload id');
  const exportId = assertNonEmpty(input.exportId, 'Export id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  const timeoutMs = getPollTimeoutMs(input.timeoutMs);
  const intervalMs = getPollIntervalMs(input.intervalMs);
  const deadline = Date.now() + timeoutMs;
  let latest = input.initialJob;

  while (!latest || (latest.status !== 'ready' && latest.status !== 'error')) {
    if (Date.now() > deadline) {
      if (latest) return latest;
      throw new Error('Timed out while checking recording export status');
    }
    if (latest) {
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
    latest = await getRecordingExportJob({ token, uploadId, exportId, mediaHttpUrl });
  }

  return latest;
}

export async function getRecordingExportJob(
  input: GetRecordingExportJobInput
): Promise<RecordingExportJobResponse> {
  const token = assertNonEmpty(input.token, 'A host upload token');
  const uploadId = assertNonEmpty(input.uploadId, 'Upload id');
  const exportId = assertNonEmpty(input.exportId, 'Export id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  return getJson<RecordingExportJobResponse>(
    buildMediaUrl(
      mediaHttpUrl,
      `/recordings/uploads/${encodeURIComponent(uploadId)}/exports/${encodeURIComponent(exportId)}`
    ),
    token
  );
}

export async function requestRecordingClipExport(
  input: RequestRecordingClipExportInput
): Promise<RecordingExportJobResponse> {
  const token = assertNonEmpty(input.token, 'A host upload token');
  const uploadId = assertNonEmpty(input.uploadId, 'Upload id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  if (input.clip && input.edl) {
    throw new Error('Request either a clip range or an edit list, not both');
  }
  if (!input.clip && !(input.edl && input.edl.segments.length > 0)) {
    throw new Error('A clip range or an edit list is required for a server export');
  }
  const job = await postJson<RecordingExportJobResponse>(
    buildMediaUrl(mediaHttpUrl, `/recordings/uploads/${encodeURIComponent(uploadId)}/exports`),
    token,
    {
      basename: input.basename || undefined,
      includeAudioStems: input.includeAudioStems === true,
      normalizeAudio: input.normalizeAudio === true,
      video: {
        codec: input.exportVideoCodec || 'h264',
      },
      ...(input.clip
        ? {
            clip: {
              startSeconds: input.clip.startSeconds,
              endSeconds: input.clip.endSeconds,
              aspect: input.clip.aspect || undefined,
            },
          }
        : {}),
      ...(input.edl
        ? {
            edl: {
              segments: input.edl.segments.map((segment) => ({
                startSeconds: segment.startSeconds,
                endSeconds: segment.endSeconds,
              })),
              aspect: input.edl.aspect || undefined,
            },
          }
        : {}),
    }
  );
  return pollRecordingExportJob({
    token,
    uploadId,
    exportId: job.exportId,
    mediaHttpUrl,
    intervalMs: input.pollIntervalMs,
    timeoutMs: input.pollTimeoutMs,
    initialJob: job,
  });
}

export async function downloadRecordingExportArtifact(
  input: DownloadRecordingExportArtifactInput
): Promise<RecordingExportArtifactDownload> {
  const token = assertNonEmpty(input.token, 'A host upload token');
  const uploadId = assertNonEmpty(input.uploadId, 'Upload id');
  const exportId = assertNonEmpty(input.exportId, 'Export id');
  const artifactId = assertNonEmpty(input.artifactId, 'Artifact id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  const response = await fetch(
    buildMediaUrl(
      mediaHttpUrl,
      `/recordings/uploads/${encodeURIComponent(uploadId)}/exports/${encodeURIComponent(exportId)}/artifacts/${encodeURIComponent(artifactId)}`
    ),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    await parseJsonResponse(response);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const extension = getExportArtifactExtension(input.format, contentType.toLowerCase());
  const headerFileName = parseContentDispositionFileName(response.headers.get('content-disposition'));
  const fileName = safeArtifactFileName(headerFileName || input.artifactLabel || artifactId, extension);
  return {
    blob: await response.blob(),
    fileName,
    contentType,
  };
}

export async function uploadRecordingToMediaServer(
  input: UploadRecordingToMediaServerInput
): Promise<RecordingUploadSummary> {
  const token = assertNonEmpty(input.token, 'A host upload token');
  const roomId = assertNonEmpty(input.roomId, 'Room id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  const { tracks, skippedTracks } = buildRecordingUploadTracks(input.files);
  if (tracks.length === 0) {
    throw new Error('No uploadable MP4 or WebM recording tracks are available for media-server upload');
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
        participantId: input.participantId?.trim() || undefined,
        participantName: input.participantName?.trim() || undefined,
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
    let exportJob: RecordingExportJobResponse | undefined;
    let exportError: string | undefined;
    if (input.startExport !== false) {
      try {
        exportJob = await postJson<RecordingExportJobResponse>(
          buildMediaUrl(mediaHttpUrl, `/recordings/uploads/${encodeURIComponent(uploadId)}/exports`),
          token,
          {
            basename: input.exportBasename || input.sessionId || uploadId,
            includeAudioStems: input.includeAudioStems !== false,
            normalizeAudio: input.normalizeAudio === true,
            video: {
              codec: input.exportVideoCodec || 'h264',
            },
          }
        );
        exportJob = await pollRecordingExportJob({
          token,
          uploadId,
          exportId: exportJob.exportId,
          mediaHttpUrl,
          intervalMs: input.exportPollIntervalMs,
          timeoutMs: input.exportPollTimeoutMs,
          initialJob: exportJob,
        });
      } catch (err) {
        exportError = err instanceof Error && err.message
          ? err.message
          : 'Media server export could not be started';
      }
    }

    return {
      uploadId: complete.uploadId,
      roomId: complete.roomId,
      sessionId: complete.sessionId,
      uploadedTracks: tracks.length,
      skippedTracks,
      bytesReceived: complete.bytesReceived,
      tracks: complete.tracks,
      exportJob,
      exportError,
    };
  } catch (err) {
    if (uploadId) await cleanupUpload(mediaHttpUrl, uploadId, token);
    throw err;
  }
}

export async function getDistributedRecordingSession(
  input: DistributedRecordingSessionInput
): Promise<DistributedRecordingSessionResponse> {
  const token = assertNonEmpty(input.token, 'A host recording token');
  const roomId = assertNonEmpty(input.roomId, 'Room id');
  const sessionId = assertNonEmpty(input.sessionId, 'Recording session id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  return getJson<DistributedRecordingSessionResponse>(
    buildMediaUrl(
      mediaHttpUrl,
      `/recordings/sessions/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`
    ),
    token
  );
}

export async function waitForDistributedRecordingSession(
  input: WaitForDistributedRecordingSessionInput
): Promise<DistributedRecordingSessionResponse> {
  const expectedUploads = Math.max(1, Math.floor(input.expectedUploads));
  const intervalMs = getPollIntervalMs(input.intervalMs);
  const timeoutMs = getPollTimeoutMs(input.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let latest = await getDistributedRecordingSession(input);

  while (
    latest.completedUploadCount < expectedUploads &&
    Date.now() < deadline
  ) {
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    latest = await getDistributedRecordingSession(input);
  }
  return latest;
}

export async function exportDistributedRecordingSession(
  input: ExportDistributedRecordingSessionInput
): Promise<RecordingExportJobResponse> {
  const token = assertNonEmpty(input.token, 'A host recording token');
  const roomId = assertNonEmpty(input.roomId, 'Room id');
  const sessionId = assertNonEmpty(input.sessionId, 'Recording session id');
  const mediaHttpUrl = assertNonEmpty(input.mediaHttpUrl || resolveMediaHttpUrl(), 'Media server URL');
  let job = await postJson<RecordingExportJobResponse>(
    buildMediaUrl(
      mediaHttpUrl,
      `/recordings/sessions/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}/exports`
    ),
    token,
    {
      basename: input.basename || sessionId,
      includeAudioStems: input.includeAudioStems !== false,
      normalizeAudio: input.normalizeAudio === true,
      video: { codec: input.exportVideoCodec || 'h264' },
    }
  );
  job = await pollRecordingExportJob({
    token,
    uploadId: job.uploadId,
    exportId: job.exportId,
    mediaHttpUrl,
    intervalMs: input.pollIntervalMs,
    timeoutMs: input.pollTimeoutMs,
    initialJob: job,
  });
  return job;
}
