import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { setupSignalingServer } from './services/signaling.js';
import { roomRouter } from './routes/rooms.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());

// REST API routes
app.use('/api/rooms', roomRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create HTTP server and attach WebSocket
const server = http.createServer(app);

// Fix #4: Add maxPayload to limit incoming WebSocket message size to 64KB
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

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
