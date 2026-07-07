import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { buildServiceHealthPayload } from '@studio/shared';
import {
  configureRoomSnapshotStore,
  restoreRoomSnapshots,
  setupSignalingServer,
} from './services/signaling.js';
import { authRouter, configureAccountAuthStore } from './routes/auth.js';
import { roomRouter } from './routes/rooms.js';
import { configureRecordingCatalogStore, recordingRouter } from './routes/recordings.js';
import { brandKitRouter, configureBrandKitCatalogStore } from './routes/brandKits.js';
import { configureWorkspaceStudioCatalogStore, workspaceStudioRouter } from './routes/workspaceStudios.js';
import { configureWorkspaceTeamCatalogStore, workspaceTeamRouter } from './routes/workspaceTeam.js';
import { transcriptionRouter } from './routes/transcriptions.js';
import { highlightRouter } from './routes/highlights.js';
import { episodeContentRouter } from './routes/episodeContent.js';
import { buildIceConfigStatusFromEnv, buildIceConfigWithStatusFromEnv } from './services/ice-config.js';
import { buildSignalingPrometheusMetrics } from './services/metrics.js';
import { createAccountAuthStoreFromEnv } from './services/accountAuth.js';
import { createRoomSnapshotStoreFromEnv } from './services/roomPersistence.js';
import { createRecordingCatalogStoreFromEnv } from './services/recordingCatalog.js';
import { createBrandKitCatalogStoreFromEnv } from './services/brandKitCatalog.js';
import { createWorkspaceStudioCatalogStoreFromEnv } from './services/workspaceStudioCatalog.js';
import { createWorkspaceTeamCatalogStoreFromEnv } from './services/workspaceTeamCatalog.js';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const healthPayload = () => ({
  ...buildServiceHealthPayload('signaling-server', process.env),
  ice: buildIceConfigStatusFromEnv(process.env),
});

// Allowed origins for CORS (HTTP) and WebSocket origin checking.
// CLIENT_URL and CLIENT_URLS accept one URL or a comma-separated list.
const allowedOrigins = new Set<string>([
  'https://studio.arnoldfamini.com',
  'http://localhost:5173',
]);

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function addAllowedOrigins(value?: string) {
  if (!value) return;
  for (const item of value.split(',')) {
    const origin = normalizeOrigin(item.trim());
    if (origin) allowedOrigins.add(origin);
  }
}

addAllowedOrigins(process.env.CLIENT_URL);
addAllowedOrigins(process.env.CLIENT_URLS);

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && allowedOrigins.has(normalized));
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server, curl, health checks)
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '256kb' }));

// Security headers (CSP, X-Frame-Options, etc.).
// Note: the SPA is served from a separate static host (Hostinger), so this CSP
// primarily protects the API surface. The SPA itself should set CSP via meta or
// host configuration. We still emit a hardened policy as defense in depth:
// no 'unsafe-inline' for scripts; allow only the third parties the client actually uses.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // jsdelivr is allow-listed so MediaPipe's selfie_segmentation WASM/binarypb can load
  // for the virtual background feature.
  "script-src 'self' https://accounts.google.com https://apis.google.com https://cdn.jsdelivr.net",
  // Inline styles are required for React inline style={...} usage; not a meaningful XSS vector.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Google APIs for OAuth + Drive uploads; jsdelivr/storage.googleapis.com for MediaPipe assets;
  // ws/wss for our own signaling.
  "connect-src 'self' wss: ws: https://accounts.google.com https://www.googleapis.com https://oauth2.googleapis.com https://cdn.jsdelivr.net https://storage.googleapis.com",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Health check endpoint (before rate limiter to avoid false downtime)
app.get('/health', (_req, res) => res.json(healthPayload()));
app.get('/metrics', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(buildSignalingPrometheusMetrics());
});

// Simple in-memory rate limiter for REST endpoints.
// Bounded map size so an attacker spreading requests across many IPs cannot exhaust memory.
const RATE_LIMIT_MAP_MAX = 50_000;
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute per IP (general)
const ROOM_CREATE_LIMIT_MAX = 10; // 10 room-create attempts per minute per IP
const TRANSCRIPTION_LIMIT_MAX = 5; // 5 audio transcription attempts per minute per IP

interface RateEntry {
  count: number;
  resetAt: number;
}

