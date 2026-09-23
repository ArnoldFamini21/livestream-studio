import type {
  RecordingUploadChunkResponse,
  RecordingUploadProgressStatus,
  RecordingUploadSessionResponse,
  RecordingUploadTrackKind,
  RecordingUploadTrackStatus,
} from '@studio/shared';

/**
 * Progressive (Riverside-style) recording upload.
 *
 * While a take is recording, committed bytes are uploaded in the background
 * so the cloud copy is nearly complete when recording stops. The uploader
 * never holds recording data itself: each cycle takes a snapshot of the bytes
 * already committed by the recorder (OPFS-backed where available) and sends
 * only the range the media server has not acknowledged yet. When recording
 * stops, the finished file — byte-identical to the committed chunk sequence —
 * supplies the remainder. Offsets are reconciled with the server after any
 * lost response, so retries never duplicate or skip bytes.
 */

export const PROGRESSIVE_UPLOAD_INTERVAL_MS = 4_000;
export const PROGRESSIVE_UPLOAD_MIN_CHUNK_BYTES = 1024 * 1024;
export const PROGRESSIVE_UPLOAD_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const PROGRESSIVE_UPLOAD_MAX_IDLE_MS = 15_000;
export const PROGRESSIVE_UPLOAD_RETRY_BASE_MS = 1_000;
export const PROGRESSIVE_UPLOAD_MAX_RETRY_DELAY_MS = 30_000;
export const PROGRESSIVE_UPLOAD_FINISH_ATTEMPTS = 6;

export interface ProgressiveUploadTrackSource {
  id: string;
  label: string;
  kind: RecordingUploadTrackKind;
  mimeType: string;
  capture?: Record<string, unknown>;
  /** Bytes committed so far, in capture order. */
  snapshot(): Promise<Blob>;
}

export interface ProgressiveUploadTrackState {
  id: string;
  label: string;
  kind: RecordingUploadTrackKind;
  recordedBytes: number;
  uploadedBytes: number;
  complete: boolean;
}

export type ProgressiveUploadStatus = 'idle' | 'starting' | RecordingUploadProgressStatus;

export interface ProgressiveUploadState {
  status: ProgressiveUploadStatus;
  uploadId: string | null;
  recordedBytes: number;
  uploadedBytes: number;
  tracks: ProgressiveUploadTrackState[];
  pausedByHost: boolean;
  retrying: boolean;
  error?: string;
}

/** Final per-track details that are only known once recording stops. */
export interface ProgressiveUploadTrackCompletion {
  durationMs?: number;
  capture?: Record<string, unknown>;
}

/** The media server reads at most 32 KiB of completion metadata. */
export const PROGRESSIVE_UPLOAD_COMPLETION_MAX_BYTES = 24 * 1024;

/** Build the /complete body, dropping capture detail before it exceeds the server's limit. */
export function buildProgressiveCompletionBody(
  trackIds: string[],
  metadata: ReadonlyMap<string, ProgressiveUploadTrackCompletion> | undefined
): string {
  if (!metadata || metadata.size === 0) return '{}';
  const entries = trackIds.flatMap((id) => {
    const item = metadata.get(id);
    if (!item) return [];
    const durationMs = Number.isSafeInteger(item.durationMs) && (item.durationMs as number) >= 0
      ? item.durationMs
      : undefined;
    return [{ id, durationMs, capture: item.capture }];
  });
  const full = JSON.stringify({ tracks: entries });
  if (full.length <= PROGRESSIVE_UPLOAD_COMPLETION_MAX_BYTES) return full;
  return JSON.stringify({ tracks: entries.map(({ id, durationMs }) => ({ id, durationMs })) });
}

export interface ProgressiveUploadResult {
  uploadId: string;
  roomId: string;
  sessionId?: string;
  bytesReceived: number;
  tracks: RecordingUploadTrackStatus[];
}

export interface ProgressiveRecordingUploaderOptions {
  mediaHttpUrl: string;
  roomId: string;
  sessionId?: string;
  participantId?: string;
  participantName?: string;
  getToken: (options: { forceRefresh: boolean }) => Promise<string>;
  /** Refresh short-lived tokens proactively (host live tokens last 5 minutes). */
  tokenRefreshMs?: number;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  minChunkBytes?: number;
  maxChunkBytes?: number;
  maxIdleMs?: number;
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
  finishAttempts?: number;
  /** Disable the background timer (tests drive cycles with flush()). */
  autoSchedule?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange?: (state: ProgressiveUploadState) => void;
}

