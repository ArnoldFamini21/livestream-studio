import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { getPremiereStatus, PREMIERE_MAX_DURATION_MS, PREMIERE_MAX_UPLOAD_BYTES } from '@studio/shared';
import { getLiveStreamTokenSecret, verifyPremiereUploadToken, verifyWatchPlaybackToken } from './auth.js';
import {
  createObjectStorageJson, createObjectStoragePresignedGetUrl, deleteObjectStorageKey,
  getObjectStorageText, getRecordingObjectStorageConfig, uploadFileToObjectStorage, type ObjectStorageConfig,
} from './objectStorage.js';

const run = promisify(execFile);
const UPLOAD_TIMEOUT_MS = 4 * 60_000;
const RESERVED_DISK_BYTES = 1024 * 1024 * 1024;
const MAX_VIEWER_STREAMS = 12;

interface StoredPremiere {
  startsAt: number;
  durationMs: number;
  bytes: number;
  assetId: string;
}

function validInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function parseStoredPremiere(raw: string | null): StoredPremiere | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<StoredPremiere> | null;
  if (!value || !validInteger(value.startsAt) || !validInteger(value.durationMs, PREMIERE_MAX_DURATION_MS) ||
      !validInteger(value.bytes, PREMIERE_MAX_UPLOAD_BYTES) || !/^[a-f0-9-]{36}$/.test(value.assetId || '')) {
    throw new Error('Invalid premiere manifest');
  }
  return value as StoredPremiere;
}

export function parsePremiereMediaInfo(stderr: string): number {
  const input = stderr.split(/^Output #/m)[0];
  const duration = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(input);
  const video = /^\s*Stream #0:[^\n]*?Video: ([^, ]+)/m.exec(input)?.[1];
  const audio = /^\s*Stream #0:[^\n]*?Audio: ([^, ]+)/m.exec(input)?.[1];
  const durationMs = duration ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000) : 0;
  if (!validInteger(durationMs, PREMIERE_MAX_DURATION_MS) || video !== 'h264' || (audio && audio !== 'aac')) {
    throw new Error('Choose an H.264 MP4 with AAC audio and a duration of two hours or less.');
  }
  return durationMs;
}

function objectPrefix(config: ObjectStorageConfig, watchId: string): string {
  return [config.prefix, 'premieres', watchId].filter(Boolean).join('/');
}

function readPremiere(config: ObjectStorageConfig, base: string) {
  return getObjectStorageText(config, `${base}/manifest.json`).then(parseStoredPremiere);
}

function getStorage(): ObjectStorageConfig | null {
  const config = getRecordingObjectStorageConfig();
  // The existing recording bucket may expose objects via a public endpoint.
  // Enable this service only for a bucket where public access is disabled.
  if (process.env.PREMIERE_STORAGE_PRIVATE !== 'true' || !config || config.publicBaseUrl) return null;
  if (process.env.NODE_ENV === 'production' && !config.endpoint.startsWith('https://')) return null;
  return config;
}

interface PremiereHandlerOptions {
  applyCors(req: IncomingMessage, res: ServerResponse): boolean;
  writeJson(res: ServerResponse, status: number, body: unknown): void;
  getFfmpegPath(): string | null;
  clock?: () => number;
}

