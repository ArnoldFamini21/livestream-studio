import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
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
  RecordingUploadTokenClaims,
} from '@studio/shared';
import { buildServiceHealthPayload } from '@studio/shared';
import { getLiveStreamTokenSecret, verifyLiveStreamToken, verifyRecordingUploadToken } from './auth.js';
import { buildMediaRelayPrometheusMetrics } from './metrics.js';
import {
  buildLiveBackupLatestKey,
  buildLiveBackupObjectKeys,
  buildLiveBackupRecordKey,
  buildRecordingExportObjectKey,
  createObjectStoragePresignedGetUrl,
  getObjectStorageText,
  getRecordingObjectStorageConfig,
  putObjectStorageText,
  uploadFileToObjectStorage,
  type ObjectStorageConfig,
} from './objectStorage.js';
import { buildAllowedOrigins, isAllowedOrigin, normalizeOrigin } from './origins.js';
import { parseControlMessage } from './protocol.js';
import { SfuManager } from './sfuManager.js';
import { parseSfuAuthFrame, verifySfuIdentity } from './sfuAuth.js';
import { SfuMediaTransport } from './sfuTransport.js';
import {
  createFfmpegLiveBackupArgs,
  createLiveBackupRecording,
  fromStoredLiveBackupRecord,
  getLiveBackupMaxBytes,
  isLiveBackupRecordingEnabled,
  parseStoredLiveBackupRecord,
  refreshLiveBackupSize,
  storeLiveBackupRecording,
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
  MAX_PRESENTATION_RENDER_BYTES,
  PresentationRenderError,
  getPresentationRendererHealth,
  renderPresentationPreview,
  convertPresentationToPdf,
  type PresentationRendererHealth,
} from './presentationRender.js';
import {
  bytesForSeconds,
  createFfmpegArgs,
  createFfmpegEncoderArgs,
  createFfmpegPushArgs,
  hasRemainingRelayWork,
  isEncodeOnceEnabled,
  normalizeAudioConfig,
  normalizeVideoConfig,
  redactDestinationUrl,
  redactFfmpegLine,
  validateDestinations,
} from './rtmp.js';
import { WebmSinkFeed, WebmStreamTracker } from './webmStream.js';
import { FlvSinkFeed, FlvTagStream } from './flvStream.js';
import {
  HLS_PLAYLIST_NAME,
  HlsViewerCounter,
  createFfmpegHlsArgs,
  getHlsContentType,
  getHlsRoomDir,
  isServableHlsFile,
  isValidWatchRoomId,
  prepareHlsRoomDir,
  removeHlsWriterDir,
} from './hlsOutput.js';

const PORT = Number(process.env.PORT || process.env.MEDIA_SERVER_PORT || 3002);
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXPORT_REQUEST_MAX_BYTES = 256 * 1024;
const MAX_DESTINATION_RESTARTS = 2;
const DESTINATION_RESTART_DELAY_MS = 1_500;
const MEDIA_HEALTH_CAPABILITY_CACHE_MS = 60_000;
const MAX_ENCODER_RESTARTS = 2;
// Seconds of media an FFmpeg input may queue before its feed skips ahead to
// the live edge. Without a bound, a slow destination or a CPU-starved encoder
// grows server memory without limit and viewers fall further behind.
const RELAY_INPUT_BACKLOG_SECONDS = 6;
const isProduction = process.env.NODE_ENV === 'production';

interface RelayProcess {
  destination: RtmpRelayDestination;
  process: ChildProcessByStdio<Writable, null, Readable>;
  /** Per-destination encode: the studio's WebM goes straight in. */
  feed: WebmSinkFeed | null;
  /** Encode-once: the shared encoder's FLV goes in and is copied to RTMP. */
  flvFeed: FlvSinkFeed | null;
  live: boolean;
  /** Spawned after media began, so it resumes from the cached init segment. */
  joinedMidStream: boolean;
  /** Replaced because the shared encoder restarted; its exit is expected. */
  retired: boolean;
  exited: boolean;
}

interface EncoderProcess {
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  feed: WebmSinkFeed;
  flv: FlvTagStream;
  exited: boolean;
}

/** The watch page's HLS writer: a copy of the shared encode, no re-encode. */
interface HlsProcess {
  roomId: string;
  dir: string;
  process: ChildProcessByStdio<Writable, null, Readable>;
  feed: FlvSinkFeed;
  exited: boolean;
}

interface BackupProcess {
  recording: LiveBackupRecording;
  process: ChildProcessByStdio<Writable, null, Readable>;
  feed: WebmSinkFeed;
  exited: boolean;
}

interface RelaySession {
  started: boolean;
  stopping: boolean;
  claims: LiveStreamTokenClaims | null;
  destinations: RtmpRelayDestination[];
  webm: WebmStreamTracker;
  /** One H.264 encode shared by every destination (RTMP_ENCODE_ONCE). */
  encodeOnce: boolean;
  encoder: EncoderProcess | null;
  encoderRestartAttempts: number;
  encoderRestartTimer: ReturnType<typeof setTimeout> | null;
  relaysStopRequested: boolean;
  relays: Map<string, RelayProcess>;
  backup: BackupProcess | null;
  backupStopTimer: ReturnType<typeof setTimeout> | null;
  hls: HlsProcess | null;
  stopTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartAttempts: Map<string, number>;
}

