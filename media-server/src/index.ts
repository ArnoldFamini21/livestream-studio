import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  createFfmpegSlateArgs,
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
import { FlvSinkFeed } from './flvStream.js';
import { FlvProgram, type FlvProgramSource } from './flvSplice.js';
import { isSameRelaySetup, shouldShowSlate, STUDIO_RECONNECT_HOLD_MS } from './relayResume.js';
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
  sweepStaleHlsWriterDirs,
} from './hlsOutput.js';
import {
  DESTINATION_LIVE_CONFIRM_MS,
  MAX_DESTINATION_RECONNECTS,
  MAX_UNCONFIRMED_DESTINATION_RECONNECTS,
  getDestinationReconnectDelayMs,
  getReconnectAttemptsAfterDrop,
} from './destinationReconnect.js';

const PORT = Number(process.env.PORT || process.env.MEDIA_SERVER_PORT || 3002);
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXPORT_REQUEST_MAX_BYTES = 256 * 1024;
const MEDIA_HEALTH_CAPABILITY_CACHE_MS = 60_000;
const MAX_ENCODER_RESTARTS = 2;
const ENCODER_RESTART_DELAY_MS = 1_500;
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
  /** When this connection went live; a long-healthy connection resets the reconnect count. */
  liveSinceMs: number | null;
  /** Reports "live" once the connection has held (see markRelayReceivingMedia). */
  confirmTimer: ReturnType<typeof setTimeout> | null;
  /** Spawned after media began, so it resumes from the cached init segment. */
  joinedMidStream: boolean;
  /** Replaced because the shared encoder restarted; its exit is expected. */
  retired: boolean;
  exited: boolean;
}

interface EncoderProcess {
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  feed: WebmSinkFeed;
  source: FlvProgramSource;
  exited: boolean;
}

