import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import ffmpegStaticPath from 'ffmpeg-static';
import type {
  RecordingExportSessionRequest,
  RtmpRelayDestination,
  RtmpRelayServerMessage,
  RtmpRelayStartPayload,
  LiveStreamTokenClaims,
} from '@studio/shared';
import { buildServiceHealthPayload } from '@studio/shared';
import { getLiveStreamTokenSecret, verifyLiveStreamToken } from './auth.js';
import { buildMediaRelayPrometheusMetrics } from './metrics.js';
import {
  buildRecordingExportObjectKey,
  getRecordingObjectStorageConfig,
  uploadFileToObjectStorage,
  type ObjectStorageConfig,
} from './objectStorage.js';
import { buildAllowedOrigins, isAllowedOrigin, normalizeOrigin } from './origins.js';
import { parseControlMessage } from './protocol.js';
import {
  createFfmpegLiveBackupArgs,
  createLiveBackupRecording,
  getLiveBackupMaxBytes,
  isLiveBackupRecordingEnabled,
  refreshLiveBackupSize,
  toLiveBackupPublicStatus,
  type LiveBackupRecording,
} from './liveBackupRecording.js';
import {
  MAX_RECORDING_UPLOAD_CHUNK_BYTES,
  RecordingUploadError,
  RecordingUploadStore,
} from './recordingUpload.js';
import {
  createFfmpegExportRunner,
  RecordingExportJobError,
  RecordingExportJobStore,
} from './recordingExportJob.js';
import {
  createFfmpegArgs,
  hasRemainingRelayWork,
  normalizeAudioConfig,
  normalizeVideoConfig,
  redactDestinationUrl,
  redactFfmpegLine,
  validateDestinations,
} from './rtmp.js';

const PORT = Number(process.env.PORT || process.env.MEDIA_SERVER_PORT || 3002);
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_DESTINATION_RESTARTS = 2;
const DESTINATION_RESTART_DELAY_MS = 1_500;
const isProduction = process.env.NODE_ENV === 'production';
const healthPayload = () => buildServiceHealthPayload('media-server', process.env);

interface RelayProcess {
  destination: RtmpRelayDestination;
  process: ChildProcessByStdio<Writable, null, Readable>;
  live: boolean;
  exited: boolean;
}

interface BackupProcess {
  recording: LiveBackupRecording;
  process: ChildProcessByStdio<Writable, null, Readable>;
  exited: boolean;
}

interface RelaySession {
  started: boolean;
  stopping: boolean;
  claims: LiveStreamTokenClaims | null;
  destinations: RtmpRelayDestination[];
  relays: Map<string, RelayProcess>;
  backup: BackupProcess | null;
  backupStopTimer: ReturnType<typeof setTimeout> | null;
  stopTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartAttempts: Map<string, number>;
}

const allowedOrigins = buildAllowedOrigins(process.env.CLIENT_URL, process.env.CLIENT_URLS);
const sessions = new Map<WebSocket, RelaySession>();
const liveBackups = new Map<string, LiveBackupRecording>();
const recordingUploads = new RecordingUploadStore();
let recordingExports: RecordingExportJobStore | null = null;
let recordingExportsFfmpegPath = '';
let recordingExportsStorageFingerprint = '';

function sendJson(ws: WebSocket, message: RtmpRelayServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, code: string, message: string, destinationId?: string) {
  sendJson(ws, { type: 'error', payload: { code, message, destinationId } });
}

function getFfmpegPath(): string | null {
  return process.env.FFMPEG_PATH || ffmpegStaticPath || null;
}

function getStorageFingerprint(config: ObjectStorageConfig | null): string {
  if (!config) return '';
  return JSON.stringify({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    prefix: config.prefix,
    publicBaseUrl: config.publicBaseUrl,
  });
}