export function createPremiereHandler({ applyCors, writeJson, getFfmpegPath, clock = Date.now }: PremiereHandlerOptions) {
  let uploadBusy = false;
  let viewerStreams = 0;

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/premieres/')) return false;
    const match = /^\/premieres\/([A-Za-z0-9_-]{16})\/(status|video|upload)$/.exec(url.pathname);
    if (!match) { writeJson(res, 404, { error: 'Premiere not found.' }); return true; }
    const [, watchId, action] = match;
    if ((req.headers.origin || action !== 'video' || req.method === 'OPTIONS') && !applyCors(req, res)) {
      writeJson(res, 403, { error: 'Origin not allowed.' }); return true;
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return true; }
    if ((action === 'upload' && req.method !== 'POST') ||
        (action === 'status' && req.method !== 'GET') ||
        (action === 'video' && req.method !== 'GET' && req.method !== 'HEAD')) {
      writeJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const secret = getLiveStreamTokenSecret();
    if (!secret) { writeJson(res, 503, { error: 'Premieres are unavailable.' }); return true; }
    const now = clock();
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    const host = action !== 'video' ? verifyPremiereUploadToken(bearer, watchId, secret, now) : null;
    const viewer = action !== 'upload' && verifyWatchPlaybackToken(url.searchParams.get('watchToken'), watchId, secret, now);
    if (!host && !viewer) { writeJson(res, 401, { error: 'Premiere access is required.' }); return true; }
    const config = getStorage();
    if (!config) { writeJson(res, 503, { error: 'Private durable storage is required for premieres.' }); return true; }
    const base = objectPrefix(config, watchId);

    try {
      const record = await readPremiere(config, base);
      const status = getPremiereStatus(record, clock());
      if (action === 'status') { writeJson(res, 200, status); return true; }

      if (action === 'video') {
        if (!record || status.phase !== 'playing') { writeJson(res, 404, { error: 'The premiere is outside its scheduled playback window.' }); return true; }
        res.setHeader('Accept-Ranges', 'bytes');
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Length': record.bytes, 'Content-Type': 'video/mp4' }).end();
          return true;
        }
        const range = req.headers.range;
        if (range && !/^bytes=(?:[0-9]{1,12}-[0-9]{0,12}|-[0-9]{1,12})$/.test(range)) {
          res.writeHead(416, { 'Content-Range': `bytes */${record.bytes}` }).end();
          return true;
        }
        if (viewerStreams >= MAX_VIEWER_STREAMS) {
          writeJson(res, 503, { error: 'The premiere has reached its streaming capacity. Try again shortly.' });
          return true;
        }
        const storageUrl = createObjectStoragePresignedGetUrl(config, { key: `${base}/${record.assetId}.mp4`, expiresInSeconds: 60 });
        const abort = new AbortController();
        const cancel = () => abort.abort();
        const headerDeadline = setTimeout(cancel, 20_000);
        viewerStreams++;
        res.setTimeout(35_000, cancel);
        res.once('close', cancel);
        try {
          const upstream = await fetch(storageUrl, { redirect: 'error', signal: abort.signal, headers: range ? { Range: range } : {} });
          clearTimeout(headerDeadline);
          if (!upstream.body || ![200, 206, 416].includes(upstream.status)) {
            await upstream.body?.cancel();
            throw new Error('Premiere storage response was incomplete');
          }
          for (const header of ['Content-Length', 'Content-Range']) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
          }
          res.writeHead(upstream.status, { 'Content-Type': 'video/mp4' });
          await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
        } finally {
          viewerStreams--;
          clearTimeout(headerDeadline);
          res.off('close', cancel);
        }
        return true;
      }

      if (!host || host.startsAt <= clock() || record) { writeJson(res, 409, { error: 'This premiere already has a video or its start time has passed.' }); return true; }
      if (uploadBusy) { writeJson(res, 429, { error: 'Another premiere is uploading. Try again shortly.' }); return true; }
      const bytes = Number(req.headers['content-length']);
      if (!validInteger(bytes, PREMIERE_MAX_UPLOAD_BYTES) || req.headers['content-type'] !== 'video/mp4' || req.headers['content-encoding']) {
        writeJson(res, 415, { error: 'Choose an MP4 file of up to 256 MB.' });
        return true;
      }
      const ffmpeg = getFfmpegPath();
      if (!ffmpeg) { writeJson(res, 503, { error: 'Video verification is unavailable.' }); return true; }
      uploadBusy = true;
      let directory: string | undefined;
      try {
        const disk = await statfs(tmpdir());
        if (disk.bavail * disk.bsize < RESERVED_DISK_BYTES + bytes) {
          writeJson(res, 503, { error: 'The upload service is low on temporary space.' });
          return true;
        }
        directory = await mkdtemp(join(tmpdir(), 'studio-premiere-'));
        const filePath = join(directory, 'premiere.mp4');
        await pipeline(req, createWriteStream(filePath), { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
        if ((await stat(filePath)).size !== bytes) throw new Error('Premiere upload was incomplete');
        let durationMs: number;
        try {
          const { stderr } = await run(ffmpeg, [
            '-nostdin', '-hide_banner', '-v', 'info', '-threads', '1', '-f', 'mov', '-protocol_whitelist', 'file',
            '-i', filePath, '-map', '0:v:0', '-an', '-t', '0.1', '-f', 'null', '-',
          ], { timeout: 15_000, maxBuffer: 64 * 1024 });
          durationMs = parsePremiereMediaInfo(stderr);
        } catch {
          writeJson(res, 422, { error: 'Choose a playable H.264 MP4 with AAC audio and a duration of two hours or less.' });
          return true;
        }
        const assetId = randomUUID();
        const key = `${base}/${assetId}.mp4`;
        const stored = { assetId, startsAt: host.startsAt, durationMs, bytes };
        await uploadFileToObjectStorage(config, { filePath, key, contentType: 'video/mp4' });
        let scheduled: boolean;
        try {
          scheduled = host.startsAt > clock() && await createObjectStorageJson(config, `${base}/manifest.json`, stored);
        } catch (err) {
          // A storage timeout can occur after the commit has landed.
          const confirmed = await readPremiere(config, base).catch(() => undefined);
          if (confirmed?.assetId === assetId) scheduled = true;
          else {
            if (confirmed) await deleteObjectStorageKey(config, key).catch(() => undefined);
            throw err;
          }
        }
        if (!scheduled) {
          await deleteObjectStorageKey(config, key).catch(() => undefined);
          writeJson(res, 409, { error: 'This premiere already has a video or its start time has passed.' });
          return true;
        }
        writeJson(res, 201, getPremiereStatus(stored, clock()));
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        uploadBusy = false;
      }
    } catch {
      if (res.destroyed) return true;
      if (res.headersSent) res.destroy();
      else writeJson(res, 502, { error: 'Premiere storage could not be reached. Try again.' });
    }
    return true;
  };
}
