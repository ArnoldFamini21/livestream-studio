import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import type {
  DistributedRecordingSessionResponse,
  RecordingUploadChunkResponse,
  RecordingUploadSessionRequest,
  RecordingUploadSessionResponse,
  RecordingUploadTrackKind,
  RecordingUploadTrackManifest,
  RecordingUploadTrackStatus,
} from '@studio/shared';

export const MAX_RECORDING_UPLOAD_TRACKS = 64;
export const MAX_RECORDING_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
export const DEFAULT_RECORDING_UPLOAD_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_RECORDING_UPLOAD_MAX_BYTES = 40 * 1024 * 1024 * 1024;
export const RECORDING_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

const TRACK_KINDS: RecordingUploadTrackKind[] = ['audio', 'video', 'screen', 'program', 'iso'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

interface RecordingUploadTrackState extends RecordingUploadTrackManifest {
  filePath: string;
  bytesReceived: number;
  chunksReceived: number;
  complete: boolean;
  writeFailed?: boolean;
}

export interface RecordingUploadSession {
  uploadId: string;
  roomId: string;
  sessionId?: string;
  participantId?: string;
  participantName?: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  maxBytes: number;
  bytesReceived: number;
  tracks: Map<string, RecordingUploadTrackState>;
}

export interface RecordingUploadChunkInput {
  uploadId: string;
  trackId: string;
  sequence: number;
  offset?: number;
  final?: boolean;
  data: Buffer;
}

export interface RecordingUploadExportTrack {
  id: string;
  label: string;
  kind: RecordingUploadTrackKind;
  mimeType: string;
  filePath: string;
  expectedBytes?: number;
  durationMs?: number;
  bytesReceived: number;
  complete: boolean;
}

export interface RecordingUploadExportSource {
  uploadId: string;
  roomId: string;
  sessionId?: string;
  rootDir: string;
  tracks: RecordingUploadExportTrack[];
}

export class RecordingUploadError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RecordingUploadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function normalizeMimeType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isSupportedRecordingMimeType(value: string): boolean {
  return (
    /^video\/webm(?:\s*;.*)?$/.test(value) ||
    /^audio\/webm(?:\s*;.*)?$/.test(value) ||
    /^video\/mp4(?:\s*;.*)?$/.test(value) ||
    /^audio\/mp4(?:\s*;.*)?$/.test(value)
  );
}

function getRecordingTrackExtension(mimeType: string): string {
  if (mimeType.startsWith('audio/mp4')) return 'm4a';
  if (mimeType.startsWith('video/mp4')) return 'mp4';
  return 'webm';
}

function normalizeOptionalSize(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', `${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeMaxBytes(value: unknown): number {
  if (value === undefined) return DEFAULT_RECORDING_UPLOAD_MAX_BYTES;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'maxBytes must be a positive integer');
  }
  return Math.min(value, MAX_RECORDING_UPLOAD_MAX_BYTES);
}

function normalizeTrack(input: unknown): RecordingUploadTrackManifest {
  if (!isRecord(input)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_TRACK', 'Invalid recording track');
  }
  if (!isValidId(input.id)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_TRACK', 'Invalid recording track id');
  }
  if (typeof input.label !== 'string' || input.label.trim().length === 0 || input.label.length > 160) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_TRACK', `${input.id}: invalid recording track label`);
  }
  if (!TRACK_KINDS.includes(input.kind as RecordingUploadTrackKind)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_TRACK', `${input.id}: invalid recording track kind`);
  }
  const mimeType = normalizeMimeType(input.mimeType);
  if (!isSupportedRecordingMimeType(mimeType)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_TRACK', `${input.id}: recording track must be MP4 or WebM`);
  }
  const expectedBytes = normalizeOptionalSize(input.expectedBytes, `${input.id} expectedBytes`);
  const durationMs = normalizeOptionalSize(input.durationMs, `${input.id} durationMs`);
  const track: RecordingUploadTrackManifest = {
    id: input.id,
    label: input.label.trim(),
    kind: input.kind as RecordingUploadTrackKind,
    mimeType,
  };
  if (expectedBytes !== undefined) track.expectedBytes = expectedBytes;
  if (durationMs !== undefined) track.durationMs = durationMs;
  if (isRecord(input.capture)) track.capture = input.capture;
  return track;
}