function getRecordingExportStore(): RecordingExportJobStore {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    throw new RecordingExportJobError(503, 'FFMPEG_UNAVAILABLE', 'FFmpeg binary is unavailable');
  }
  const storageConfig = getRecordingObjectStorageConfig();
  const storageFingerprint = getStorageFingerprint(storageConfig);
  if (
    !recordingExports ||
    recordingExportsFfmpegPath !== ffmpegPath ||
    recordingExportsStorageFingerprint !== storageFingerprint
  ) {
    recordingExports = new RecordingExportJobStore(
      createFfmpegExportRunner(ffmpegPath),
      storageConfig
        ? (input) => uploadFileToObjectStorage(storageConfig, {
          filePath: input.filePath,
          contentType: input.contentType,
          key: buildRecordingExportObjectKey({
            prefix: storageConfig.prefix,
            roomId: input.roomId,
            uploadId: input.uploadId,
            exportId: input.exportId,
            artifactId: input.artifactId,
            fileName: path.basename(input.filePath),
          }),
        })
        : undefined
    );
    recordingExportsFfmpegPath = ffmpegPath;
    recordingExportsStorageFingerprint = storageFingerprint;
  }
  return recordingExports;
}

function stopRelayProcess(session: RelaySession, relay: RelayProcess) {
  if (relay.exited) return;
  try {
    relay.process.stdin.end();
  } catch {
    // Process may already be exiting.
  }

  const timer = setTimeout(() => {
    if (!relay.exited) {
      relay.process.kill('SIGTERM');
    }
  }, SHUTDOWN_TIMEOUT_MS);
  session.stopTimers.set(relay.destination.id, timer);
}

function stopBackupProcess(ws: WebSocket, session: RelaySession) {
  const backup = session.backup;
  if (!backup || backup.exited) return;
  backup.recording.status = 'finalizing';
  backup.recording.stoppedAt = new Date().toISOString();
  sendJson(ws, {
    type: 'backup-recording-status',
    payload: toLiveBackupPublicStatus(backup.recording),
  });

  try {
    backup.process.stdin.end();
  } catch {
    // Process may already be exiting.
  }

  session.backupStopTimer = setTimeout(() => {
    if (!backup.exited) {
      backup.process.kill('SIGTERM');
    }
  }, SHUTDOWN_TIMEOUT_MS);
}

function stopSession(ws: WebSocket, session: RelaySession, reason?: string) {
  if (session.stopping) return;
  session.stopping = true;
  for (const timer of session.restartTimers.values()) {
    clearTimeout(timer);
  }
  session.restartTimers.clear();
  stopBackupProcess(ws, session);
  for (const relay of session.relays.values()) {
    stopRelayProcess(session, relay);
    sendJson(ws, {
      type: 'destination-status',
      payload: { destinationId: relay.destination.id, status: 'idle' },
    });
  }
  sendJson(ws, { type: 'session-stopped', payload: { reason } });
}

function stopSessionIfNoRelayWork(ws: WebSocket, session: RelaySession) {
  if (!session.started || session.stopping) return;
  const relayWork = Array.from(session.relays.entries()).map(([destinationId, relay]) => ({
    exited: relay.exited,
    restartPending: session.restartTimers.has(destinationId),
  }));
  if (hasRemainingRelayWork(relayWork)) return;
  stopSession(ws, session, 'All RTMP destinations stopped.');
}