/** "We'll be right back" on the program while the studio reconnects. */
interface SlateProcess {
  process: ChildProcessByStdio<null, Readable, Readable>;
  source: FlvProgramSource;
  startedAtMs: number;
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
  /** The studio's connection; replaced when a studio that dropped reconnects. */
  client: WebSocket;
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
  /** Destinations whose RTMP connection has held at least once this session. */
  confirmedDestinations: Set<string>;
  payload: RtmpRelayStartPayload | null;
  /** Encode-once: what the destinations receive, spliced across encoders. */
  program: FlvProgram | null;
  slate: SlateProcess | null;
  lastMediaAtMs: number;
  /** The studio's connection closed; the broadcast waits on the slate. */
  clientGone: boolean;
  watchdog: ReturnType<typeof setInterval> | null;
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

function stopBackupProcess(session: RelaySession) {
  const backup = session.backup;
  if (!backup || backup.exited) return;
  backup.recording.status = 'finalizing';
  backup.recording.stoppedAt = new Date().toISOString();
  sendJson(session.client, {
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

function stopSession(session: RelaySession, reason?: string) {
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
  stopBackupProcess(session);
  stopHlsWriter(session);
  stopSlate(session);
  if (session.watchdog) {
    clearInterval(session.watchdog);
    session.watchdog = null;
  }
  // A broadcast held for a studio that never came back leaves the session list.
  if (session.clientGone && sessions.get(session.client) === session) sessions.delete(session.client);

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
    sendJson(session.client, {
      type: 'destination-status',
      payload: { destinationId: relay.destination.id, status: 'idle' },
    });
  }
  sendJson(session.client, { type: 'session-stopped', payload: { reason } });
}

function stopSessionIfNoRelayWork(session: RelaySession) {
  if (!session.started || session.stopping || session.encoderRestartTimer) return;
  const relayWork = Array.from(session.relays.entries()).map(([destinationId, relay]) => ({
    exited: relay.exited,
    restartPending: session.restartTimers.has(destinationId),
  }));
  if (hasRemainingRelayWork(relayWork)) return;
  stopSession(session, 'All RTMP destinations stopped.');
}

async function spawnHlsWriter(session: RelaySession, ffmpegPath: string, payload: RtmpRelayStartPayload) {
  const program = session.program;
  const roomId = session.claims?.roomId;
  if (!program || session.hls || !roomId || !isValidWatchRoomId(roomId) || session.stopping) return;
  let dir: string;
  try {
    dir = await prepareHlsRoomDir(roomId);
  } catch (err) {
    console.warn('Watch page HLS folder could not be prepared:', err instanceof Error ? err.message : err);
    return;
  }
  if (session.stopping || session.hls || session.program !== program) {
    await removeHlsWriterDir(dir);
    return;
  }
  const child = spawn(ffmpegPath, createFfmpegHlsArgs(dir), { stdio: ['pipe', 'ignore', 'pipe'] });
  const options = { video: normalizeVideoConfig(payload.video), audio: normalizeAudioConfig(payload.audio) };
  const feed = new FlvSinkFeed(child.stdin, program.stream, {
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
  session: RelaySession,
  ffmpegPath: string,
  destination: RtmpRelayDestination,
  payload: RtmpRelayStartPayload
) {
  const options = {
    video: normalizeVideoConfig(payload.video),
    audio: normalizeAudioConfig(payload.audio),
  };
  const program = session.encodeOnce ? session.program : null;
  const args = program ? createFfmpegPushArgs(destination) : createFfmpegArgs(destination, options);
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const onInputError = (err: Error) => {
    console.warn(`ffmpeg ${destination.name} input closed: ${err.message}`);
  };
  const backpressure = {
    maxBufferedBytes: bytesForSeconds(RELAY_INPUT_BACKLOG_SECONDS, options),
    onOverflow: () => {
      console.warn(`RTMP relay ${destination.name} fell ${RELAY_INPUT_BACKLOG_SECONDS}s behind; skipping ahead to the live edge`);
      sendJson(session.client, {
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
      sendJson(session.client, {
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
  if (program) {
    // Copy-only uploader: a restart rejoins the shared encode at the next
    // keyframe, without re-encoding and without touching other destinations.
    flvFeed = new FlvSinkFeed(child.stdin, program.stream, { ...backpressure, onError: onInputError });
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
    liveSinceMs: null,
    confirmTimer: null,
    joinedMidStream,
    retired: false,
    exited: false,
  };
  session.relays.set(destination.id, relay);

  sendJson(session.client, {
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
    sendJson(session.client, {
      type: 'destination-status',
      payload: { destinationId: destination.id, status: 'error', message: err.message },
    });
  });

  child.on('close', (code, signal) => {
    relay.exited = true;
    if (relay.confirmTimer) clearTimeout(relay.confirmTimer);
    relay.confirmTimer = null;
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

    const attempts = getReconnectAttemptsAfterDrop(
      session.restartAttempts.get(destination.id) || 0,
      relay.liveSinceMs,
      Date.now()
    );
    // A respawn that dies before its first Cluster was still a live destination.
    // A destination that has never held a connection (a wrong key or URL)
    // gets a short budget so the error shows quickly.
    const maxAttempts = session.confirmedDestinations.has(destination.id)
      ? MAX_DESTINATION_RECONNECTS
      : MAX_UNCONFIRMED_DESTINATION_RECONNECTS;
    if ((relay.live || relay.joinedMidStream) && attempts < maxAttempts) {
      const nextAttempt = attempts + 1;
      session.restartAttempts.set(destination.id, nextAttempt);
      const delayMs = getDestinationReconnectDelayMs(nextAttempt);
      sendJson(session.client, {
        type: 'destination-status',
        payload: {
          destinationId: destination.id,
          status: 'connecting',
          message: `Reconnecting (${nextAttempt}/${maxAttempts}) in ${Math.round(delayMs / 1000)} s`,
        },
      });
      const restartTimer = setTimeout(() => {
        session.restartTimers.delete(destination.id);
        if (session.stopping) return;
        spawnRelay(session, ffmpegPath, destination, payload);
      }, delayMs);
      session.restartTimers.set(destination.id, restartTimer);
      return;
    }

    console.warn(`RTMP relay ${destination.name} stopped: ${message}`);
    sendJson(session.client, {
      type: 'destination-status',
      payload: {
        destinationId: destination.id,
        status: 'error',
        message: session.confirmedDestinations.has(destination.id)
          ? `Lost the connection to ${destination.name} and could not reconnect. The other destinations are still live.`
          : `Could not connect to ${destination.name}. Check the server URL and stream key, and that the platform is ready to receive.`,
      },
    });
    stopSessionIfNoRelayWork(session);
  });
}

/**
 * Media is flowing into a destination's uploader. That alone does not mean
 * the platform accepted the connection: a refused or rejected RTMP connection
 * ends about a second later. Report "live" only once it has held, so the
 * panel never shows a destination live that is not receiving anything.
 */
function markRelayReceivingMedia(session: RelaySession, relay: RelayProcess) {
  relay.live = true;
  relay.liveSinceMs = Date.now();
  relay.confirmTimer = setTimeout(() => {
    relay.confirmTimer = null;
    if (relay.exited || relay.retired || session.stopping) return;
    session.confirmedDestinations.add(relay.destination.id);
    sendJson(session.client, {
      type: 'destination-status',
      payload: { destinationId: relay.destination.id, status: 'live' },
    });
  }, DESTINATION_LIVE_CONFIRM_MS);
}

/**
 * Start the shared encoder. Its FLV output fans out to every destination's
 * copy-only uploader, so CPU cost no longer grows with the destination count.
 */
function spawnEncoder(
  session: RelaySession,
  ffmpegPath: string,
  payload: RtmpRelayStartPayload
): EncoderProcess {
  const options = {
    video: normalizeVideoConfig(payload.video),
    audio: normalizeAudioConfig(payload.audio),
  };
  const program = session.program;
  if (!program) throw new Error('The live program is not ready.');
  const child = spawn(ffmpegPath, createFfmpegEncoderArgs(options), { stdio: ['pipe', 'pipe', 'pipe'] });
  const source = program.createSource('encoder');
  const feed = new WebmSinkFeed(child.stdin, (err) => {
    console.warn(`ffmpeg encoder input closed: ${err.message}`);
  }, {
    maxBufferedBytes: bytesForSeconds(RELAY_INPUT_BACKLOG_SECONDS, options),
    onOverflow: () => {
      console.warn(`Live encoder fell ${RELAY_INPUT_BACKLOG_SECONDS}s behind; skipping ahead to the live edge`);
      for (const relay of session.relays.values()) {
        if (relay.exited || relay.retired) continue;
        sendJson(session.client, {
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
  const encoder: EncoderProcess = { process: child, feed, source, exited: false };
  session.encoder = encoder;
  console.log(`Live encoder starting for ${session.destinations.length} destination(s)`);

  // On air at once for a new broadcast; after a restart, at its first keyframe.
  program.switchTo(source);
  child.stdout.on('data', (data: Buffer) => source.push(data));
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
    // The studio is away: the slate is on air, and a new encoder starts when it returns.
    if (session.clientGone) return;

    // The destinations and the watch page stay connected: the program
    // splices the replacement encoder in at its first keyframe.
    const canResume = session.webm.joinPoint() !== null;
    if (canResume && session.encoderRestartAttempts < MAX_ENCODER_RESTARTS) {
      session.encoderRestartAttempts += 1;
      const attempt = session.encoderRestartAttempts;
      console.warn(`Live encoder stopped (${message}); restarting ${attempt}/${MAX_ENCODER_RESTARTS}`);
      for (const destination of session.destinations) {
        sendJson(session.client, {
          type: 'destination-status',
          payload: {
            destinationId: destination.id,
            status: 'live',
            message: `Restarting the encoder (${attempt}/${MAX_ENCODER_RESTARTS})`,
          },
        });
      }
      session.encoderRestartTimer = setTimeout(() => {
        session.encoderRestartTimer = null;
        if (session.stopping || session.clientGone) return;
        spawnEncoder(session, ffmpegPath, session.payload ?? payload);
      }, ENCODER_RESTART_DELAY_MS);
      return;
    }

    for (const destination of session.destinations) {
      sendJson(session.client, {
        type: 'destination-status',
        payload: { destinationId: destination.id, status: 'error', message: `Live encoder stopped: ${message}` },
      });
    }
    stopSession(session, 'The live encoder stopped.');
  };

  child.on('error', (err) => onExit(err.message));
  child.on('close', (code, signal) => {
    onExit(signal ? `FFmpeg exited from ${signal}` : `FFmpeg exited with code ${code ?? 'unknown'}`);
  });
  return encoder;
}

async function spawnLiveBackup(
  session: RelaySession,
  ffmpegPath: string,
  claims: LiveStreamTokenClaims,
  payload: RtmpRelayStartPayload
) {
  if (!isLiveBackupRecordingEnabled()) {
    sendJson(session.client, {
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

    sendJson(session.client, {
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
      sendJson(session.client, {
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
              sendJson(session.client, {
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
        sendJson(session.client, {
          type: 'backup-recording-status',
          payload: toLiveBackupPublicStatus(recording),
        });
      }).catch((err) => {
        recording.status = 'error';
        recording.error = err instanceof Error ? err.message : 'Backup recording finalization failed';
        sendJson(session.client, {
          type: 'backup-recording-status',
          payload: toLiveBackupPublicStatus(recording),
        });
      });
    });
  } catch (err) {
    sendJson(session.client, {
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

const SLATE_IMAGE_PATH = fileURLToPath(new URL('../assets/reconnecting-slate.jpg', import.meta.url));

function createRelaySession(ws: WebSocket): RelaySession {
  return {
    client: ws,
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
    confirmedDestinations: new Set(),
    payload: null,
    program: null,
    slate: null,
    lastMediaAtMs: 0,
    clientGone: false,
    watchdog: null,
  };
}

/** The program fans out to every destination and the watch page. */
function createProgram(session: RelaySession): FlvProgram {
  return new FlvProgram((chunk) => {
    const hls = session.hls;
    if (hls && !hls.exited) hls.feed.write(chunk);
    for (const relay of session.relays.values()) {
      if (relay.exited || relay.retired || !relay.flvFeed) continue;
      if (!relay.flvFeed.write(chunk) || relay.live) continue;
      markRelayReceivingMedia(session, relay);
    }
  }, (source) => {
    // The studio's video is back on air.
    if (session.slate && source !== session.slate.source) {
      console.log('Studio video is back on air; slate off');
      stopSlate(session);
    }
  });
}

function startSlate(session: RelaySession): boolean {
  if (session.slate && !session.slate.exited) return true;
  const program = session.program;
  const payload = session.payload;
  const ffmpegPath = getFfmpegPath();
  if (!program || !payload || !ffmpegPath || session.stopping || !existsSync(SLATE_IMAGE_PATH)) return false;
  const options = { video: normalizeVideoConfig(payload.video), audio: normalizeAudioConfig(payload.audio) };
  const child = spawn(ffmpegPath, createFfmpegSlateArgs(options, SLATE_IMAGE_PATH), { stdio: ['ignore', 'pipe', 'pipe'] });
  const source = program.createSource('slate');
  const slate: SlateProcess = { process: child, source, startedAtMs: Date.now(), exited: false };
  session.slate = slate;
  console.warn('Studio video stopped; the destinations see the reconnecting slate');
  child.stdout.on('data', (data: Buffer) => source.push(data));
  child.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim();
    if (line) console.warn(`ffmpeg slate: ${line}`);
  });
  const onExit = () => {
    if (slate.exited) return;
    slate.exited = true;
    if (session.slate !== slate) return;
    session.slate = null;
    // Nothing else can keep the destinations going while the studio is away.
    if (session.clientGone) stopSession(session, 'The reconnecting slate stopped.');
  };
  child.on('error', onExit);
  child.on('close', onExit);
  program.switchTo(source);
  return true;
}

function stopSlate(session: RelaySession) {
  const slate = session.slate;
  if (!slate) return;
  session.slate = null;
  if (!slate.exited) slate.process.kill('SIGTERM');
}

/** Checked every second: slate on when the studio goes quiet, and the hold's time limit. */
function checkStudioInput(session: RelaySession) {
  if (!session.started || session.stopping || !session.program) return;
  const now = Date.now();
  const slate = session.slate;
  if (slate && now - slate.startedAtMs >= STUDIO_RECONNECT_HOLD_MS) {
    stopSession(session, 'The studio did not reconnect.');
    return;
  }
  if (shouldShowSlate({
    lastMediaAtMs: session.lastMediaAtMs,
    nowMs: now,
    hasLiveDestination: session.confirmedDestinations.size > 0,
    slateOnAir: Boolean(slate),
  })) {
    startSlate(session);
  }
}

/** The studio's connection closed mid-broadcast: keep the destinations on the slate. */
function holdSession(session: RelaySession): boolean {
  if (!session.started || session.stopping || !session.program) return false;
  if (session.confirmedDestinations.size === 0) {
    console.log('Studio disconnected before any destination went live; nothing to hold');
    return false;
  }
  if (!startSlate(session)) return false;
  session.clientGone = true;
  // The returning studio sends a new WebM stream; this backup file ends here.
  stopBackupProcess(session);
  console.warn(`Studio disconnected from a live broadcast; holding for ${Math.round(STUDIO_RECONNECT_HOLD_MS / 1000)} s`);
  return true;
}

function findResumableSession(current: RelaySession, roomId: string, payload: RtmpRelayStartPayload): RelaySession | null {
  for (const candidate of sessions.values()) {
    if (candidate === current || !candidate.started || candidate.stopping) continue;
    if (!candidate.program || !candidate.payload || candidate.claims?.roomId !== roomId) continue;
    if (isSameRelaySetup(candidate.payload, payload)) return candidate;
  }
  return null;
}

/** The studio reconnected: continue its broadcast on the new connection. */
async function resumeSession(
  ws: WebSocket,
  held: RelaySession,
  claims: LiveStreamTokenClaims,
  payload: RtmpRelayStartPayload,
  ffmpegPath: string,
  onResume: (session: RelaySession) => void
) {
  const previous = held.client;
  if (sessions.get(previous) === held) sessions.delete(previous);
  sessions.set(ws, held);
  held.client = ws;
  held.claims = claims;
  held.payload = payload;
  held.clientGone = false;
  held.lastMediaAtMs = Date.now();
  held.webm = new WebmStreamTracker();
  held.encoderRestartAttempts = 0;
  if (held.encoderRestartTimer) {
    clearTimeout(held.encoderRestartTimer);
    held.encoderRestartTimer = null;
  }
  onResume(held);
  // A connection that died without closing is replaced; its close is ignored.
  if (previous !== ws && previous.readyState === WebSocket.OPEN) previous.terminate();
  console.log(`Studio reconnected to its live broadcast in room ${claims.roomId}`);

  // The new encoder goes on air at its first keyframe; until then the slate
  // (or the last studio video) stays on.
  const old = held.encoder;
  spawnEncoder(held, ffmpegPath, payload);
  if (old && !old.exited) endProcess(old.process, () => old.exited);

  if (held.backup && !held.backup.exited && held.backup.recording.status !== 'finalizing') stopBackupProcess(held);
  await spawnLiveBackup(held, ffmpegPath, claims, payload);
  if (held.stopping) return;

  sendJson(ws, {
    type: 'session-started',
    payload: {
      roomId: claims.roomId,
      destinationIds: payload.destinations.map((destination) => destination.id),
    },
  });
  for (const relay of held.relays.values()) {
    const id = relay.destination.id;
    const failed = relay.exited && !held.restartTimers.has(id);
    sendJson(ws, {
      type: 'destination-status',
      payload: {
        destinationId: id,
        status: failed ? 'error' : relay.live && !relay.exited && held.confirmedDestinations.has(id) ? 'live' : 'connecting',
        ...(failed ? { message: `Lost the connection to ${relay.destination.name}.` } : {}),
      },
    });
  }
}

async function handleStart(
  ws: WebSocket,
  session: RelaySession,
  payload: RtmpRelayStartPayload,
  onResume: (session: RelaySession) => void = () => {}
) {
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

  if (isEncodeOnceEnabled()) {
    const held = findResumableSession(session, claims.roomId, payload);
    if (held) {
      await resumeSession(ws, held, claims, payload, ffmpegPath, onResume);
      return;
    }
  }

  session.started = true;
  session.claims = claims;
  session.destinations = payload.destinations;
  session.encodeOnce = isEncodeOnceEnabled();
  session.payload = payload;
  session.lastMediaAtMs = Date.now();
  if (session.encodeOnce) {
    session.program = createProgram(session);
    session.watchdog = setInterval(() => checkStudioInput(session), 1_000);
    session.watchdog.unref?.();
  }

  await spawnLiveBackup(session, ffmpegPath, claims, payload);
  if (session.stopping) return;

  if (session.encodeOnce) spawnEncoder(session, ffmpegPath, payload);

  for (const destination of payload.destinations) {
    spawnRelay(session, ffmpegPath, destination, payload);
  }
  if (session.encodeOnce) await spawnHlsWriter(session, ffmpegPath, payload);

  sendJson(session.client, {
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
  session.lastMediaAtMs = Date.now();
  if (session.encodeOnce) {
    // Destinations go live when the encoder's output reaches them.
    const encoder = session.encoder;
    if (encoder && !encoder.exited) encoder.feed.write(chunk, info);
    // Studio video after a stall on the same connection: back on air at the next keyframe.
    const program = session.program;
    if (session.slate && encoder && !encoder.exited && program) {
      program.switchTo(encoder.source);
      if (program.activeSource === encoder.source) stopSlate(session);
    }
  } else {
    for (const relay of session.relays.values()) {
      if (relay.exited || !relay.feed || !relay.feed.write(chunk, info) || relay.live) continue;
      markRelayReceivingMedia(session, relay);
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
  // Replaced by the running broadcast when this connection is a studio reconnecting.
  let session = createRelaySession(ws);
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
      void handleStart(ws, session, message.payload, (resumed) => {
        session = resumed;
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'Unable to start relay session';
        sendError(ws, 'START_FAILED', message);
        stopSession(session, message);
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
      stopSession(session, 'client requested stop');
      ws.close(1000, 'Relay stopped');
    }
  });

  ws.on('close', () => {
    // A reconnected studio took this broadcast over.
    if (session.client !== ws) {
      if (sessions.get(ws) === session) sessions.delete(ws);
      return;
    }
    if (holdSession(session)) return;
    if (session.started && !session.stopping) console.log('Studio disconnected; ending its relay session');
    stopSession(session, 'client disconnected');
    sessions.delete(ws);
  });

  // 'close' always follows and decides whether the broadcast is held.
  ws.on('error', (err) => {
    console.error('RTMP relay socket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Media server running on http://localhost:${PORT}`);
  console.log(`RTMP relay WebSocket on ws://localhost:${PORT}/rtmp`);
  console.log(`SFU signaling WebSocket on ws://localhost:${PORT}/sfu`);
  void sweepStaleHlsWriterDirs().then((count) => {
    if (count > 0) console.log(`Removed ${count} watch-page folder(s) left by an earlier run.`);
  });
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