function normalizeCreateRequest(input: unknown): Omit<RecordingUploadSessionRequest, 'token'> {
  if (!isRecord(input)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording upload request');
  }
  if (!isValidId(input.roomId)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid room id');
  }
  if (input.sessionId !== undefined && !isValidId(input.sessionId)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording session id');
  }
  if (input.participantId !== undefined && !isValidId(input.participantId)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording participant id');
  }
  if (
    input.participantName !== undefined &&
    (typeof input.participantName !== 'string' || input.participantName.trim().length === 0 || input.participantName.length > 80)
  ) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording participant name');
  }
  if (!Array.isArray(input.tracks) || input.tracks.length === 0) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'At least one recording track is required');
  }
  if (input.tracks.length > MAX_RECORDING_UPLOAD_TRACKS) {
    throw new RecordingUploadError(
      400,
      'INVALID_RECORDING_UPLOAD',
      `A maximum of ${MAX_RECORDING_UPLOAD_TRACKS} recording tracks can be uploaded at once`
    );
  }

  const tracks = input.tracks.map(normalizeTrack);
  const ids = new Set<string>();
  let expectedTotal = 0;
  for (const track of tracks) {
    if (ids.has(track.id)) {
      throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Recording track ids must be unique');
    }
    ids.add(track.id);
    expectedTotal += track.expectedBytes || 0;
  }
  const maxBytes = normalizeMaxBytes(input.maxBytes);
  if (expectedTotal > maxBytes) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Expected recording bytes exceed session limit');
  }

  return {
    roomId: input.roomId,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
    participantId: typeof input.participantId === 'string' ? input.participantId : undefined,
    participantName: typeof input.participantName === 'string' ? input.participantName.trim() : undefined,
    tracks,
    maxBytes,
  };
}

function trackStatus(track: RecordingUploadTrackState): RecordingUploadTrackStatus {
  return {
    id: track.id,
    label: track.label,
    kind: track.kind,
    mimeType: track.mimeType,
    bytesReceived: track.bytesReceived,
    chunksReceived: track.chunksReceived,
    complete: track.complete,
  };
}

function sessionStatus(session: RecordingUploadSession): RecordingUploadSessionResponse {
  return {
    uploadId: session.uploadId,
    roomId: session.roomId,
    sessionId: session.sessionId,
    participantId: session.participantId,
    participantName: session.participantName,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    maxBytes: session.maxBytes,
    bytesReceived: session.bytesReceived,
    tracks: Array.from(session.tracks.values()).map(trackStatus),
  };
}

/**
 * An upload is ready once every declared track is finalized and at least one
 * carries media. Progressive uploads declare tracks when recording starts, so
 * a track that never produced data (for example, a screen share that was
 * never started) must not hold back the participant's other tracks.
 */
function isUploadReadyForExport(upload: RecordingUploadSessionResponse): boolean {
  return (
    upload.tracks.length > 0 &&
    upload.tracks.every((track) => track.complete) &&
    upload.tracks.some((track) => track.bytesReceived > 0)
  );
}

export interface RecordingUploadTrackCompletion {
  id: string;
  durationMs?: number;
  capture?: Record<string, unknown>;
}

function normalizeCompletionUpdates(input: unknown): RecordingUploadTrackCompletion[] {
  if (!isRecord(input) || input.tracks === undefined) return [];
  if (!Array.isArray(input.tracks) || input.tracks.length > MAX_RECORDING_UPLOAD_TRACKS) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording completion tracks');
  }
  return input.tracks.map((track) => {
    if (!isRecord(track) || !isValidId(track.id)) {
      throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording completion track');
    }
    const durationMs = normalizeOptionalSize(track.durationMs, `${track.id} durationMs`);
    return {
      id: track.id,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(isRecord(track.capture) ? { capture: track.capture } : {}),
    };
  });
}

const SESSION_STATE_FILE_NAME = 'session-state.json';

interface PersistedRecordingUploadSession {
  version: 1;
  uploadId: string;
  roomId: string;
  sessionId?: string;
  participantId?: string;
  participantName?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  maxBytes: number;
  bytesReceived: number;
  tracks: RecordingUploadTrackState[];
}