function spawnRelay(
  ws: WebSocket,
  session: RelaySession,
  ffmpegPath: string,
  destination: RtmpRelayDestination,
  payload: RtmpRelayStartPayload
) {
  const args = createFfmpegArgs(destination, {
    video: normalizeVideoConfig(payload.video),
    audio: normalizeAudioConfig(payload.audio),
  });
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const relay: RelayProcess = {
    destination,
    process: child,
    live: false,
    exited: false,
  };
  session.relays.set(destination.id, relay);

  sendJson(ws, {
    type: 'destination-status',
    payload: { destinationId: destination.id, status: 'connecting' },
  });

  console.log(`RTMP relay starting for ${destination.name}: ${redactDestinationUrl(destination)}`);

  child.stderr.on('data', (chunk: Buffer) => {
    const line = redactFfmpegLine(chunk.toString('utf8').trim(), session.destinations);
    if (line) console.warn(`ffmpeg ${destination.name}: ${line}`);
  });

  child.on('error', (err) => {
    relay.exited = true;
    sendJson(ws, {
      type: 'destination-status',
      payload: { destinationId: destination.id, status: 'error', message: err.message },
    });
  });

  child.on('close', (code, signal) => {
    relay.exited = true;
    const timer = session.stopTimers.get(destination.id);
    if (timer) {
      clearTimeout(timer);
      session.stopTimers.delete(destination.id);
    }

    if (session.stopping) return;

    const message = signal
      ? `FFmpeg exited from ${signal}`
      : `FFmpeg exited with code ${code ?? 'unknown'}`;

    const attempts = session.restartAttempts.get(destination.id) || 0;
    if (relay.live && attempts < MAX_DESTINATION_RESTARTS) {
      const nextAttempt = attempts + 1;
      session.restartAttempts.set(destination.id, nextAttempt);
      sendJson(ws, {
        type: 'destination-status',
        payload: {
          destinationId: destination.id,
          status: 'connecting',
          message: `Reconnecting (${nextAttempt}/${MAX_DESTINATION_RESTARTS})`,
        },
      });
      const restartTimer = setTimeout(() => {
        session.restartTimers.delete(destination.id);
        if (session.stopping || ws.readyState !== WebSocket.OPEN) return;
        spawnRelay(ws, session, ffmpegPath, destination, payload);
      }, DESTINATION_RESTART_DELAY_MS);
      session.restartTimers.set(destination.id, restartTimer);
      return;
    }

    sendJson(ws, {
      type: 'destination-status',
      payload: { destinationId: destination.id, status: 'error', message },
    });
    stopSessionIfNoRelayWork(ws, session);
  });
}

async function spawnLiveBackup(
  ws: WebSocket,
  session: RelaySession,
  ffmpegPath: string,
  claims: LiveStreamTokenClaims,
  payload: RtmpRelayStartPayload
) {
  if (!isLiveBackupRecordingEnabled()) {
    sendJson(ws, {
      type: 'backup-recording-status',
      payload: {
        backupId: '',
        roomId: claims.roomId,
        fileName: '',
        startedAt: new Date().toISOString(),
        status: 'disabled',
      },
    });
    return;
  }

  try {
    const recording = await createLiveBackupRecording({
      roomId: claims.roomId,
      video: normalizeVideoConfig(payload.video),
      audio: normalizeAudioConfig(payload.audio),
      maxBytes: getLiveBackupMaxBytes(),
    });
    const args = createFfmpegLiveBackupArgs(recording.filePath, {
      video: normalizeVideoConfig(payload.video),
      audio: normalizeAudioConfig(payload.audio),
      maxBytes: getLiveBackupMaxBytes(),
    });
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const backup: BackupProcess = {
      recording,
      process: child,
      exited: false,
    };
    session.backup = backup;
    liveBackups.set(recording.backupId, recording);

    sendJson(ws, {
      type: 'backup-recording-status',
      payload: toLiveBackupPublicStatus(recording),
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const line = redactFfmpegLine(chunk.toString('utf8').trim(), session.destinations);
      if (line) console.warn(`ffmpeg live backup ${recording.backupId}: ${line}`);
    });

    child.on('error', (err) => {
      backup.exited = true;
      recording.status = 'error';
      recording.error = err.message;
      if (!recording.stoppedAt) recording.stoppedAt = new Date().toISOString();
      sendJson(ws, {
        type: 'backup-recording-status',
        payload: toLiveBackupPublicStatus(recording),
      });
    });

    child.on('close', (code, signal) => {
      backup.exited = true;
      if (session.backupStopTimer) {
        clearTimeout(session.backupStopTimer);
        session.backupStopTimer = null;
      }
      if (!recording.stoppedAt) recording.stoppedAt = new Date().toISOString();

      void refreshLiveBackupSize(recording).then(() => {
        if (code === 0 && !signal && (recording.sizeBytes || 0) > 0) {
          recording.status = 'ready';
        } else {
          recording.status = 'error';
          recording.error = signal
            ? `Backup recording stopped from ${signal}`
            : `Backup recording exited with code ${code ?? 'unknown'}`;
        }
        sendJson(ws, {
          type: 'backup-recording-status',
          payload: toLiveBackupPublicStatus(recording),
        });
      }).catch((err) => {
        recording.status = 'error';
        recording.error = err instanceof Error ? err.message : 'Backup recording finalization failed';
        sendJson(ws, {
          type: 'backup-recording-status',
          payload: toLiveBackupPublicStatus(recording),
        });
      });
    });
  } catch (err) {
    sendJson(ws, {
      type: 'backup-recording-status',
      payload: {
        backupId: '',
        roomId: claims.roomId,
        fileName: '',
        startedAt: new Date().toISOString(),
        status: 'error',
        error: err instanceof Error ? err.message : 'Backup recording could not start',
      },
    });
  }
}