const allowedOrigins = buildAllowedOrigins(process.env.CLIENT_URL, process.env.CLIENT_URLS);
const sessions = new Map<WebSocket, RelaySession>();
const liveBackups = new Map<string, LiveBackupRecording>();
/** Rooms with a live HLS program, by room id. */
const liveWatchRooms = new Map<string, { dir: string; startedAt: string; viewers: HlsViewerCounter }>();
const recordingUploads = new RecordingUploadStore();
let recordingExports: RecordingExportJobStore | null = null;
let recordingExportsFfmpegPath = '';
let recordingExportsStorageFingerprint = '';
let presentationRendererHealthCache: {
  expiresAt: number;
  value: PresentationRendererHealth;
} | null = null;

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

async function getCachedPresentationRendererHealth(): Promise<PresentationRendererHealth> {
  const now = Date.now();
  if (presentationRendererHealthCache && presentationRendererHealthCache.expiresAt > now) {
    return presentationRendererHealthCache.value;
  }

  const value = await getPresentationRendererHealth();
  presentationRendererHealthCache = {
    expiresAt: now + MEDIA_HEALTH_CAPABILITY_CACHE_MS,
    value,
  };
  return value;
}

async function healthPayload() {
  const presentationRenderer = await getCachedPresentationRendererHealth();
  return {
    ...buildServiceHealthPayload('media-server', process.env),
    capabilities: {
      liveRelay: {
        encodeOnce: isEncodeOnceEnabled(),
        backlogSeconds: RELAY_INPUT_BACKLOG_SECONDS,
      },
      presentationRenderer: {
        ready: presentationRenderer.ready,
        message: presentationRenderer.message,
        details: {
          dependencies: presentationRenderer.dependencies,
        },
      },
      recordingStorage: getRecordingStorageHealth(),
    },
  };
}

/** Whether uploaded recordings survive a restart (object storage) or not (temp folder). */
function getRecordingStorageHealth() {
  const persistent = Boolean(getRecordingObjectStorageConfig(process.env));
  return {
    ready: persistent,
    message: persistent
      ? 'Uploaded recordings are saved to object storage.'
      : 'Uploaded recordings are kept in a temporary folder and are lost when the media server restarts or sleeps. Set the RECORDING_STORAGE_* variables to keep them.',
  };
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

function stopRelays(session: RelaySession) {
  if (session.relaysStopRequested) return;
  session.relaysStopRequested = true;
  for (const relay of session.relays.values()) {
    stopRelayProcess(session, relay);
  }
}

/** End an FFmpeg input and kill the process if it does not exit on its own. */
function endProcess(child: ChildProcessByStdio<Writable, Readable | null, Readable>, isExited: () => boolean) {
  try {
    child.stdin.end();
  } catch {
    // Process may already be exiting.
  }
  setTimeout(() => {
    if (!isExited()) child.kill('SIGTERM');
  }, SHUTDOWN_TIMEOUT_MS);
}

function stopSession(ws: WebSocket, session: RelaySession, reason?: string) {
  if (session.stopping) return;
  session.stopping = true;
  for (const timer of session.restartTimers.values()) {
    clearTimeout(timer);
  }
  session.restartTimers.clear();
  if (session.encoderRestartTimer) {
    clearTimeout(session.encoderRestartTimer);
    session.encoderRestartTimer = null;
  }
  stopBackupProcess(ws, session);
  stopHlsWriter(session);

  const encoder = session.encoder;
  if (encoder && !encoder.exited) {
    // Let the encoder flush its last frames into the destinations first; they
    // are stopped when its output ends, or after the shutdown timeout.
    endProcess(encoder.process, () => encoder.exited);
    setTimeout(() => stopRelays(session), SHUTDOWN_TIMEOUT_MS);
  } else {
    stopRelays(session);
  }

  for (const relay of session.relays.values()) {
    sendJson(ws, {
      type: 'destination-status',
      payload: { destinationId: relay.destination.id, status: 'idle' },
    });
  }
  sendJson(ws, { type: 'session-stopped', payload: { reason } });
}

function stopSessionIfNoRelayWork(ws: WebSocket, session: RelaySession) {
  if (!session.started || session.stopping || session.encoderRestartTimer) return;
  const relayWork = Array.from(session.relays.entries()).map(([destinationId, relay]) => ({
    exited: relay.exited,
    restartPending: session.restartTimers.has(destinationId),
  }));
  if (hasRemainingRelayWork(relayWork)) return;
  stopSession(ws, session, 'All RTMP destinations stopped.');
}

async function spawnHlsWriter(session: RelaySession, ffmpegPath: string, payload: RtmpRelayStartPayload) {
  const encoder = session.encoder;
  const roomId = session.claims?.roomId;
  if (!encoder || encoder.exited || !roomId || !isValidWatchRoomId(roomId) || session.stopping) return;
  let dir: string;
  try {
    dir = await prepareHlsRoomDir(roomId);
  } catch (err) {
    console.warn('Watch page HLS folder could not be prepared:', err instanceof Error ? err.message : err);
    return;
  }
  if (session.stopping || session.hls || session.encoder !== encoder || encoder.exited) {
    await removeHlsWriterDir(dir);
    return;
  }
  const child = spawn(ffmpegPath, createFfmpegHlsArgs(dir), { stdio: ['pipe', 'ignore', 'pipe'] });
  const options = { video: normalizeVideoConfig(payload.video), audio: normalizeAudioConfig(payload.audio) };
  const feed = new FlvSinkFeed(child.stdin, encoder.flv, {
    maxBufferedBytes: bytesForSeconds(RELAY_INPUT_BACKLOG_SECONDS, options),
    onOverflow: () => console.warn('Watch page HLS writer fell behind; skipping ahead'),
    onError: (err) => console.warn(`Watch page HLS input closed: ${err.message}`),
  });
  feed.join();
  const hls: HlsProcess = { roomId, dir, process: child, feed, exited: false };
  session.hls = hls;
  liveWatchRooms.set(roomId, { dir, startedAt: new Date().toISOString(), viewers: new HlsViewerCounter() });
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim();
    if (line) console.warn(`ffmpeg watch-page hls: ${line}`);
  });
  child.on('error', (err) => {
    hls.exited = true;
    console.warn('Watch page HLS writer failed:', err.message);
  });
  child.on('close', () => {
    hls.exited = true;
    if (session.hls === hls) session.hls = null;
    if (liveWatchRooms.get(roomId)?.dir === dir) liveWatchRooms.delete(roomId);
    // Viewers get a moment to see the last segments before the folder goes.
    setTimeout(() => { void removeHlsWriterDir(dir); }, 15_000);
  });
}