export interface ProgressiveRecordingUploader {
  start(tracks: ProgressiveUploadTrackSource[]): void;
  /** Run one upload cycle now. Resolves when the cycle ends; never rejects. */
  flush(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Upload the remainder from the finished files and mark the session complete. */
  finish(
    finalBlobs: ReadonlyMap<string, Blob>,
    metadata?: ReadonlyMap<string, ProgressiveUploadTrackCompletion>
  ): Promise<ProgressiveUploadResult>;
  /** Stop background work without deleting what the server already has. */
  stop(): void;
  getState(): ProgressiveUploadState;
}

class ProgressiveUploadHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ProgressiveUploadHttpError';
  }
}

interface TrackUpload {
  source: ProgressiveUploadTrackSource;
  recordedBytes: number;
  uploadedBytes: number;
  sequence: number;
  complete: boolean;
  lastSentAt: number;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
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
    const body = parsed && typeof parsed === 'object' ? parsed as { error?: unknown; code?: unknown } : {};
    throw new ProgressiveUploadHttpError(
      response.status,
      typeof body.code === 'string' ? body.code : '',
      typeof body.error === 'string' ? body.error : `Media server returned ${response.status}`
    );
  }
  return parsed as T;
}

function clampPositive(value: number | undefined, fallback: number, min = 0): number {
  return Number.isFinite(value) && (value as number) >= min ? Math.floor(value as number) : fallback;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Recording upload failed';
}