async function handleStart(ws: WebSocket, session: RelaySession, payload: RtmpRelayStartPayload) {
  if (session.started) {
    sendError(ws, 'ALREADY_STARTED', 'This relay session is already live');
    return;
  }

  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    sendError(ws, 'LIVE_STREAM_NOT_CONFIGURED', 'Live streaming is not configured on this server');
    return;
  }

  let claims: LiveStreamTokenClaims;
  try {
    claims = verifyLiveStreamToken(payload.token, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid live stream token';
    sendError(ws, 'UNAUTHORIZED', message);
    ws.close(1008, 'Unauthorized');
    return;
  }

  const destinationIssue = validateDestinations(payload.destinations);
  if (destinationIssue) {
    sendError(ws, 'INVALID_DESTINATIONS', destinationIssue);
    return;
  }

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    sendError(ws, 'FFMPEG_UNAVAILABLE', 'FFmpeg binary is unavailable');
    return;
  }

  session.started = true;
  session.claims = claims;
  session.destinations = payload.destinations;

  await spawnLiveBackup(ws, session, ffmpegPath, claims, payload);

  for (const destination of payload.destinations) {
    spawnRelay(ws, session, ffmpegPath, destination, payload);
  }

  sendJson(ws, {
    type: 'session-started',
    payload: {
      roomId: claims.roomId,
      destinationIds: payload.destinations.map((destination) => destination.id),
    },
  });
}

