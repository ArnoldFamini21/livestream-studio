import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RECORDING_RECOVERY_CHUNK_BYTES, recordingRecoveryHostScope } from '@studio/shared';
import { getLiveStreamTokenSecret, verifyRecordingRecoveryToken } from './auth.js';
import { createRecoveryStorageResolver } from './recordingRecoveryStorage.js';
import { RecordingRecoveryError, RecoveryTake } from './recordingRecoveryTake.js';

const ROOT = '/recording-recovery';
const ID_SEGMENT = '([A-Za-z0-9_-]{1,120})';
const TAKE_PATH = new RegExp(`^${ROOT}/rooms/${ID_SEGMENT}/takes/${ID_SEGMENT}(.*)$`);
const DOWNLOAD_PATH = new RegExp(`^/participants/${ID_SEGMENT}/tracks/${ID_SEGMENT}$`);
const TRACK_ACTION = new RegExp(`^/upload/tracks/${ID_SEGMENT}/(chunks|complete)$`);
const MAX_BODY_READERS = 2;
const MAX_STREAMED_DOWNLOADS = 2;

interface RecoveryHandlerOptions {
  applyCors(req: IncomingMessage, res: ServerResponse): boolean;
  writeJson(res: ServerResponse, status: number, body: unknown): void;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
}

function bearer(req: IncomingMessage) {
  return /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
}

function offsetOrSequence(value: string | null) {
  return value && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (req.headers['content-encoding'] || Number(req.headers['content-length'] || 0) > limit) {
    throw new RecordingRecoveryError(413, 'Recording backup request is too large');
  }
  const buffers: Buffer[] = [];
  let count = 0;
  for await (const data of req.iterator({ destroyOnReturn: false })) {
    const block = Buffer.isBuffer(data) ? data : Buffer.from(data);
    count += block.byteLength;
    if (count > limit) throw new RecordingRecoveryError(413, 'Recording backup request is too large');
    buffers.push(block);
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const block of buffers) {
    bytes.set(block, offset);
    offset += block.length;
  }
  return bytes;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    throw new RecordingRecoveryError(415, 'Send a JSON recording backup request');
  }
  const body = await readBody(req, 16 * 1024);
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new RecordingRecoveryError(400, 'Invalid recording backup request'); }
}

function safeDownloadName(track: { label: string; mimeType: string }) {
  const kind = track.mimeType.split(';')[0].toLowerCase();
  const extension = kind === 'audio/mp4' ? 'm4a' : kind === 'audio/x-wav' ? 'wav' : kind.split('/')[1];
  const label = track.label.replace(/[^\w .-]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 100);
  return `${label || 'recording'}.${extension}`;
}

