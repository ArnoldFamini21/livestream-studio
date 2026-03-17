import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { setupSignalingServer } from './services/signaling.js';
import { roomRouter } from './routes/rooms.js';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Allowed origins for CORS (HTTP) and WebSocket origin checking
const allowedOrigins = [
  'https://studio.arnoldfamini.com',
  'http://localhost:5173',
];

// If CLIENT_URL env var is set and not already in the list, add it
if (process.env.CLIENT_URL && !allowedOrigins.includes(process.env.CLIENT_URL)) {
  allowedOrigins.push(process.env.CLIENT_URL);
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server, curl, health checks)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '16kb' }));

// Security headers (CSP, X-Frame-Options, etc.)
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' wss: ws:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Health check endpoint (before rate limiter to avoid false downtime)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Simple in-memory rate limiter for REST endpoints
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute per IP

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    next();
    return;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
    return;
  }
  next();
});

// Clean up rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

// REST API routes
app.use('/api/rooms', roomRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error-handling middleware (must be last in the middleware chain)
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
    const origin = info.origin || info.req.headers.origin;
    if (!origin || allowedOrigins.includes(origin)) {
      done(true);
    } else {
      console.warn(`WebSocket connection rejected from origin: ${origin}`);
      done(false, 403, 'Forbidden: origin not allowed');
    }
  },
});

setupSignalingServer(wss);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket signaling on ws://localhost:${PORT}/ws`);
});

// Fix #9: Graceful shutdown on SIGTERM and SIGINT
function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  // Close the WebSocket server (stops accepting new connections)
  wss.close(() => {
    console.log('WebSocket server closed.');

    // Close the HTTP server (stops accepting new requests, waits for in-flight)
    server.close(() => {
      console.log('HTTP server closed.');
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