function handleBinaryChunk(ws: WebSocket, session: RelaySession, data: RawData) {
  if (!session.started || session.stopping) {
    sendError(ws, 'SESSION_NOT_STARTED', 'Start the relay session before sending media');
    return;
  }

  const chunk = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  for (const relay of session.relays.values()) {
    if (relay.exited || !relay.process.stdin.writable) continue;
    relay.process.stdin.write(chunk);
    if (!relay.live) {
      relay.live = true;
      sendJson(ws, {
        type: 'destination-status',
        payload: { destinationId: relay.destination.id, status: 'live' },
      });
    }
  }
  const backup = session.backup;
  if (backup && !backup.exited && backup.process.stdin.writable) {
    backup.process.stdin.write(chunk);
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function getRequestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = getRequestOrigin(req);
  if (!isAllowedOrigin(origin, { allowedOrigins, production: isProduction })) return false;
  const normalized = origin ? normalizeOrigin(origin) : null;
  if (normalized) {
    res.setHeader('Access-Control-Allow-Origin', normalized);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function getBearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function authenticateRecordingUpload(req: IncomingMessage, roomId: string, bodyToken?: unknown) {
  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    throw new RecordingUploadError(503, 'LIVE_STREAM_NOT_CONFIGURED', 'Recording uploads are not configured on this server');
  }
  const token = getBearerToken(req) || (typeof bodyToken === 'string' ? bodyToken.trim() : '');
  if (!token) {
    throw new RecordingUploadError(401, 'UNAUTHORIZED', 'Recording upload token is required');
  }
  let claims: LiveStreamTokenClaims;
  try {
    claims = verifyLiveStreamToken(token, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid recording upload token';
    throw new RecordingUploadError(401, 'UNAUTHORIZED', message);
  }
  if (claims.roomId !== roomId) {
    throw new RecordingUploadError(403, 'ROOM_TOKEN_MISMATCH', 'Recording upload token does not match this room');
  }
  return claims;
}

function authenticateLiveBackupRequest(req: IncomingMessage, roomId: string) {
  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    throw new RecordingUploadError(503, 'LIVE_STREAM_NOT_CONFIGURED', 'Live backup downloads are not configured on this server');
  }
  const token = getBearerToken(req);
  if (!token) {
    throw new RecordingUploadError(401, 'UNAUTHORIZED', 'Live backup download token is required');
  }
  let claims: LiveStreamTokenClaims;
  try {
    claims = verifyLiveStreamToken(token, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid live backup download token';
    throw new RecordingUploadError(401, 'UNAUTHORIZED', message);
  }
  if (claims.roomId !== roomId) {
    throw new RecordingUploadError(403, 'ROOM_TOKEN_MISMATCH', 'Live backup token does not match this room');
  }
  return claims;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RecordingUploadError(413, 'REQUEST_TOO_LARGE', 'Request body is too large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new RecordingUploadError(413, 'REQUEST_TOO_LARGE', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(req, 32 * 1024);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RecordingUploadError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(req, 32 * 1024);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new RecordingUploadError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function parseNonNegativeInteger(value: string | null, label: string, fallback?: number): number {
  if (value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new RecordingUploadError(400, 'INVALID_RECORDING_CHUNK', `${label} is required`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RecordingUploadError(400, 'INVALID_RECORDING_CHUNK', `${label} must be a non-negative integer`);
  }
  return parsed;
}

function isFinalChunk(value: string | null): boolean {
  return value === '1' || value === 'true';
}

function getArtifactContentType(format: string): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'json') return 'application/json';
  return 'video/mp4';
}

function attachmentName(filePath: string): string {
  return path.basename(filePath).replace(/["\r\n]/g, '_') || 'recording-export';
}

function findLatestLiveBackup(roomId: string): LiveBackupRecording | null {
  const backups = Array.from(liveBackups.values())
    .filter((backup) => backup.roomId === roomId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return backups[0] || null;
}

async function handleLiveBackupRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/rtmp/backups')) return false;

  if (!applyCorsHeaders(req, res)) {
    writeJson(res, 403, { error: 'Forbidden: origin not allowed' });
    return true;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    if (url.pathname === '/rtmp/backups/latest' && req.method === 'GET') {
      const roomId = url.searchParams.get('roomId')?.trim() || '';
      if (!roomId) {
        throw new RecordingUploadError(400, 'INVALID_ROOM_ID', 'roomId is required');
      }
      authenticateLiveBackupRequest(req, roomId);
      const latest = findLatestLiveBackup(roomId);
      if (!latest) {
        writeJson(res, 404, { error: 'No live backup recording found', code: 'LIVE_BACKUP_NOT_FOUND' });
        return true;
      }
      if (latest.status === 'ready') await refreshLiveBackupSize(latest);
      writeJson(res, 200, toLiveBackupPublicStatus(latest));
      return true;
    }

    const downloadMatch = url.pathname.match(/^\/rtmp\/backups\/([^/]+)\/download$/);
    if (downloadMatch && req.method === 'GET') {
      const [, backupId] = downloadMatch;
      const backup = liveBackups.get(backupId);
      if (!backup) {
        writeJson(res, 404, { error: 'Live backup recording not found', code: 'LIVE_BACKUP_NOT_FOUND' });
        return true;
      }
      authenticateLiveBackupRequest(req, backup.roomId);
      if (backup.status !== 'ready') {
        writeJson(res, 409, { error: 'Live backup recording is not ready', code: 'LIVE_BACKUP_NOT_READY' });
        return true;
      }
      await refreshLiveBackupSize(backup);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(backup.sizeBytes || 0),
        'Content-Disposition': `attachment; filename="${attachmentName(backup.fileName)}"`,
      });
      createReadStream(backup.filePath)
        .on('error', (err) => {
          console.error('Live backup recording stream failed:', err);
          res.destroy(err);
        })
        .pipe(res);
      return true;
    }

    const statusMatch = url.pathname.match(/^\/rtmp\/backups\/([^/]+)$/);
    if (statusMatch && req.method === 'GET') {
      const [, backupId] = statusMatch;
      const backup = liveBackups.get(backupId);
      if (!backup) {
        writeJson(res, 404, { error: 'Live backup recording not found', code: 'LIVE_BACKUP_NOT_FOUND' });
        return true;
      }
      authenticateLiveBackupRequest(req, backup.roomId);
      if (backup.status === 'ready') await refreshLiveBackupSize(backup);
      writeJson(res, 200, toLiveBackupPublicStatus(backup));
      return true;
    }

    writeJson(res, 404, { error: 'Live backup recording route not found' });
    return true;
  } catch (err) {
    if (err instanceof RecordingUploadError) {
      writeJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    console.error('Live backup recording request failed:', err);
    writeJson(res, 500, { error: 'Live backup recording request failed', code: 'LIVE_BACKUP_REQUEST_FAILED' });
    return true;
  }
}

async function handleRecordingUploadRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/recordings/uploads')) return false;

  if (!applyCorsHeaders(req, res)) {
    writeJson(res, 403, { error: 'Forbidden: origin not allowed' });
    return true;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    if (url.pathname === '/recordings/uploads' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.roomId !== 'string') {
        throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording upload request');
      }
      const roomId = body.roomId;
      authenticateRecordingUpload(req, roomId, isRecord(body) ? body.token : undefined);
      const session = await recordingUploads.createSession(body);
      writeJson(res, 201, session);
      return true;
    }

    const chunkMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/tracks\/([^/]+)\/chunks$/);
    if (chunkMatch && req.method === 'POST') {
      const [, uploadId, trackId] = chunkMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId);
      const data = await readRequestBody(req, MAX_RECORDING_UPLOAD_CHUNK_BYTES);
      const response = await recordingUploads.appendChunk({
        uploadId,
        trackId,
        sequence: parseNonNegativeInteger(url.searchParams.get('sequence'), 'sequence'),
        offset: url.searchParams.has('offset')
          ? parseNonNegativeInteger(url.searchParams.get('offset'), 'offset')
          : undefined,
        final: isFinalChunk(url.searchParams.get('final')),
        data,
      });
      writeJson(res, 200, response);
      return true;
    }

    const completeMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/complete$/);
    if (completeMatch && req.method === 'POST') {
      const [, uploadId] = completeMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId);
      writeJson(res, 200, recordingUploads.completeSession(uploadId));
      return true;
    }

    const exportMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/exports$/);
    if (exportMatch && req.method === 'POST') {
      const [, uploadId] = exportMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId);
      const body = await readOptionalJsonBody(req);
      const request = isRecord(body) ? body as RecordingExportSessionRequest : {};
      const exportStore = getRecordingExportStore();
      const job = await exportStore.createJob(recordingUploads.getExportSource(uploadId), request);
      void exportStore.startJob(job.exportId).catch((err) => {
        console.error('Recording export job failed:', err);
      });
      writeJson(res, 202, job);
      return true;
    }

    const artifactMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/exports\/([^/]+)\/artifacts\/([^/]+)$/);
    if (artifactMatch && req.method === 'GET') {
      const [, uploadId, exportId, artifactId] = artifactMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId);
      const artifact = getRecordingExportStore().getArtifact(exportId, artifactId, uploadId);
      res.writeHead(200, {
        'Content-Type': getArtifactContentType(artifact.format),
        'Content-Disposition': `attachment; filename="${attachmentName(artifact.path)}"`,
      });
      createReadStream(artifact.path)
        .on('error', (err) => {
          console.error('Recording export artifact stream failed:', err);
          res.destroy(err);
        })
        .pipe(res);
      return true;
    }

    const exportStatusMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/exports\/([^/]+)$/);
    if (exportStatusMatch && req.method === 'GET') {
      const [, uploadId, exportId] = exportStatusMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId);
      writeJson(res, 200, getRecordingExportStore().getJob(exportId, uploadId));
      return true;
    }

    const sessionMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)$/);
    if (sessionMatch && (req.method === 'GET' || req.method === 'DELETE')) {
      const [, uploadId] = sessionMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId);
      if (req.method === 'DELETE') {
        await recordingUploads.deleteSession(uploadId);
        writeJson(res, 200, { uploadId, deleted: true });
      } else {
        writeJson(res, 200, recordingUploads.getStatus(uploadId));
      }
      return true;
    }

    writeJson(res, 404, { error: 'Recording upload route not found' });
    return true;
  } catch (err) {
    if (err instanceof RecordingUploadError) {
      writeJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    if (err instanceof RecordingExportJobError) {
      writeJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    console.error('Recording upload request failed:', err);
    writeJson(res, 500, { error: 'Recording upload failed', code: 'RECORDING_UPLOAD_FAILED' });
    return true;
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthPayload()));
    return;
  }

  if (req.url === '/metrics') {
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    res.end(buildMediaRelayPrometheusMetrics(sessions));
    return;
  }

  const url = new URL(req.url || '/', 'http://media-server.local');
  if (await handleLiveBackupRequest(req, res, url)) return;
  if (await handleRecordingUploadRequest(req, res, url)) return;

  writeJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error('Media server request failed:', err);
    if (!res.headersSent) writeJson(res, 500, { error: 'Internal server error' });
    else res.end();
  });
});