export function createRecordingRecoveryHandler({ applyCors, writeJson, env, clock = Date.now }: RecoveryHandlerOptions) {
  const resolveStorage = createRecoveryStorageResolver(env);
  let uploaders = 0;
  let downloads = 0;

  return async function handleRecordingRecovery(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith(`${ROOT}/`)) return false;
    const registration = url.pathname === `${ROOT}/takes` && req.method === 'POST';
    // Registration is an authenticated, server-to-server request and may have no browser Origin.
    if ((!registration || req.headers.origin) && !applyCors(req, res)) {
      writeJson(res, 403, { error: 'Origin not allowed' });
      return true;
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Host-Token');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }
    const secret = getLiveStreamTokenSecret();
    if (url.pathname === `${ROOT}/capability` && req.method === 'GET') {
      writeJson(res, 200, { ready: Boolean(secret && await resolveStorage()) });
      return true;
    }

    try {
      if (!secret) throw new RecordingRecoveryError(503, 'Private recording backup is unavailable');
      const now = clock();
      const grant = verifyRecordingRecoveryToken(bearer(req), secret, now);
      if (registration) {
        if (grant?.purpose !== 'recording-recovery-create') throw new RecordingRecoveryError(401, 'Recording backup authorization is required');
        const store = await resolveStorage();
        if (!store) throw new RecordingRecoveryError(503, 'Private recording backup is unavailable');
        const take = new RecoveryTake(store, grant.storageId);
        const manifest = await take.create(grant, await readJson(req), now);
        writeJson(res, 201, {
          expiresAt: new Date(manifest.expiresAtMs).toISOString(), participants: manifest.participants,
        });
        return true;
      }

      const path = TAKE_PATH.exec(url.pathname);
      if (!path) throw new RecordingRecoveryError(404, 'Recording backup was not found');
      const [, roomId, takeId, suffix] = path;
      if (suffix === '/upload' || suffix.startsWith('/upload/')) {
        if (grant?.purpose !== 'recording-recovery-upload' || grant.roomId !== roomId || grant.takeId !== takeId) {
          throw new RecordingRecoveryError(401, 'Recording upload authorization is required');
        }
        const store = await resolveStorage();
        if (!store) throw new RecordingRecoveryError(503, 'Private recording backup is unavailable');
        const take = new RecoveryTake(store, grant.storageId);
        const manifest = await take.read(roomId, takeId, now);
        const participant = manifest.participants.find(item => item.participantId === grant.participantId);
        if (!participant || manifest.expiresAtMs !== grant.exp) throw new RecordingRecoveryError(403, 'This guest cannot upload to the take');
        if (suffix === '/upload' && req.method === 'GET') {
          writeJson(res, 200, await take.uploadStatus(manifest, participant.participantId));
        } else if (suffix === '/upload/tracks' && req.method === 'POST') {
          writeJson(res, 200, await take.register(participant, await readJson(req)));
        } else {
          const trackAction = TRACK_ACTION.exec(suffix);
          if (!trackAction || req.method !== 'POST') throw new RecordingRecoveryError(404, 'Recording upload action was not found');
          const [, trackId, action] = trackAction;
          if (action === 'complete') {
            writeJson(res, 200, await take.complete(participant.participantId, trackId, await readJson(req)));
          } else {
            if (uploaders >= MAX_BODY_READERS) throw new RecordingRecoveryError(429, 'Recording backup is busy. Try again shortly.');
            uploaders++;
            try {
              const sequence = offsetOrSequence(url.searchParams.get('sequence'));
              const offset = offsetOrSequence(url.searchParams.get('offset'));
              const sha256 = url.searchParams.get('sha256') ?? '';
              const bytes = await readBody(req, RECORDING_RECOVERY_CHUNK_BYTES);
              const track = await take.append(participant.participantId, trackId, { offset, bytes: bytes.length, sha256 }, sequence, bytes);
              writeJson(res, 200, track);
            } finally { uploaders--; }
          }
        }
        return true;
      }

      const downloadPath = DOWNLOAD_PATH.exec(suffix);
      if (req.method !== 'GET' || (suffix !== '' && !downloadPath)) {
        throw new RecordingRecoveryError(404, 'Recording backup action was not found');
      }
      const host = req.headers['x-host-token'];
      if (typeof host !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(host)) {
        throw new RecordingRecoveryError(401, 'Private host access is required');
      }
      const store = await resolveStorage();
      if (!store) throw new RecordingRecoveryError(503, 'Private recording backup is unavailable');
      const storageId = createHmac('sha256', secret).update(recordingRecoveryHostScope(roomId, takeId, host)).digest('hex');
      const take = new RecoveryTake(store, storageId);
      const manifest = await take.read(roomId, takeId, now);
      if (!downloadPath) {
        writeJson(res, 200, await take.hostStatus(manifest));
      } else {
        const [, participantId, trackId] = downloadPath;
        if (!manifest.participants.some(participant => participant.participantId === participantId)) {
          throw new RecordingRecoveryError(404, 'Recording track was not found');
        }
        if (downloads >= MAX_STREAMED_DOWNLOADS) throw new RecordingRecoveryError(429, 'Recording downloads are busy. Try again shortly.');
        const abort = new AbortController();
        const close = () => abort.abort();
        res.once('close', close);
        downloads++;
        try {
          const track = await take.verifiedTrack(participantId, trackId);
          res.writeHead(200, {
            'Content-Type': track.mimeType, 'Content-Length': track.receivedBytes,
            'Content-Disposition': `attachment; filename="${safeDownloadName(track)}"`,
          });
          await pipeline(Readable.from(take.download(track, abort.signal)), res);
        } finally {
          res.off('close', close);
          downloads--;
        }
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else if (error instanceof RecordingRecoveryError) writeJson(res, error.status, { error: error.message });
      else writeJson(res, 502, { error: 'Private recording storage is temporarily unavailable. Try again.' });
    }
    return true;
  };
}