function serializeSessionState(session: RecordingUploadSession): string {
  const payload: PersistedRecordingUploadSession = {
    version: 1,
    uploadId: session.uploadId,
    roomId: session.roomId,
    sessionId: session.sessionId,
    participantId: session.participantId,
    participantName: session.participantName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    maxBytes: session.maxBytes,
    bytesReceived: session.bytesReceived,
    tracks: Array.from(session.tracks.values()),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function defaultUploadRoot(): string {
  return path.join(os.tmpdir(), 'livestream-studio-recordings');
}

export class RecordingUploadStore {
  private readonly sessions = new Map<string, RecordingUploadSession>();
  private readonly pendingMutations = new Map<string, Promise<void>>();

  constructor(private readonly uploadRoot = process.env.RECORDING_UPLOAD_DIR || defaultUploadRoot()) {}

  getUploadRoot(): string {
    return this.uploadRoot;
  }

  /** Serialize whole sessions: sequence checks and shared byte limits must commit together. */
  private async mutateSession<T>(uploadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.pendingMutations.get(uploadId) || Promise.resolve();
    const operation = previous.then(task);
    // A failed request must not poison the queue for valid retries.
    const settled = operation.then(() => undefined, () => undefined);
    this.pendingMutations.set(uploadId, settled);
    try {
      return await operation;
    } finally {
      if (this.pendingMutations.get(uploadId) === settled) this.pendingMutations.delete(uploadId);
    }
  }

  private async persistSession(session: RecordingUploadSession): Promise<void> {
    await writeFile(path.join(session.rootDir, SESSION_STATE_FILE_NAME), serializeSessionState(session), 'utf8');
  }

  private persistSessionSync(session: RecordingUploadSession): void {
    try {
      writeFileSync(path.join(session.rootDir, SESSION_STATE_FILE_NAME), serializeSessionState(session), 'utf8');
    } catch {
      // Directory may have been removed concurrently.
    }
  }

  private loadSessionFromDisk(uploadId: string): RecordingUploadSession | null {
    if (!isValidId(uploadId)) return null;
    const rootDir = path.join(this.uploadRoot, uploadId);
    const stateFile = path.join(rootDir, SESSION_STATE_FILE_NAME);
    if (!existsSync(stateFile)) return null;

    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<PersistedRecordingUploadSession>;
      if (
        !parsed ||
        parsed.uploadId !== uploadId ||
        typeof parsed.roomId !== 'string' ||
        typeof parsed.createdAt !== 'string' ||
        typeof parsed.updatedAt !== 'string' ||
        typeof parsed.expiresAt !== 'string' ||
        typeof parsed.maxBytes !== 'number' ||
        !Array.isArray(parsed.tracks)
      ) {
        return null;
      }

      const tracks = new Map<string, RecordingUploadTrackState>();
      let totalBytes = 0;
      let needsSyncPersist = false;
      for (const rawTrack of parsed.tracks) {
        if (!rawTrack || typeof rawTrack.id !== 'string' || typeof rawTrack.mimeType !== 'string') continue;
        const filePath = path.join(rootDir, `${rawTrack.id}.${getRecordingTrackExtension(rawTrack.mimeType)}`);
        let bytesReceived = typeof rawTrack.bytesReceived === 'number' && rawTrack.bytesReceived >= 0
          ? rawTrack.bytesReceived
          : 0;
        let chunksReceived = typeof rawTrack.chunksReceived === 'number' && rawTrack.chunksReceived >= 0
          ? rawTrack.chunksReceived
          : 0;
        let complete = Boolean(rawTrack.complete);

        try {
          const fileStat = statSync(filePath);
          if (fileStat.size > bytesReceived) {
            // An unrecorded partial write occurred right before a crash; roll back to the committed offset.
            try {
              truncateSync(filePath, bytesReceived);
            } catch {
              bytesReceived = fileStat.size;
              needsSyncPersist = true;
            }
          } else if (fileStat.size < bytesReceived) {
            bytesReceived = fileStat.size;
            complete = false;
            needsSyncPersist = true;
          }
        } catch {
          if (bytesReceived > 0) {
            bytesReceived = 0;
            chunksReceived = 0;
            complete = false;
            needsSyncPersist = true;
          }
        }

        totalBytes += bytesReceived;
        tracks.set(rawTrack.id, {
          ...rawTrack,
          filePath,
          bytesReceived,
          chunksReceived,
          complete,
        });
      }

      const session: RecordingUploadSession = {
        uploadId,
        roomId: parsed.roomId,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        participantId: typeof parsed.participantId === 'string' ? parsed.participantId : undefined,
        participantName: typeof parsed.participantName === 'string' ? parsed.participantName : undefined,
        rootDir,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        expiresAt: parsed.expiresAt,
        maxBytes: parsed.maxBytes,
        bytesReceived: totalBytes,
        tracks,
      };
      this.sessions.set(uploadId, session);
      if (needsSyncPersist) {
        this.persistSessionSync(session);
      }
      return session;
    } catch {
      return null;
    }
  }

  private hydrateAllFromDisk(): void {
    if (!existsSync(this.uploadRoot)) return;
    try {
      const entries = readdirSync(this.uploadRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('._')) continue;
        if (!this.sessions.has(entry.name)) {
          this.loadSessionFromDisk(entry.name);
        }
      }
    } catch {
      // Ignore missing or unreadable uploadRoot.
    }
  }

  async createSession(input: unknown, nowMs = Date.now()): Promise<RecordingUploadSessionResponse> {
    const normalized = normalizeCreateRequest(input);
    const uploadId = randomUUID();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + RECORDING_UPLOAD_TTL_MS).toISOString();
    const rootDir = path.join(this.uploadRoot, uploadId);
    await mkdir(rootDir, { recursive: true });

    const tracks = new Map<string, RecordingUploadTrackState>();
    for (const track of normalized.tracks) {
      tracks.set(track.id, {
        ...track,
        filePath: path.join(rootDir, `${track.id}.${getRecordingTrackExtension(track.mimeType)}`),
        bytesReceived: 0,
        chunksReceived: 0,
        complete: false,
      });
    }

    const session: RecordingUploadSession = {
      uploadId,
      roomId: normalized.roomId,
      sessionId: normalized.sessionId,
      participantId: normalized.participantId,
      participantName: normalized.participantName,
      rootDir,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      maxBytes: normalized.maxBytes || DEFAULT_RECORDING_UPLOAD_MAX_BYTES,
      bytesReceived: 0,
      tracks,
    };
    this.sessions.set(uploadId, session);
    await this.persistSession(session);
    return sessionStatus(session);
  }

  private resolveSession(uploadId: string): RecordingUploadSession {
    if (!isValidId(uploadId)) {
      throw new RecordingUploadError(404, 'RECORDING_UPLOAD_NOT_FOUND', 'Recording upload session not found');
    }
    const session = this.sessions.get(uploadId) ?? this.loadSessionFromDisk(uploadId);
    if (!session) {
      throw new RecordingUploadError(404, 'RECORDING_UPLOAD_NOT_FOUND', 'Recording upload session not found');
    }
    return session;
  }

  getSession(uploadId: string, nowMs = Date.now()): RecordingUploadSession {
    const session = this.resolveSession(uploadId);
    if (Date.parse(session.expiresAt) <= nowMs) {
      throw new RecordingUploadError(410, 'RECORDING_UPLOAD_EXPIRED', 'Recording upload session expired');
    }
    return session;
  }

  /**
   * Look up a session for deletion without rejecting expired uploads so callers
   * and cleanup jobs can still authenticate and reclaim expired directories.
   */
  getSessionForDelete(uploadId: string): RecordingUploadSession {
    return this.resolveSession(uploadId);
  }

  getStatus(uploadId: string, nowMs = Date.now()): RecordingUploadSessionResponse {
    return sessionStatus(this.getSession(uploadId, nowMs));
  }

  getExportSource(uploadId: string, nowMs = Date.now()): RecordingUploadExportSource {
    const session = this.getSession(uploadId, nowMs);
    // Finalized tracks without media are omitted while another track has media,
    // so a never-started screen share cannot block the camera and microphone.
    // An upload with no media at all keeps its tracks and fails validation clearly.
    const declaredTracks = Array.from(session.tracks.values());
    const tracksWithMedia = declaredTracks.filter((track) => !(track.complete && track.bytesReceived === 0));
    const exportTracks = tracksWithMedia.length > 0 ? tracksWithMedia : declaredTracks;
    return {
      uploadId: session.uploadId,
      roomId: session.roomId,
      sessionId: session.sessionId,
      rootDir: session.rootDir,
      tracks: exportTracks.map((track) => ({
        id: track.id,
        label: track.label,
        kind: track.kind,
        mimeType: track.mimeType,
        filePath: track.filePath,
        expectedBytes: track.expectedBytes,
        durationMs: track.durationMs,
        bytesReceived: track.bytesReceived,
        complete: track.complete,
      })),
    };
  }

  getDistributedSessionStatus(
    roomId: string,
    sessionId: string,
    nowMs = Date.now()
  ): DistributedRecordingSessionResponse {
    if (!isValidId(roomId) || !isValidId(sessionId)) {
      throw new RecordingUploadError(404, 'RECORDING_SESSION_NOT_FOUND', 'Recording session not found');
    }
    this.hydrateAllFromDisk();
    const uploads = Array.from(this.sessions.values())
      .filter((session) => (
        session.roomId === roomId &&
        session.sessionId === sessionId &&
        Date.parse(session.expiresAt) > nowMs
      ))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const statuses = uploads.map(sessionStatus);
    return {
      roomId,
      sessionId,
      uploadCount: statuses.length,
      completedUploadCount: statuses.filter(isUploadReadyForExport).length,
      trackCount: statuses.reduce((total, upload) => total + upload.tracks.length, 0),
      bytesReceived: statuses.reduce((total, upload) => total + upload.bytesReceived, 0),
      uploads: statuses,
    };
  }

  getDistributedExportSource(
    roomId: string,
    sessionId: string,
    nowMs = Date.now()
  ): RecordingUploadExportSource {
    const summary = this.getDistributedSessionStatus(roomId, sessionId, nowMs);
    if (summary.uploads.length === 0) {
      throw new RecordingUploadError(404, 'RECORDING_SESSION_NOT_FOUND', 'Recording session has no uploaded tracks');
    }
    const completedUploads = summary.uploads.filter(isUploadReadyForExport);
    if (completedUploads.length === 0) {
      throw new RecordingUploadError(409, 'RECORDING_SESSION_UPLOADS_PENDING', 'Recording session has no completed uploads yet');
    }

    const sources = completedUploads.map((upload) => this.getExportSource(upload.uploadId, nowMs));
    const primary = sources.find((source) => source.tracks.some((track) => track.kind === 'program')) || sources[0];
    const tracks = sources.flatMap((source, sourceIndex) => source.tracks.map((track) => {
      const prefix = `upload-${sourceIndex + 1}`;
      return {
        ...track,
        id: `${prefix}-${track.id}`.slice(0, 120),
      };
    }));
    if (tracks.length > MAX_RECORDING_UPLOAD_TRACKS) {
      throw new RecordingUploadError(
        409,
        'RECORDING_SESSION_TOO_MANY_TRACKS',
        `A combined recording export supports at most ${MAX_RECORDING_UPLOAD_TRACKS} tracks`
      );
    }
    return {
      uploadId: primary.uploadId,
      roomId,
      sessionId,
      rootDir: primary.rootDir,
      tracks,
    };
  }

  async appendChunk(input: RecordingUploadChunkInput, nowMs = Date.now()): Promise<RecordingUploadChunkResponse> {
    return this.mutateSession(input.uploadId, () => this.appendChunkExclusive(input, nowMs));
  }

  private async appendChunkExclusive(input: RecordingUploadChunkInput, nowMs: number): Promise<RecordingUploadChunkResponse> {
    const session = this.getSession(input.uploadId, nowMs);
    if (!isValidId(input.trackId)) {
      throw new RecordingUploadError(404, 'RECORDING_TRACK_NOT_FOUND', 'Recording track not found');
    }
    const track = session.tracks.get(input.trackId);
    if (!track) {
      throw new RecordingUploadError(404, 'RECORDING_TRACK_NOT_FOUND', 'Recording track not found');
    }
    if (track.writeFailed) {
      throw new RecordingUploadError(409, 'RECORDING_TRACK_WRITE_FAILED', 'Recording track could not be restored after a failed write; start a new upload');
    }
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new RecordingUploadError(400, 'INVALID_RECORDING_CHUNK', 'Chunk sequence must be a non-negative integer');
    }
    if (input.sequence !== track.chunksReceived) {
      throw new RecordingUploadError(409, 'RECORDING_CHUNK_OUT_OF_ORDER', 'Recording chunks must be uploaded in order');
    }
    if (input.offset !== undefined && input.offset !== track.bytesReceived) {
      throw new RecordingUploadError(409, 'RECORDING_CHUNK_OFFSET_MISMATCH', 'Recording chunk offset does not match uploaded bytes');
    }
    // A retry of the final chunk still receives an ordering conflict, allowing
    // clients to reconcile its acknowledgement before enforcing immutability.
    if (track.complete) {
      throw new RecordingUploadError(409, 'RECORDING_TRACK_COMPLETE', 'Recording track is already finalized');
    }
    if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
      throw new RecordingUploadError(400, 'INVALID_RECORDING_CHUNK', 'Recording chunk is empty');
    }
    if (input.data.length > MAX_RECORDING_UPLOAD_CHUNK_BYTES) {
      throw new RecordingUploadError(413, 'RECORDING_CHUNK_TOO_LARGE', 'Recording chunk is too large');
    }
    if (session.bytesReceived + input.data.length > session.maxBytes) {
      throw new RecordingUploadError(413, 'RECORDING_UPLOAD_TOO_LARGE', 'Recording upload exceeds the session byte limit');
    }
    if (track.expectedBytes !== undefined && track.bytesReceived + input.data.length > track.expectedBytes) {
      throw new RecordingUploadError(413, 'RECORDING_TRACK_TOO_LARGE', 'Recording track exceeds expected bytes');
    }
    if (input.final && track.expectedBytes !== undefined && track.bytesReceived + input.data.length !== track.expectedBytes) {
      throw new RecordingUploadError(409, 'RECORDING_UPLOAD_INCOMPLETE', `${track.label} has not received all expected bytes`);
    }

    try {
      await appendFile(track.filePath, input.data);
    } catch (error) {
      // appendFile may write a prefix before disk exhaustion. Roll it back so
      // retrying the unchanged offset cannot duplicate that partial chunk.
      try { await truncate(track.filePath, track.bytesReceived); }
      catch (rollbackError) {
        if (!isRecord(rollbackError) || rollbackError.code !== 'ENOENT') track.writeFailed = true;
      }
      throw error;
    }
    track.bytesReceived += input.data.length;
    track.chunksReceived += 1;
    track.complete = Boolean(input.final);
    session.bytesReceived += input.data.length;
    session.updatedAt = new Date(nowMs).toISOString();
    await this.persistSession(session);

    return {
      uploadId: session.uploadId,
      track: trackStatus(track),
      bytesReceived: session.bytesReceived,
    };
  }

  /**
   * Finalize every track. Progressive uploads declare tracks before recording
   * ends, so final durations and capture metadata may arrive here.
   */
  completeSession(uploadId: string, nowMs = Date.now(), completion?: unknown): RecordingUploadSessionResponse {
    const session = this.getSession(uploadId, nowMs);
    if (this.pendingMutations.has(uploadId)) {
      throw new RecordingUploadError(409, 'RECORDING_UPLOAD_BUSY', 'Wait for pending recording chunks before finalizing');
    }
    const updates = normalizeCompletionUpdates(completion);
    // Validate every track before mutating any metadata or completion flags.
    for (const track of session.tracks.values()) {
      if (track.writeFailed || (track.expectedBytes !== undefined && track.bytesReceived !== track.expectedBytes)) {
        throw new RecordingUploadError(409, 'RECORDING_UPLOAD_INCOMPLETE', `${track.label} has not received all expected bytes`);
      }
    }
    for (const update of updates) {
      const track = session.tracks.get(update.id);
      if (!track) continue;
      if (update.durationMs !== undefined) track.durationMs = update.durationMs;
      if (update.capture) track.capture = update.capture;
    }
    for (const track of session.tracks.values()) {
      track.complete = true;
    }
    session.updatedAt = new Date(nowMs).toISOString();
    this.persistSessionSync(session);
    return sessionStatus(session);
  }

  async deleteSession(uploadId: string): Promise<void> {
    await this.mutateSession(uploadId, async () => {
      const session = this.sessions.get(uploadId) ?? this.loadSessionFromDisk(uploadId);
      if (!session) return;
      this.sessions.delete(uploadId);
      await rm(session.rootDir, { recursive: true, force: true });
    });
  }

  async sweepExpiredSessions(nowMs = Date.now()): Promise<number> {
    this.hydrateAllFromDisk();
    const expiredIds: string[] = [];
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) <= nowMs && !this.pendingMutations.has(session.uploadId)) {
        expiredIds.push(session.uploadId);
      }
    }
    for (const uploadId of expiredIds) {
      await this.deleteSession(uploadId);
    }
    return expiredIds.length;
  }
}