function makeRateLimiter(maxPerWindow: number) {
  const buckets = new Map<string, RateEntry>();

  function set(ip: string, entry: RateEntry) {
    // Bound the map: drop the oldest entry once we hit the ceiling.
    if (buckets.size >= RATE_LIMIT_MAP_MAX && !buckets.has(ip)) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    buckets.set(ip, entry);
  }

  return {
    middleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const entry = buckets.get(ip);

      if (!entry || now > entry.resetAt) {
        set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        next();
        return;
      }

      entry.count++;
      if (entry.count > maxPerWindow) {
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
      }
      next();
    },
    sweep() {
      const now = Date.now();
      for (const [ip, e] of buckets) {
        if (now > e.resetAt) buckets.delete(ip);
      }
    },
  };
}

const generalLimiter = makeRateLimiter(RATE_LIMIT_MAX);
const roomCreateLimiter = makeRateLimiter(ROOM_CREATE_LIMIT_MAX);
const transcriptionLimiter = makeRateLimiter(TRANSCRIPTION_LIMIT_MAX);

app.use(generalLimiter.middleware);

// Clean up rate-limit entries every 5 minutes
const rateLimitSweepTimer = setInterval(() => {
  generalLimiter.sweep();
  roomCreateLimiter.sweep();
  transcriptionLimiter.sweep();
}, 5 * 60_000);

// REST API routes — room creation gets its own tighter cap.
app.use('/api/auth', authRouter);

app.use('/api/rooms', (req, res, next) => {
  if (req.method === 'POST') {
    roomCreateLimiter.middleware(req, res, next);
    return;
  }
  next();
}, roomRouter);

app.use('/api/recordings', recordingRouter);
app.use('/api/brand-kits', brandKitRouter);
app.use('/api/workspace-studios', workspaceStudioRouter);
app.use('/api/workspace-team', workspaceTeamRouter);

app.use(
  '/api/transcriptions',
  transcriptionLimiter.middleware,
  express.raw({
    type: ['audio/*', 'video/mp4', 'video/webm', 'application/octet-stream'],
    limit: '25mb',
  }),
  transcriptionRouter
);

app.use('/api/highlights', transcriptionLimiter.middleware, highlightRouter);
app.use('/api/episode-content', transcriptionLimiter.middleware, episodeContentRouter);

app.get('/api/health', (_req, res) => {
  res.json({
    ...healthPayload(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/ice-config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildIceConfigWithStatusFromEnv());
});

// Error-handling middleware (must be last in the middleware chain)
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Audio track is too large for transcription. Use a track under 25 MB.' });
    return;
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server and attach WebSocket
const server = http.createServer(app);

// Fix #4: Add maxPayload to limit incoming WebSocket message size to 64KB
// verifyClient checks the Origin header on WebSocket upgrade requests for CORS
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 64 * 1024,
  verifyClient: (info, done) => {
    const headerOrigin = info.req.headers.origin;
    const origin = info.origin || (Array.isArray(headerOrigin) ? headerOrigin[0] : headerOrigin);
    if (isAllowedOrigin(origin)) {
      done(true);
    } else {
      console.warn(`WebSocket connection rejected from origin: ${origin}`);
      done(false, 403, 'Forbidden: origin not allowed');
    }
  },
});

setupSignalingServer(wss);

const accountAuthStore = createAccountAuthStoreFromEnv(process.env);
const roomSnapshotStore = createRoomSnapshotStoreFromEnv(process.env);
const recordingCatalogStore = createRecordingCatalogStoreFromEnv(process.env);
const brandKitCatalogStore = createBrandKitCatalogStoreFromEnv(process.env);
const workspaceStudioCatalogStore = createWorkspaceStudioCatalogStoreFromEnv(process.env);
const workspaceTeamCatalogStore = createWorkspaceTeamCatalogStoreFromEnv(process.env);

async function initializeRoomPersistence() {
  if (!roomSnapshotStore) {
    console.log('Room snapshot persistence disabled; no PostgreSQL URL configured.');
    return;
  }

  try {
    await roomSnapshotStore.init();
    const snapshots = await roomSnapshotStore.loadRoomSnapshots();
    const restored = restoreRoomSnapshots(snapshots);
    configureRoomSnapshotStore(roomSnapshotStore);
    console.log(`Room snapshot persistence enabled; restored ${restored} room(s).`);
  } catch (err) {
    configureRoomSnapshotStore(null);
    console.warn(
      'Room snapshot persistence disabled:',
      err instanceof Error ? err.message : err
    );
  }
}