function stopHlsWriter(session: RelaySession) {
  const hls = session.hls;
  if (!hls) return;
  session.hls = null;
  if (liveWatchRooms.get(hls.roomId)?.dir === hls.dir) liveWatchRooms.delete(hls.roomId);
  if (hls.exited) return;
  try {
    hls.process.stdin.end();
  } catch {
    // Already closed.
  }
  setTimeout(() => {
    if (!hls.exited) hls.process.kill('SIGTERM');
  }, SHUTDOWN_TIMEOUT_MS);
}

/**
 * Public watch page endpoints. The room id is the capability, like an
 * unlisted video: status, the playlist, and its segments.
 */
async function handleWatchRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = url.pathname.match(/^\/watch\/([^/]+)\/([^/]+)$/);
  if (!match) return false;
  const [, roomId, file] = match;

  // Public endpoints: a page on the studio origin gets CORS headers; a plain
  // media request with no Origin (Safari's native HLS, VLC) is served as is.
  if (getRequestOrigin(req) && !applyCorsHeaders(req, res)) {
    writeJson(res, 403, { error: 'Forbidden: origin not allowed' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!isValidWatchRoomId(roomId)) {
    writeJson(res, 404, { error: 'Not found' });
    return true;
  }
  const live = liveWatchRooms.get(roomId);

  if (file === 'status') {
    res.setHeader('Cache-Control', 'no-store');
    writeJson(res, 200, live
      ? { live: true, startedAt: live.startedAt, playlistPath: `/watch/${encodeURIComponent(roomId)}/${HLS_PLAYLIST_NAME}?generation=${encodeURIComponent(path.basename(live.dir))}`, viewers: live.viewers.count() }
      : { live: false, viewers: 0 });
    return true;
  }
  if (!isServableHlsFile(file)) {
    writeJson(res, 404, { error: 'Not found' });
    return true;
  }
  const filePath = path.join(live?.dir || getHlsRoomDir(roomId), file);
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch {
    writeJson(res, 404, { error: live ? 'Not ready yet' : 'This broadcast is not live' });
    return true;
  }
  if (file === HLS_PLAYLIST_NAME && live) {
    const forwarded = req.headers['x-forwarded-for'];
    const viewerKey = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    live.viewers.record(viewerKey);
  }
  res.writeHead(200, {
    'Content-Type': getHlsContentType(file),
    'Content-Length': String(size),
    // Do not retain live footage in intermediary caches.
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath)
    .on('error', (err) => {
      console.error('Watch page file stream failed:', err);
      res.destroy(err);
    })
    .pipe(res);
  return true;
}

function spawnRelay(
  ws: WebSocket,
  session: RelaySession,
  ffmpegPath: string,
  destination: RtmpRelayDestination,
  payload: RtmpRelayStartPayload
) {
  const options = {
    video: normalizeVideoConfig(payload.video),
    audio: normalizeAudioConfig(payload.audio),
  };
  const encoder = session.encodeOnce ? session.encoder : null;
  const args = encoder ? createFfmpegPushArgs(destination) : createFfmpegArgs(destination, options);
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const onInputError = (err: Error) => {
    console.warn(`ffmpeg ${destination.name} input closed: ${err.message}`);
  };
  const backpressure = {
    maxBufferedBytes: bytesForSeconds(RELAY_INPUT_BACKLOG_SECONDS, options),
    onOverflow: () => {
      console.warn(`RTMP relay ${destination.name} fell ${RELAY_INPUT_BACKLOG_SECONDS}s behind; skipping ahead to the live edge`);
      sendJson(ws, {
        type: 'destination-status',
        payload: {
          destinationId: destination.id,
          status: 'live',
          message: 'Upload to this destination is falling behind; skipping ahead to stay live.',
        },
      });
    },
    onRecover: (droppedBytes: number) => {
      const seconds = Math.max(1, Math.round(droppedBytes / Math.max(1, bytesForSeconds(1, options))));
      sendJson(ws, {
        type: 'destination-status',
        payload: {
          destinationId: destination.id,
          status: 'live',
          message: `Caught up: skipped about ${seconds}s to stay live.`,
        },
      });
    },
  };

  let feed: WebmSinkFeed | null = null;
  let flvFeed: FlvSinkFeed | null = null;
  let joinedMidStream: boolean;
  if (encoder) {
    // Copy-only uploader: a restart rejoins the shared encode at the next
    // keyframe, without re-encoding and without touching other destinations.
    flvFeed = new FlvSinkFeed(child.stdin, encoder.flv, { ...backpressure, onError: onInputError });
    joinedMidStream = flvFeed.join() === 'resync';
  } else {
    feed = new WebmSinkFeed(child.stdin, onInputError, backpressure);
    // A respawn joins mid-stream: FFmpeg gets the init segment first, then live
    // media from the next Cluster boundary. Other destinations are untouched.
    const join = feed.join(session.webm);
    if (join === 'no-init') {
      console.warn(`RTMP relay ${destination.name} restarted without a WebM init segment; FFmpeg may reject the stream`);
    }
    joinedMidStream = join !== 'from-start';
  }
  const relay: RelayProcess = {
    destination,
    process: child,
    feed,
    flvFeed,
    live: false,
    joinedMidStream,
    retired: false,
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
    if (relay.retired) return;
    sendJson(ws, {
      type: 'destination-status',
      payload: { destinationId: destination.id, status: 'error', message: err.message },
    });
  });

  child.on('close', (code, signal) => {
    relay.exited = true;
    if (relay.retired) return;
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
    // A respawn that dies before its first Cluster was still a live destination.
    if ((relay.live || relay.joinedMidStream) && attempts < MAX_DESTINATION_RESTARTS) {
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

/**
 * Start the shared encoder. Its FLV output fans out to every destination's
 * copy-only uploader, so CPU cost no longer grows with the destination count.
 */
function spawnEncoder(
  ws: WebSocket,
  session: RelaySession,
  ffmpegPath: string,
  payload: RtmpRelayStartPayload
): EncoderProcess {
  const options = {
    video: normalizeVideoConfig(payload.video),
    audio: normalizeAudioConfig(payload.audio),
  };
  const child = spawn(ffmpegPath, createFfmpegEncoderArgs(options), { stdio: ['pipe', 'pipe', 'pipe'] });
  const flv = new FlvTagStream();
  const feed = new WebmSinkFeed(child.stdin, (err) => {
    console.warn(`ffmpeg encoder input closed: ${err.message}`);
  }, {
    maxBufferedBytes: bytesForSeconds(RELAY_INPUT_BACKLOG_SECONDS, options),
    onOverflow: () => {
      console.warn(`Live encoder fell ${RELAY_INPUT_BACKLOG_SECONDS}s behind; skipping ahead to the live edge`);
      for (const relay of session.relays.values()) {
        if (relay.exited || relay.retired) continue;
        sendJson(ws, {
          type: 'destination-status',
          payload: {
            destinationId: relay.destination.id,
            status: 'live',
            message: 'The server encoder is overloaded; skipping ahead to stay live.',
          },
        });
      }
    },
  });
  const join = feed.join(session.webm);
  if (join === 'no-init') {
    console.warn('Live encoder restarted without a WebM init segment; FFmpeg may reject the stream');
  }
  const encoder: EncoderProcess = { process: child, feed, flv, exited: false };
  session.encoder = encoder;
  console.log(`Live encoder starting for ${session.destinations.length} destination(s)`);

  child.stdout.on('data', (data: Buffer) => {
    const chunk = flv.push(data);
    // The watch page's HLS writer takes the same tags as the destinations.
    const hls = session.hls;
    if (chunk && hls && !hls.exited) hls.feed.write(chunk);
    if (!chunk) return;
    for (const relay of session.relays.values()) {
      if (relay.exited || relay.retired || !relay.flvFeed) continue;
      if (!relay.flvFeed.write(chunk) || relay.live) continue;
      relay.live = true;
      sendJson(ws, {
        type: 'destination-status',
        payload: { destinationId: relay.destination.id, status: 'live' },
      });
    }
  });
  child.stdout.on('end', () => {
    if (session.stopping) stopRelays(session);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const line = redactFfmpegLine(chunk.toString('utf8').trim(), session.destinations);
    if (line) console.warn(`ffmpeg encoder: ${line}`);
  });

  let handled = false;
  const onExit = (message: string) => {
    encoder.exited = true;
    if (handled) return;
    handled = true;
    if (session.stopping) {
      stopRelays(session);
      return;
    }
    if (session.encoder !== encoder) return;

    stopHlsWriter(session);

    // Every uploader was fed by this encode. Retire them; a new encoder
    // starts a new FLV stream, and they are respawned against it.
    for (const timer of session.restartTimers.values()) clearTimeout(timer);
    session.restartTimers.clear();
    for (const relay of session.relays.values()) {
      if (relay.exited) continue;
      relay.retired = true;
      endProcess(relay.process, () => relay.exited);
    }

    const canResume = session.webm.joinPoint() !== null;
    if (canResume && session.encoderRestartAttempts < MAX_ENCODER_RESTARTS) {
      session.encoderRestartAttempts += 1;
      const attempt = session.encoderRestartAttempts;
      console.warn(`Live encoder stopped (${message}); restarting ${attempt}/${MAX_ENCODER_RESTARTS}`);
      for (const destination of session.destinations) {
        sendJson(ws, {
          type: 'destination-status',
          payload: {
            destinationId: destination.id,
            status: 'connecting',
            message: `Restarting the encoder (${attempt}/${MAX_ENCODER_RESTARTS})`,
          },
        });
      }
      session.encoderRestartTimer = setTimeout(() => {
        session.encoderRestartTimer = null;
        if (session.stopping || ws.readyState !== WebSocket.OPEN) return;
        spawnEncoder(ws, session, ffmpegPath, payload);
        void spawnHlsWriter(session, ffmpegPath, payload);
        for (const destination of session.destinations) {
          spawnRelay(ws, session, ffmpegPath, destination, payload);
        }
      }, DESTINATION_RESTART_DELAY_MS);
      return;
    }

    for (const destination of session.destinations) {
      sendJson(ws, {
        type: 'destination-status',
        payload: { destinationId: destination.id, status: 'error', message: `Live encoder stopped: ${message}` },
      });
    }
    stopSession(ws, session, 'The live encoder stopped.');
  };

  child.on('error', (err) => onExit(err.message));
  child.on('close', (code, signal) => {
    onExit(signal ? `FFmpeg exited from ${signal}` : `FFmpeg exited with code ${code ?? 'unknown'}`);
  });
  return encoder;
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
    const feed = new WebmSinkFeed(child.stdin, (err) => {
      console.warn(`ffmpeg live backup ${recording.backupId} input closed: ${err.message}`);
    }, {
      maxBufferedBytes: bytesForSeconds(RELAY_INPUT_BACKLOG_SECONDS * 2, {
        video: normalizeVideoConfig(payload.video),
        audio: normalizeAudioConfig(payload.audio),
      }),
      onOverflow: () => {
        console.warn(`Live backup ${recording.backupId} fell behind; skipping ahead`);
      },
    });
    feed.join(session.webm);
    const backup: BackupProcess = {
      recording,
      process: child,
      feed,
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
          const storageConfig = getRecordingObjectStorageConfig();
          if (storageConfig) {
            void storeLiveBackupRecording(recording, {
              keys: buildLiveBackupObjectKeys({
                prefix: storageConfig.prefix,
                roomId: recording.roomId,
                backupId: recording.backupId,
                fileName: recording.fileName,
              }),
              uploadFile: (input) => uploadFileToObjectStorage(storageConfig, input),
              putText: (key, body) => putObjectStorageText(storageConfig, key, body),
            }).then(() => {
              if (recording.storageStatus === 'failed') {
                console.warn(`Live backup ${recording.backupId} upload failed: ${recording.storageError}`);
              }
              sendJson(ws, {
                type: 'backup-recording-status',
                payload: toLiveBackupPublicStatus(recording),
              });
            });
          }
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
  session.encodeOnce = isEncodeOnceEnabled();

  await spawnLiveBackup(ws, session, ffmpegPath, claims, payload);
  if (session.stopping) return;

  if (session.encodeOnce) spawnEncoder(ws, session, ffmpegPath, payload);

  for (const destination of payload.destinations) {
    spawnRelay(ws, session, ffmpegPath, destination, payload);
  }
  if (session.encodeOnce) await spawnHlsWriter(session, ffmpegPath, payload);

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
  const info = session.webm.push(chunk);
  if (session.encodeOnce) {
    // Destinations go live when the encoder's output reaches them.
    const encoder = session.encoder;
    if (encoder && !encoder.exited) encoder.feed.write(chunk, info);
  } else {
    for (const relay of session.relays.values()) {
      if (relay.exited || !relay.feed || !relay.feed.write(chunk, info) || relay.live) continue;
      relay.live = true;
      sendJson(ws, {
        type: 'destination-status',
        payload: { destinationId: relay.destination.id, status: 'live' },
      });
    }
  }
  const backup = session.backup;
  if (backup && !backup.exited) {
    backup.feed.write(chunk, info);
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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-File-Name');
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

function authenticateRecordingUpload(
  req: IncomingMessage,
  roomId: string,
  bodyToken?: unknown,
  sessionId?: string,
  participantId?: string
): LiveStreamTokenClaims | RecordingUploadTokenClaims {
  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    throw new RecordingUploadError(503, 'LIVE_STREAM_NOT_CONFIGURED', 'Recording uploads are not configured on this server');
  }
  const token = getBearerToken(req) || (typeof bodyToken === 'string' ? bodyToken.trim() : '');
  if (!token) {
    throw new RecordingUploadError(401, 'UNAUTHORIZED', 'Recording upload token is required');
  }
  let claims: LiveStreamTokenClaims | RecordingUploadTokenClaims;
  try {
    claims = verifyLiveStreamToken(token, secret);
  } catch {
    try {
      claims = verifyRecordingUploadToken(token, secret);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid recording upload token';
      throw new RecordingUploadError(401, 'UNAUTHORIZED', message);
    }
  }
  if (claims.roomId !== roomId) {
    throw new RecordingUploadError(403, 'ROOM_TOKEN_MISMATCH', 'Recording upload token does not match this room');
  }
  if ('purpose' in claims && claims.purpose === 'recording-upload') {
    if (!sessionId || claims.sessionId !== sessionId) {
      throw new RecordingUploadError(403, 'RECORDING_SESSION_MISMATCH', 'Recording upload token does not match this session');
    }
    if (participantId && claims.participantId !== participantId) {
      throw new RecordingUploadError(403, 'RECORDING_PARTICIPANT_MISMATCH', 'Recording upload token does not match this participant');
    }
  }
  return claims;
}

function authenticateHostRecordingRequest(req: IncomingMessage, roomId: string): LiveStreamTokenClaims {
  const secret = getLiveStreamTokenSecret();
  if (!secret) {
    throw new RecordingUploadError(503, 'LIVE_STREAM_NOT_CONFIGURED', 'Recording exports are not configured on this server');
  }
  const token = getBearerToken(req);
  if (!token) throw new RecordingUploadError(401, 'UNAUTHORIZED', 'A host recording token is required');
  let claims: LiveStreamTokenClaims;
  try {
    claims = verifyLiveStreamToken(token, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid host recording token';
    throw new RecordingUploadError(401, 'UNAUTHORIZED', message);
  }
  if (claims.roomId !== roomId) {
    throw new RecordingUploadError(403, 'ROOM_TOKEN_MISMATCH', 'Recording token does not match this room');
  }
  return claims;
}

function authenticateLiveBackupRequest(req: IncomingMessage, roomId: string) {
  const claims = authenticateLiveBackupToken(req);
  if (claims.roomId !== roomId) {
    throw new RecordingUploadError(403, 'ROOM_TOKEN_MISMATCH', 'Live backup token does not match this room');
  }
  return claims;
}

function authenticateLiveBackupToken(req: IncomingMessage): LiveStreamTokenClaims {
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
  return claims;
}

/** Load a backup from its record in object storage, after a restart or sleep. */
async function loadStoredLiveBackup(config: ObjectStorageConfig, recordKey: string): Promise<LiveBackupRecording | null> {
  const record = parseStoredLiveBackupRecord(await getObjectStorageText(config, recordKey));
  if (!record) return null;
  const backup = liveBackups.get(record.backupId) || fromStoredLiveBackupRecord(record, '');
  liveBackups.set(backup.backupId, backup);
  return backup;
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

async function readOptionalJsonBody(req: IncomingMessage, maxBytes = 32 * 1024): Promise<unknown> {
  const body = await readRequestBody(req, maxBytes);
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
      const storageConfig = getRecordingObjectStorageConfig();
      const latest = findLatestLiveBackup(roomId) || (storageConfig
        ? await loadStoredLiveBackup(storageConfig, buildLiveBackupLatestKey(storageConfig.prefix, roomId)).catch((err) => {
          // A storage outage must not turn "no backup" into an error.
          console.warn('Live backup storage lookup failed:', err instanceof Error ? err.message : err);
          return null;
        })
        : null);
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
      if (!backup.filePath || !existsSync(backup.filePath)) {
        // Moved to object storage; download-link serves it from there.
        writeJson(res, 409, { error: 'Live backup recording is in storage; request a download link', code: 'LIVE_BACKUP_STORED' });
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

    const linkMatch = url.pathname.match(/^\/rtmp\/backups\/([^/]+)\/download-link$/);
    if (linkMatch && req.method === 'GET') {
      const [, backupId] = linkMatch;
      // Check the token before touching storage.
      const claims = authenticateLiveBackupToken(req);
      const storageConfig = getRecordingObjectStorageConfig();
      const backup = liveBackups.get(backupId) || (storageConfig
        ? await loadStoredLiveBackup(storageConfig, buildLiveBackupRecordKey(storageConfig.prefix, backupId))
        : null);
      if (!backup) {
        writeJson(res, 404, { error: 'Live backup recording not found', code: 'LIVE_BACKUP_NOT_FOUND' });
        return true;
      }
      if (claims.roomId !== backup.roomId) {
        throw new RecordingUploadError(403, 'ROOM_TOKEN_MISMATCH', 'Live backup token does not match this room');
      }
      if (!storageConfig || backup.storageStatus !== 'stored' || !backup.storageKey) {
        writeJson(res, 409, { error: 'Live backup recording is not in storage yet', code: 'LIVE_BACKUP_NOT_STORED' });
        return true;
      }
      const expiresInSeconds = 60 * 60;
      writeJson(res, 200, {
        url: createObjectStoragePresignedGetUrl(storageConfig, {
          key: backup.storageKey,
          expiresInSeconds,
          downloadFileName: attachmentName(backup.fileName),
          contentType: 'video/mp4',
        }),
        fileName: attachmentName(backup.fileName),
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      });
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
  if (!url.pathname.startsWith('/recordings/')) return false;

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
    const distributedSessionMatch = url.pathname.match(/^\/recordings\/sessions\/([^/]+)\/([^/]+)$/);
    if (distributedSessionMatch && req.method === 'GET') {
      const [, roomId, sessionId] = distributedSessionMatch.map((value) => decodeURIComponent(value));
      authenticateHostRecordingRequest(req, roomId);
      writeJson(res, 200, recordingUploads.getDistributedSessionStatus(roomId, sessionId));
      return true;
    }

    const distributedExportMatch = url.pathname.match(/^\/recordings\/sessions\/([^/]+)\/([^/]+)\/exports$/);
    if (distributedExportMatch && req.method === 'POST') {
      const [, roomId, sessionId] = distributedExportMatch.map((value) => decodeURIComponent(value));
      authenticateHostRecordingRequest(req, roomId);
      // Export requests can carry a cleanup edit with up to 2000 kept ranges.
      const body = await readOptionalJsonBody(req, EXPORT_REQUEST_MAX_BYTES);
      const request = isRecord(body) ? body as RecordingExportSessionRequest : {};
      const exportStore = getRecordingExportStore();
      const job = await exportStore.createJob(
        recordingUploads.getDistributedExportSource(roomId, sessionId),
        request
      );
      void exportStore.startJob(job.exportId).catch((err) => {
        console.error('Distributed recording export job failed:', err);
      });
      writeJson(res, 202, job);
      return true;
    }

    if (url.pathname === '/recordings/uploads' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!isRecord(body) || typeof body.roomId !== 'string') {
        throw new RecordingUploadError(400, 'INVALID_RECORDING_UPLOAD', 'Invalid recording upload request');
      }
      const roomId = body.roomId;
      const claims = authenticateRecordingUpload(
        req,
        roomId,
        body.token,
        typeof body.sessionId === 'string' ? body.sessionId : undefined,
        typeof body.participantId === 'string' ? body.participantId : undefined
      );
      if ('purpose' in claims && claims.purpose === 'recording-upload') {
        body.participantId = claims.participantId;
        body.participantName = claims.participantName;
      }
      const session = await recordingUploads.createSession(body);
      writeJson(res, 201, session);
      return true;
    }

    const chunkMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/tracks\/([^/]+)\/chunks$/);
    if (chunkMatch && req.method === 'POST') {
      const [, uploadId, trackId] = chunkMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId, undefined, session.sessionId, session.participantId);
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
      authenticateRecordingUpload(req, session.roomId, undefined, session.sessionId, session.participantId);
      const completion = await readOptionalJsonBody(req);
      writeJson(res, 200, recordingUploads.completeSession(uploadId, Date.now(), completion));
      return true;
    }

    const exportMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)\/exports$/);
    if (exportMatch && req.method === 'POST') {
      const [, uploadId] = exportMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateHostRecordingRequest(req, session.roomId);
      // Export requests can carry a cleanup edit with up to 2000 kept ranges.
      const body = await readOptionalJsonBody(req, EXPORT_REQUEST_MAX_BYTES);
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
      authenticateHostRecordingRequest(req, session.roomId);
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
      authenticateHostRecordingRequest(req, session.roomId);
      writeJson(res, 200, getRecordingExportStore().getJob(exportId, uploadId));
      return true;
    }

    const sessionMatch = url.pathname.match(/^\/recordings\/uploads\/([^/]+)$/);
    if (sessionMatch && (req.method === 'GET' || req.method === 'DELETE')) {
      const [, uploadId] = sessionMatch;
      const session = recordingUploads.getSession(uploadId);
      authenticateRecordingUpload(req, session.roomId, undefined, session.sessionId, session.participantId);
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

async function handlePresentationPreviewRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const wantsPdf = url.pathname === '/presentation-pdf';
  if (url.pathname !== '/presentation-preview' && !wantsPdf) return false;

  if (!applyCorsHeaders(req, res)) {
    writeJson(res, 403, { error: 'Forbidden: origin not allowed' });
    return true;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  try {
    const fileNameHeader = req.headers['x-file-name'];
    const contentTypeHeader = req.headers['content-type'];
    const fileName = Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader;
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
    const data = await readRequestBody(req, MAX_PRESENTATION_RENDER_BYTES);

    const input = {
      fileName: fileName || 'presentation',
      contentType: contentType || 'application/octet-stream',
      data,
    };

    if (wantsPdf) {
      // The browser renders the pages; the server only runs LibreOffice.
      const { pdf, cached } = await convertPresentationToPdf(input);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.byteLength),
        'Cache-Control': 'no-store',
        'X-Presentation-Cache': cached ? 'hit' : 'miss',
        'Access-Control-Expose-Headers': 'X-Presentation-Cache',
      });
      res.end(pdf);
      return true;
    }

    const preview = await renderPresentationPreview(input);
    writeJson(res, 200, preview);
    return true;
  } catch (err) {
    if (err instanceof PresentationRenderError) {
      writeJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    if (err instanceof RecordingUploadError) {
      writeJson(res, err.statusCode, { error: err.message, code: err.code });
      return true;
    }
    console.error('Presentation preview render failed:', err);
    writeJson(res, 500, { error: 'Presentation preview render failed', code: 'PRESENTATION_RENDER_FAILED' });
    return true;
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://media-server.local');
  if (url.pathname === '/health') {
    if (!applyCorsHeaders(req, res)) {
      writeJson(res, 403, { error: 'Forbidden: origin not allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await healthPayload()));
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

  if (await handleLiveBackupRequest(req, res, url)) return;
  if (await handleWatchRequest(req, res, url)) return;
  if (await handleRecordingUploadRequest(req, res, url)) return;
  if (await handlePresentationPreviewRequest(req, res, url)) return;

  writeJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error('Media server request failed:', err);
    if (!res.headersSent) writeJson(res, 500, { error: 'Internal server error' });
    else res.end();
  });
});

// Both WebSocket endpoints share the HTTP server, so each uses noServer and a
// single upgrade router dispatches by path (a path-bound WSS would 400 the other).
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
const MAX_SFU_WS_PAYLOAD_BYTES = 64 * 1024;
const sfuWss = new WebSocketServer({ noServer: true, maxPayload: MAX_SFU_WS_PAYLOAD_BYTES });

server.on('upgrade', (req, socket, head) => {
  const headerOrigin = req.headers.origin;
  const origin = Array.isArray(headerOrigin) ? headerOrigin[0] : headerOrigin;
  if (!isAllowedOrigin(origin, { allowedOrigins, production: isProduction })) {
    console.warn(`WebSocket connection rejected from origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    pathname = '';
  }

  if (pathname === '/rtmp') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/sfu') {
    sfuWss.handleUpgrade(req, socket, head, (ws) => sfuWss.emit('connection', ws, req));
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

const sfuManager = new SfuManager({}, (roomSend) => new SfuMediaTransport({
  onIceCandidate: (participantId, side, candidate) => {
    roomSend(participantId, { type: 'sfu-transport-ice', side, candidate });
  },
}));

sfuWss.on('connection', (ws) => {
  let sfuParticipantId: string | null = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary || !Buffer.isBuffer(data)) {
      ws.close(1003, 'Binary frames are not supported on /sfu');
      return;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sfu-error', message: 'Invalid SFU message' }));
      }
      return;
    }

    if (sfuParticipantId === null) {
      const frame = parseSfuAuthFrame(parsed);
      if (!frame) {
        ws.close(1008, 'Authenticate with sfu-auth first');
        return;
      }
      const secret = getLiveStreamTokenSecret();
      if (!secret) {
        ws.close(1011, 'SFU signaling is not configured');
        return;
      }
      try {
        const identity = verifySfuIdentity(frame.token, secret);
        sfuParticipantId = identity.participantId;
        sfuManager.connect(identity.roomId, identity.participantId, (message) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        });
        ws.send(JSON.stringify({
          type: 'sfu-ready',
          roomId: identity.roomId,
          participantId: identity.participantId,
        }));
      } catch {
        ws.close(1008, 'Unauthorized');
      }
      return;
    }

    sfuManager.handleMessage(sfuParticipantId, parsed);
  });

  ws.on('close', () => {
    if (sfuParticipantId) {
      sfuManager.disconnect(sfuParticipantId);
      sfuParticipantId = null;
    }
  });

  ws.on('error', (err) => {
    console.error('SFU socket error:', err.message);
    if (sfuParticipantId) {
      sfuManager.disconnect(sfuParticipantId);
      sfuParticipantId = null;
    }
  });
});

wss.on('connection', (ws) => {
  const session: RelaySession = {
    started: false,
    stopping: false,
    claims: null,
    destinations: [],
    webm: new WebmStreamTracker(),
    encodeOnce: false,
    encoder: null,
    encoderRestartAttempts: 0,
    encoderRestartTimer: null,
    relaysStopRequested: false,
    relays: new Map(),
    backup: null,
    backupStopTimer: null,
    hls: null,
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
  console.log(`SFU signaling WebSocket on ws://localhost:${PORT}/sfu`);
});

function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down media server...`);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  sfuWss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
  sfuWss.close();
  wss.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