export function createProgressiveRecordingUploader(
  options: ProgressiveRecordingUploaderOptions
): ProgressiveRecordingUploader {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const intervalMs = clampPositive(options.intervalMs, PROGRESSIVE_UPLOAD_INTERVAL_MS);
  const maxChunkBytes = clampPositive(options.maxChunkBytes, PROGRESSIVE_UPLOAD_MAX_CHUNK_BYTES, 1);
  const minChunkBytes = Math.min(maxChunkBytes, clampPositive(options.minChunkBytes, PROGRESSIVE_UPLOAD_MIN_CHUNK_BYTES, 1));
  const maxIdleMs = clampPositive(options.maxIdleMs, PROGRESSIVE_UPLOAD_MAX_IDLE_MS);
  const retryBaseMs = clampPositive(options.retryBaseMs, PROGRESSIVE_UPLOAD_RETRY_BASE_MS);
  const maxRetryDelayMs = clampPositive(options.maxRetryDelayMs, PROGRESSIVE_UPLOAD_MAX_RETRY_DELAY_MS);
  const finishAttempts = clampPositive(options.finishAttempts, PROGRESSIVE_UPLOAD_FINISH_ATTEMPTS, 1);
  const tokenRefreshMs = clampPositive(options.tokenRefreshMs, Number.POSITIVE_INFINITY);
  const autoSchedule = options.autoSchedule !== false;

  const tracks = new Map<string, TrackUpload>();
  let uploadId: string | null = null;
  let status: ProgressiveUploadStatus = 'idle';
  let pausedByHost = false;
  let stopped = false;
  let finishing = false;
  let consecutiveFailures = 0;
  let lastError: string | undefined;
  let timer: unknown = null;
  let activeCycle: Promise<void> | null = null;
  let token: { value: string; fetchedAt: number } | null = null;

  const getState = (): ProgressiveUploadState => {
    const trackStates = Array.from(tracks.values()).map((track) => ({
      id: track.source.id,
      label: track.source.label,
      kind: track.source.kind,
      recordedBytes: track.recordedBytes,
      uploadedBytes: track.uploadedBytes,
      complete: track.complete,
    }));
    return {
      status,
      uploadId,
      recordedBytes: trackStates.reduce((sum, track) => sum + track.recordedBytes, 0),
      uploadedBytes: trackStates.reduce((sum, track) => sum + track.uploadedBytes, 0),
      tracks: trackStates,
      pausedByHost,
      retrying: consecutiveFailures > 0,
      ...(lastError ? { error: lastError } : {}),
    };
  };

  const emit = () => {
    try {
      options.onChange?.(getState());
    } catch {
      // Progress reporting must never interrupt an upload.
    }
  };

  const setStatus = (next: ProgressiveUploadStatus) => {
    if (status === next) return;
    status = next;
    emit();
  };

  const resolveToken = async (forceRefresh = false): Promise<string> => {
    if (!forceRefresh && token && now() - token.fetchedAt < tokenRefreshMs) return token.value;
    const value = (await options.getToken({ forceRefresh })).trim();
    if (!value) throw new Error('A recording upload token is required');
    token = { value, fetchedAt: now() };
    return value;
  };

  /** Issue an authorized request, refreshing the token once after a 401. */
  const authorizedRequest = async <T>(path: string, init: RequestInit): Promise<T> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = await resolveToken(attempt > 0);
      const response = await fetchImpl(buildUrl(options.mediaHttpUrl, path), {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${bearer}` },
      });
      if (response.status === 401 && attempt === 0) {
        await response.text().catch(() => '');
        continue;
      }
      return readJson<T>(response);
    }
    throw new Error('Recording upload authorization failed');
  };

  const ensureSession = async (): Promise<string> => {
    if (uploadId) return uploadId;
    const session = await authorizedRequest<RecordingUploadSessionResponse>('/recordings/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: options.roomId,
        sessionId: options.sessionId || undefined,
        participantId: options.participantId?.trim() || undefined,
        participantName: options.participantName?.trim() || undefined,
        tracks: Array.from(tracks.values()).map(({ source }) => ({
          id: source.id,
          label: source.label,
          kind: source.kind,
          mimeType: source.mimeType,
          ...(source.capture ? { capture: source.capture } : {}),
        })),
      }),
    });
    uploadId = session.uploadId;
    emit();
    return uploadId;
  };

  const applyServerTrack = (track: TrackUpload, serverTrack: Pick<RecordingUploadTrackStatus, 'bytesReceived' | 'chunksReceived' | 'complete'>) => {
    track.uploadedBytes = serverTrack.bytesReceived;
    track.sequence = serverTrack.chunksReceived;
    track.complete = serverTrack.complete;
  };

  /** Adopt the server's offsets after a lost response or an out-of-order rejection. */
  const reconcile = async (id: string): Promise<void> => {
    const session = await authorizedRequest<RecordingUploadSessionResponse>(
      `/recordings/uploads/${encodeURIComponent(id)}`,
      { method: 'GET' }
    );
    for (const serverTrack of session.tracks) {
      const track = tracks.get(serverTrack.id);
      if (track) applyServerTrack(track, serverTrack);
    }
    emit();
  };

  /**
   * Upload sessions live in media-server memory, so a restart or expiry loses
   * them. Start a fresh session and re-send every track from the beginning —
   * the recording itself is still intact on this device.
   */
  const recoverLostSession = (error: unknown): boolean => {
    if (
      !(error instanceof ProgressiveUploadHttpError) ||
      !(
        (error.status === 404 && error.code === 'RECORDING_UPLOAD_NOT_FOUND') ||
        (error.status === 410 && error.code === 'RECORDING_UPLOAD_EXPIRED')
      )
    ) {
      return false;
    }
    uploadId = null;
    for (const track of tracks.values()) {
      track.uploadedBytes = 0;
      track.sequence = 0;
      track.complete = false;
    }
    emit();
    return true;
  };

  const sendChunk = async (id: string, track: TrackUpload, blob: Blob, end: number, final: boolean) => {
    const offset = track.uploadedBytes;
    const chunk = blob.slice(offset, end, track.source.mimeType);
    const query = `?sequence=${track.sequence}&offset=${offset}${final ? '&final=1' : ''}`;
    try {
      const response = await authorizedRequest<RecordingUploadChunkResponse>(
        `/recordings/uploads/${encodeURIComponent(id)}/tracks/${encodeURIComponent(track.source.id)}/chunks${query}`,
        { method: 'POST', headers: { 'Content-Type': track.source.mimeType }, body: chunk }
      );
      applyServerTrack(track, response.track);
      track.lastSentAt = now();
      emit();
    } catch (error) {
      if (error instanceof ProgressiveUploadHttpError && error.status === 409) {
        await reconcile(id);
        if (track.uploadedBytes > blob.size) {
          throw new Error(`${track.source.label}: the server has more bytes than this recording`);
        }
        return;
      }
      throw error;
    }
  };

  const uploadAvailable = async (id: string, track: TrackUpload, blob: Blob, isFinal: boolean) => {
    track.recordedBytes = Math.max(track.recordedBytes, blob.size);
    while (track.uploadedBytes < blob.size) {
      if (!isFinal && (stopped || pausedByHost)) return;
      const available = blob.size - track.uploadedBytes;
      if (!isFinal && available < minChunkBytes && now() - track.lastSentAt < maxIdleMs) return;
      const end = Math.min(blob.size, track.uploadedBytes + maxChunkBytes);
      await sendChunk(id, track, blob, end, isFinal && end >= blob.size);
    }
  };

  const runCycle = async (): Promise<void> => {
    if (stopped || finishing || tracks.size === 0) return;
    if (pausedByHost) {
      setStatus('paused');
      return;
    }
    try {
      const id = await ensureSession();
      for (const track of tracks.values()) {
        if (stopped || finishing || pausedByHost) break;
        const snapshot = await track.source.snapshot();
        await uploadAvailable(id, track, snapshot, false);
      }
      consecutiveFailures = 0;
      lastError = undefined;
      if (!stopped && !finishing) status = pausedByHost ? 'paused' : 'uploading';
      emit();
    } catch (error) {
      if (recoverLostSession(error)) {
        lastError = 'The media server restarted; re-sending this recording.';
      } else {
        consecutiveFailures += 1;
        lastError = describeError(error);
      }
      emit();
    }
  };

  const scheduleNext = () => {
    if (!autoSchedule || stopped || finishing) return;
    if (timer !== null) clearTimer(timer);
    const backoff = consecutiveFailures > 0
      ? Math.min(maxRetryDelayMs, retryBaseMs * 2 ** (consecutiveFailures - 1))
      : intervalMs;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, Math.max(backoff, intervalMs));
  };

  const flush = (): Promise<void> => {
    if (activeCycle) return activeCycle;
    activeCycle = runCycle().finally(() => {
      activeCycle = null;
      scheduleNext();
    });
    return activeCycle;
  };

  const start = (sources: ProgressiveUploadTrackSource[]) => {
    if (tracks.size > 0 || stopped) return;
    for (const source of sources) {
      if (tracks.has(source.id)) continue;
      tracks.set(source.id, {
        source,
        recordedBytes: 0,
        uploadedBytes: 0,
        sequence: 0,
        complete: false,
        lastSentAt: now(),
      });
    }
    if (tracks.size === 0) return;
    setStatus('starting');
    // Open the server session immediately so configuration problems surface
    // while the host can still act on them, not after the take ends.
    void flush();
  };

  const finish = async (
    finalBlobs: ReadonlyMap<string, Blob>,
    metadata?: ReadonlyMap<string, ProgressiveUploadTrackCompletion>
  ): Promise<ProgressiveUploadResult> => {
    finishing = true;
    // The take is over, so the footage must be secured even if a host paused
    // uploads earlier to protect live bandwidth.
    pausedByHost = false;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (activeCycle) await activeCycle;
    setStatus('finishing');

    for (const [id, track] of tracks) {
      const blob = finalBlobs.get(id);
      if (blob) track.recordedBytes = blob.size;
    }

    let attempt = 0;
    for (;;) {
      try {
        const id = await ensureSession();
        for (const [trackId, track] of tracks) {
          const blob = finalBlobs.get(trackId);
          if (!blob || blob.size === 0) continue;
          if (track.uploadedBytes > blob.size) {
            throw new Error(`${track.source.label}: the finished recording is shorter than the uploaded data`);
          }
          await uploadAvailable(id, track, blob, true);
        }
        const completed = await authorizedRequest<RecordingUploadSessionResponse>(
          `/recordings/uploads/${encodeURIComponent(id)}/complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: buildProgressiveCompletionBody(Array.from(tracks.keys()), metadata),
          }
        );
        for (const serverTrack of completed.tracks) {
          const track = tracks.get(serverTrack.id);
          if (track) applyServerTrack(track, serverTrack);
        }
        consecutiveFailures = 0;
        lastError = undefined;
        status = 'complete';
        emit();
        return {
          uploadId: completed.uploadId,
          roomId: completed.roomId,
          sessionId: completed.sessionId,
          bytesReceived: completed.bytesReceived,
          tracks: completed.tracks,
        };
      } catch (error) {
        attempt += 1;
        consecutiveFailures += 1;
        lastError = describeError(error);
        const sessionLost = recoverLostSession(error);
        if (
          attempt >= finishAttempts ||
          (!sessionLost && error instanceof ProgressiveUploadHttpError && [400, 403, 413].includes(error.status))
        ) {
          status = 'error';
          emit();
          throw error instanceof Error ? error : new Error(lastError);
        }
        emit();
        await sleep(Math.min(maxRetryDelayMs, retryBaseMs * 2 ** (attempt - 1)));
      }
    }
  };

  return {
    start,
    flush,
    pause() {
      if (pausedByHost || finishing) return;
      pausedByHost = true;
      setStatus('paused');
    },
    resume() {
      if (!pausedByHost) return;
      pausedByHost = false;
      if (!finishing) {
        setStatus('uploading');
        void flush();
      }
    },
    finish,
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    getState,
  };
}

/** The media server stores WebM and MP4 tracks; other containers upload after recording. */
export function isProgressiveUploadMimeType(mimeType: string): boolean {
  return /^(audio|video)\/(webm|mp4)(\s*;.*)?$/i.test(mimeType.trim());
}

/** Map a participant track id to a media-server-safe upload track id. */
export function toProgressiveUploadTrackId(sourceId: string, index: number, seen: Set<string>): string {
  const base = sourceId
    .trim()
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || `track-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix}`.slice(0, 120);
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

/** Whole-number percentage for UI; an empty recording counts as complete only once finished. */
export function getProgressiveUploadPercent(state: Pick<ProgressiveUploadState, 'recordedBytes' | 'uploadedBytes' | 'status'>): number {
  if (state.status === 'complete') return 100;
  if (state.recordedBytes <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor((state.uploadedBytes / state.recordedBytes) * 100)));
}