async function initializeAccountAuthPersistence() {
  if (!accountAuthStore) {
    configureAccountAuthStore(null);
    console.log('Account auth persistence disabled; using in-memory accounts.');
    return;
  }

  try {
    await accountAuthStore.init();
    configureAccountAuthStore(accountAuthStore);
    console.log('Account auth persistence enabled.');
  } catch (err) {
    configureAccountAuthStore(null);
    console.warn(
      'Account auth persistence disabled:',
      err instanceof Error ? err.message : err
    );
  }
}

async function initializeRecordingCatalogPersistence() {
  if (!recordingCatalogStore) {
    configureRecordingCatalogStore(null);
    console.log('Recording catalog persistence disabled; using in-memory catalog.');
    return;
  }

  try {
    await recordingCatalogStore.init();
    configureRecordingCatalogStore(recordingCatalogStore);
    console.log('Recording catalog persistence enabled.');
  } catch (err) {
    configureRecordingCatalogStore(null);
    console.warn(
      'Recording catalog persistence disabled:',
      err instanceof Error ? err.message : err
    );
  }
}

async function initializeBrandKitCatalogPersistence() {
  if (!brandKitCatalogStore) {
    configureBrandKitCatalogStore(null);
    console.log('Brand kit catalog persistence disabled; using in-memory catalog.');
    return;
  }

  try {
    await brandKitCatalogStore.init();
    configureBrandKitCatalogStore(brandKitCatalogStore);
    console.log('Brand kit catalog persistence enabled.');
  } catch (err) {
    configureBrandKitCatalogStore(null);
    console.warn(
      'Brand kit catalog persistence disabled:',
      err instanceof Error ? err.message : err
    );
  }
}

async function initializeWorkspaceStudioCatalogPersistence() {
  if (!workspaceStudioCatalogStore) {
    configureWorkspaceStudioCatalogStore(null);
    console.log('Workspace studio catalog persistence disabled; using in-memory catalog.');
    return;
  }

  try {
    await workspaceStudioCatalogStore.init();
    configureWorkspaceStudioCatalogStore(workspaceStudioCatalogStore);
    console.log('Workspace studio catalog persistence enabled.');
  } catch (err) {
    configureWorkspaceStudioCatalogStore(null);
    console.warn(
      'Workspace studio catalog persistence disabled:',
      err instanceof Error ? err.message : err
    );
  }
}

async function initializeWorkspaceTeamCatalogPersistence() {
  if (!workspaceTeamCatalogStore) {
    configureWorkspaceTeamCatalogStore(null);
    console.log('Workspace team catalog persistence disabled; using in-memory catalog.');
    return;
  }

  try {
    await workspaceTeamCatalogStore.init();
    configureWorkspaceTeamCatalogStore(workspaceTeamCatalogStore);
    console.log('Workspace team catalog persistence enabled.');
  } catch (err) {
    configureWorkspaceTeamCatalogStore(null);
    console.warn(
      'Workspace team catalog persistence disabled:',
      err instanceof Error ? err.message : err
    );
  }
}

await initializeAccountAuthPersistence();
await initializeRoomPersistence();
await initializeRecordingCatalogPersistence();
await initializeBrandKitCatalogPersistence();
await initializeWorkspaceStudioCatalogPersistence();
await initializeWorkspaceTeamCatalogPersistence();

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket signaling on ws://localhost:${PORT}/ws`);
});

// Graceful shutdown on SIGTERM and SIGINT
function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  clearInterval(rateLimitSweepTimer);

  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  // Close the WebSocket server (stops accepting new connections)
  wss.close(() => {
    console.log('WebSocket server closed.');

    // Close the HTTP server (stops accepting new requests, waits for in-flight)
    server.close(async () => {
      console.log('HTTP server closed.');
      await roomSnapshotStore?.close().catch((err) => {
        console.error('Room snapshot store close failed:', err instanceof Error ? err.message : err);
      });
      await accountAuthStore?.close().catch((err) => {
        console.error('Account auth store close failed:', err instanceof Error ? err.message : err);
      });
      await recordingCatalogStore?.close().catch((err) => {
        console.error('Recording catalog store close failed:', err instanceof Error ? err.message : err);
      });
      await brandKitCatalogStore?.close().catch((err) => {
        console.error('Brand kit catalog store close failed:', err instanceof Error ? err.message : err);
      });
      await workspaceStudioCatalogStore?.close().catch((err) => {
        console.error('Workspace studio catalog store close failed:', err instanceof Error ? err.message : err);
      });
      await workspaceTeamCatalogStore?.close().catch((err) => {
        console.error('Workspace team catalog store close failed:', err instanceof Error ? err.message : err);
      });
      process.exit(0);
    });
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
