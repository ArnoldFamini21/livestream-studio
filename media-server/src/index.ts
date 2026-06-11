import http from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import ffmpegStaticPath from 'ffmpeg-static';
import type {
  RtmpRelayClientMessage,
  RtmpRelayDestination,
  RtmpRelayServerMessage,
  RtmpRelayStartPayload,
  LiveStreamTokenClaims,
} from '@studio/shared';
import { getLiveStreamTokenSecret, verifyLiveStreamToken } from './auth.js';
import { buildAllowedOrigins, isAllowedOrigin } from './origins.js';
import {
  createFfmpegArgs,
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

interface RelayProcess {
  destination: RtmpRelayDestination;
  process: ChildProcessByStdio<Writable, null, Readable>;
  live: boolean;
  exited: boolean;
}

interface RelaySession {
  started: boolean;
  stopping: boolean;
  claims: LiveStreamTokenClaims | null;
  destinations: RtmpRelayDestination[];
  relays: Map<string, RelayProcess>;
  stopTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartTimers: Map<string, ReturnType<typeof setTimeout>>;
  restartAttempts: Map<string, number>;
}

const allowedOrigins = buildAllowedOrigins(process.env.CLIENT_URL, process.env.CLIENT_URLS);

function sendJson(ws: WebSocket, message: RtmpRelayServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, code: string, message: string, destinationId?: string) {
  sendJson(ws, { type: 'error', payload: { code, message, destinationId } });
}

function isStartPayload(payload: unknown): payload is RtmpRelayStartPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.token === 'string' &&
    Array.isArray(candidate.destinations) &&
    typeof candidate.video === 'object' &&
    candidate.video !== null &&
    typeof candidate.audio === 'object' &&
    candidate.audio !== null
  );
}

function parseControlMessage(data: RawData): RtmpRelayClientMessage | null {
  if (!Buffer.isBuffer(data)) return null;
  try {
    const parsed = JSON.parse(data.toString('utf8')) as RtmpRelayClientMessage;
    if (parsed?.type === 'stop') return { type: 'stop' };
    if (parsed?.type === 'start' && isStartPayload(parsed.payload)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function getFfmpegPath(): string | null {
  return process.env.FFMPEG_PATH || ffmpegStaticPath || null;
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

function stopSession(ws: WebSocket, session: RelaySession, reason?: string) {
  if (session.stopping) return;
  session.stopping = true;
  for (const timer of session.restartTimers.values()) {
    clearTimeout(timer);
  }
  session.restartTimers.clear();
  for (const relay of session.relays.values()) {
    stopRelayProcess(session, relay);
    sendJson(ws, {
      type: 'destination-status',
      payload: { destinationId: relay.destination.id, status: 'idle' },
    });
  }
  sendJson(ws, { type: 'session-stopped', payload: { reason } });
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
  });
}

function handleStart(ws: WebSocket, session: RelaySession, payload: RtmpRelayStartPayload) {
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
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'media-server' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
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
    stopTimers: new Map(),
    restartTimers: new Map(),
    restartAttempts: new Map(),
  };

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
      handleStart(ws, session, message.payload);
    } else {
      stopSession(ws, session, 'client requested stop');
      ws.close(1000, 'Relay stopped');
    }
  });

  ws.on('close', () => {
    stopSession(ws, session, 'client disconnected');
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
