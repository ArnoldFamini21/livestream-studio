import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A public watch page plays the live program as HLS. The segments come from
 * the shared encode (FLV in, copy out), so the watch page costs no extra
 * encoding on the media server.
 */

export const HLS_SEGMENT_SECONDS = 2;
export const HLS_PLAYLIST_SEGMENTS = 6;
export const HLS_PLAYLIST_NAME = 'stream.m3u8';
/** Playlist requests from one viewer within this window count as one viewer. */
export const HLS_VIEWER_WINDOW_MS = 20_000;

const ROOM_ID_PATTERN = /^[\w-]{1,80}$/;
const SEGMENT_PATTERN = /^seg(?:-[\w-]{1,90}-)?\d{5,12}\.ts$/;

export function isValidWatchRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

/** Only the playlist and its numbered segments are served; nothing else in the folder. */
export function isServableHlsFile(name: string): boolean {
  return name === HLS_PLAYLIST_NAME || SEGMENT_PATTERN.test(name);
}

export function getHlsContentType(name: string): string {
  return name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
}

export function getHlsRootDir(env: Record<string, string | undefined> = process.env): string {
  return env.HLS_OUTPUT_DIR?.trim() || path.join(os.tmpdir(), 'livestream-studio-hls');
}

export function getHlsRoomDir(roomId: string, rootDir = getHlsRootDir()): string {
  return path.join(rootDir, roomId);
}

export async function prepareHlsRoomDir(roomId: string, rootDir = getHlsRootDir()): Promise<string> {
  if (!isValidWatchRoomId(roomId)) throw new Error('Invalid watch room id');
  await mkdir(rootDir, { recursive: true });
  // Each writer owns a separate folder. Delayed cleanup from a previous
  // broadcast must never remove segments belonging to its replacement.
  return mkdtemp(path.join(rootDir, `${roomId}-`));
}

export async function removeHlsWriterDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** A writer folder: `<room id>-` plus mkdtemp's six random characters. */
const WRITER_DIR_PATTERN = /^[\w-]{1,80}-[A-Za-z0-9]{6}$/;

/**
 * At startup nothing is live, so writer folders left by a crash (whose delayed
 * cleanup never ran) can go. Only folders named like a writer's and holding
 * nothing but HLS files are removed, so a misconfigured HLS_OUTPUT_DIR cannot
 * lose anything else.
 */
export async function sweepStaleHlsWriterDirs(rootDir = getHlsRootDir()): Promise<number> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !WRITER_DIR_PATTERN.test(entry.name)) continue;
    const dir = path.join(rootDir, entry.name);
    // Only a folder holding nothing but a playlist and segments is a writer's.
    const files = await readdir(dir).catch(() => null);
    if (!files || !files.every(isServableHlsFile)) continue;
    await removeHlsWriterDir(dir);
    removed++;
  }
  return removed;
}

/** FFmpeg: shared FLV on stdin, HLS segments in `dir`, no re-encode. */
export function createFfmpegHlsArgs(dir: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'flv',
    '-i', 'pipe:0',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_list_size', String(HLS_PLAYLIST_SEGMENTS),
    // Old segments are deleted; the playlist never gets an end marker while
    // live; each segment starts on a keyframe so players can join anywhere.
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(dir, `seg-${path.basename(dir)}-%05d.ts`),
    path.join(dir, HLS_PLAYLIST_NAME),
  ];
}

/** Distinct viewers seen recently, from playlist requests. */
export class HlsViewerCounter {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = HLS_VIEWER_WINDOW_MS) {}

  record(viewerKey: string, now = Date.now()): void {
    this.seen.set(viewerKey, now);
  }

  count(now = Date.now()): number {
    for (const [key, at] of this.seen) {
      if (now - at > this.windowMs) this.seen.delete(key);
    }
    return this.seen.size;
  }
}