const wss = new WebSocketServer({
  server,
  path: '/rtmp',
  maxPayload: MAX_WS_PAYLOAD_BYTES,
  verifyClient: (info, done) => {
    const headerOrigin = info.req.headers.origin;
    const origin = info.origin || (Array.isArray(headerOrigin) ? headerOrigin[0] : headerOrigin);
    if (isAllowedOrigin(origin, { allowedOrigins, production: isProduction })) {
      done(true);
    } else {
      console.warn(`RTMP relay connection rejected from origin: ${origin}`);
      done(false, 403, 'Forbidden: origin not allowed');
    }
  },
});

wss.on('connection', (ws) => {
  const session: RelaySession = {
    started: false,
    stopping: false,
    claims: null,
    destinations: [],
    relays: new Map(),
    backup: null,
    backupStopTimer: null,
    stopTimers: new Map(),
    restartTimers: new Map(),
    restartAttempts: new Map(),
  };
  sessions.set(ws, session);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryChunk(ws, session, data);
      return;
    }

    const message = parseControlMessage(data);
    if (!message) {
      sendError(ws, 'INVALID_MESSAGE', 'Invalid relay message');
      return;
    }

    if (message.type === 'start') {
      void handleStart(ws, session, message.payload).catch((err) => {
        const message = err instanceof Error ? err.message : 'Unable to start relay session';
        sendError(ws, 'START_FAILED', message);
        stopSession(ws, session, message);
      });
    } else if (message.type === 'ping') {
      sendJson(ws, {
        type: 'pong',
        payload: {
          sentAt: message.payload.sentAt,
          sequence: message.payload.sequence,
          receivedAt: Date.now(),
        },
      });
    } else {
      stopSession(ws, session, 'client requested stop');
      ws.close(1000, 'Relay stopped');
    }
  });

  ws.on('close', () => {
    stopSession(ws, session, 'client disconnected');
    sessions.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('RTMP relay socket error:', err.message);
    stopSession(ws, session, 'socket error');
  });
});

server.listen(PORT, () => {
  console.log(`Media server running on http://localhost:${PORT}`);
  console.log(`RTMP relay WebSocket on ws://localhost:${PORT}/rtmp`);
});

function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down media server...`);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
