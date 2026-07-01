import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import type {
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
}

export interface RecordingUploadSession {
  uploadId: string;
  roomId: string;
  sessionId?: string;
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

function isSupportedWebmMimeType(value: string): boolean {
  return /^video\/webm(?:\s*;.*)?$/.test(value) || /^audio\/webm(?:\s*;.*)?$/.test(value);
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
  if (!isSupportedWebmMimeType(mimeType)) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_TRACK', `${input.id}: recording track must be WebM`);
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
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    maxBytes: session.maxBytes,
    bytesReceived: session.bytesReceived,
    tracks: Array.from(session.tracks.values()).map(trackStatus),
  };
}

function defaultUploadRoot(): string {
  return path.join(os.tmpdir(), 'livestream-studio-recordings');
}

export class RecordingUploadStore {
  private readonly sessions = new Map<string, RecordingUploadSession>();

  constructor(private readonly uploadRoot = process.env.RECORDING_UPLOAD_DIR || defaultUploadRoot()) {}

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
        filePath: path.join(rootDir, `${track.id}.webm`),
        bytesReceived: 0,
        chunksReceived: 0,
        complete: false,
      });
    }

    const session: RecordingUploadSession = {
      uploadId,
      roomId: normalized.roomId,
      sessionId: normalized.sessionId,
      rootDir,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      maxBytes: normalized.maxBytes || DEFAULT_RECORDING_UPLOAD_MAX_BYTES,
      bytesReceived: 0,
      tracks,
    };
    this.sessions.set(uploadId, session);
    return sessionStatus(session);
  }

  getSession(uploadId: string, nowMs = Date.now()): RecordingUploadSession {
    if (!isValidId(uploadId)) {
      throw new RecordingUploadError(404, 'RECORDING_UPLOAD_NOT_FOUND', 'Recording upload session not found');
    }
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new RecordingUploadError(404, 'RECORDING_UPLOAD_NOT_FOUND', 'Recording upload session not found');
    }
    if (Date.parse(session.expiresAt) <= nowMs) {
      throw new RecordingUploadError(410, 'RECORDING_UPLOAD_EXPIRED', 'Recording upload session expired');
    }
    return session;
  }

  getStatus(uploadId: string, nowMs = Date.now()): RecordingUploadSessionResponse {
    return sessionStatus(this.getSession(uploadId, nowMs));
  }

  getExportSource(uploadId: string, nowMs = Date.now()): RecordingUploadExportSource {
    const session = this.getSession(uploadId, nowMs);
    return {
      uploadId: session.uploadId,
      roomId: session.roomId,
      sessionId: session.sessionId,
      rootDir: session.rootDir,
      tracks: Array.from(session.tracks.values()).map((track) => ({
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

  async appendChunk(input: RecordingUploadChunkInput, nowMs = Date.now()): Promise<RecordingUploadChunkResponse> {
    const session = this.getSession(input.uploadId, nowMs);
    if (!isValidId(input.trackId)) {
      throw new RecordingUploadError(404, 'RECORDING_TRACK_NOT_FOUND', 'Recording track not found');
    }
    const track = session.tracks.get(input.trackId);
    if (!track) {
      throw new RecordingUploadError(404, 'RECORDING_TRACK_NOT_FOUND', 'Recording track not found');
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

    await appendFile(track.filePath, input.data);
    track.bytesReceived += input.data.length;
    track.chunksReceived += 1;
    track.complete = Boolean(input.final);
    session.bytesReceived += input.data.length;
    session.updatedAt = new Date(nowMs).toISOString();

    return {
      uploadId: session.uploadId,
      track: trackStatus(track),
      bytesReceived: session.bytesReceived,
    };
  }

  completeSession(uploadId: string, nowMs = Date.now()): RecordingUploadSessionResponse {
    const session = this.getSession(uploadId, nowMs);
    for (const track of session.tracks.values()) {
      track.complete = true;
    }
    session.updatedAt = new Date(nowMs).toISOString();
    return sessionStatus(session);
  }

  async deleteSession(uploadId: string): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (!session) return;
    this.sessions.delete(uploadId);
    await rm(session.rootDir, { recursive: true, force: true });
  }
}
