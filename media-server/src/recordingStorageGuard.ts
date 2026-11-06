import path from 'node:path';
import { statfs } from 'node:fs/promises';

/**
 * Limits on what participants may upload to this media server's disk. The
 * free Render instance has a small ephemeral disk that HLS segments and the
 * live backup also use; filling it breaks the live show, so uploads stop
 * before free space falls under a reserve, all studios share one byte budget,
 * and each participant may only keep a few uploads open at once.
 */

const MB = 1024 * 1024;
export const DEFAULT_RECORDING_UPLOAD_MIN_FREE_BYTES = 1024 * MB;
export const DEFAULT_RECORDING_UPLOAD_TOTAL_MAX_BYTES = 16 * 1024 * MB;
export const DEFAULT_RECORDING_UPLOADS_PER_PARTICIPANT = 4;

export interface RecordingUploadLimits {
  /** Uploads stop when the disk would have less than this free. */
  minFreeBytes: number;
  /** All upload sessions on this server together. */
  totalMaxBytes: number;
  /** Unfinished upload sessions one participant may hold per recording. */
  maxOpenSessionsPerParticipant: number;
  /** Ceiling for one upload session (also capped by the request's own maxBytes). */
  maxSessionBytes?: number;
  /** Free bytes on the disk holding `dir`, or null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

function megabytes(value: string | undefined, fallback: number, allowZero = false): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) return fallback;
  return Math.floor(parsed * MB);
}

export function getRecordingUploadLimits(env: NodeJS.ProcessEnv = process.env): RecordingUploadLimits {
  const perParticipant = Number(env.RECORDING_UPLOADS_PER_PARTICIPANT);
  const maxSessionBytes = megabytes(env.RECORDING_UPLOAD_MAX_MB, 0);
  return {
    minFreeBytes: megabytes(env.RECORDING_UPLOAD_MIN_FREE_MB, DEFAULT_RECORDING_UPLOAD_MIN_FREE_BYTES, true),
    totalMaxBytes: megabytes(env.RECORDING_UPLOAD_TOTAL_MAX_MB, DEFAULT_RECORDING_UPLOAD_TOTAL_MAX_BYTES),
    maxOpenSessionsPerParticipant: Number.isInteger(perParticipant) && perParticipant > 0
      ? perParticipant
      : DEFAULT_RECORDING_UPLOADS_PER_PARTICIPANT,
    ...(maxSessionBytes > 0 ? { maxSessionBytes } : {}),
  };
}

/** Free bytes available to this process on the filesystem that holds `dir` (or its nearest existing parent). */
export async function getFreeDiskBytes(dir: string): Promise<number | null> {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stats = await statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const parent = path.dirname(current);
      if (code !== 'ENOENT' || parent === current) return null;
      current = parent;
    }
  }
  return null;
}
