import { readFileSync } from 'node:fs';
import { PresentationRenderError } from './presentationRender.js';

/**
 * LibreOffice and pdftoppm run on the same small instance that carries the
 * live relay (the free Render plan has 512 MB for everything: Node, werift,
 * FFmpeg). A conversion that pushes the container over its limit restarts it
 * and drops the broadcast, so while a relay is live a render only starts when
 * enough memory is left. Otherwise it is deferred: the studio falls back to
 * rendering the deck in the browser.
 */

const MB = 1024 * 1024;
export const DEFAULT_MEMORY_LIMIT_BYTES = 512 * MB;
export const DEFAULT_LIVE_RENDER_HEADROOM_BYTES = 256 * MB;
export const DEFAULT_IDLE_RENDER_HEADROOM_BYTES = 160 * MB;

export interface MemorySnapshot {
  usedBytes: number;
  limitBytes: number;
}

function readNumber(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Reclaimable page cache in the cgroup (recording uploads and HLS segments fill it); not real pressure. */
function readInactiveFileBytes(): number {
  for (const [path, key] of [['/sys/fs/cgroup/memory.stat', 'inactive_file'], ['/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file']]) {
    try {
      const line = readFileSync(path, 'utf8').split('\n').find((entry) => entry.startsWith(`${key} `));
      const value = Number(line?.split(' ')[1]);
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* not in a cgroup with this file */
    }
  }
  return 0;
}

function envMegabytes(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * MB : fallback;
}

/**
 * Memory used by the whole container (FFmpeg children included) from cgroup
 * v2 or v1, falling back to this process's RSS. The limit comes from the
 * cgroup, MEDIA_SERVER_MEMORY_LIMIT_MB, or the free plan's 512 MB.
 */
export function readMemorySnapshot(env: NodeJS.ProcessEnv = process.env): MemorySnapshot {
  const cgroupUsed = readNumber('/sys/fs/cgroup/memory.current') ?? readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const cgroupLimit = readNumber('/sys/fs/cgroup/memory.max') ?? readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const configuredLimit = envMegabytes(env.MEDIA_SERVER_MEMORY_LIMIT_MB, 0);
  // cgroup v1 reports an "unlimited" limit as a huge number.
  const usableCgroupLimit = cgroupLimit && cgroupLimit < 1024 * 1024 * MB ? cgroupLimit : null;
  return {
    usedBytes: cgroupUsed !== null ? Math.max(0, cgroupUsed - readInactiveFileBytes()) : process.memoryUsage().rss,
    limitBytes: configuredLimit || usableCgroupLimit || DEFAULT_MEMORY_LIMIT_BYTES,
  };
}

export interface PresentationAdmissionInput {
  /** A live relay (RTMP and/or HLS) is running on this instance. */
  liveRelayActive: boolean;
  memory?: MemorySnapshot;
  env?: NodeJS.ProcessEnv;
}

/** Throws a 503 PRESENTATION_RENDER_DEFERRED when a render would risk the live show or the instance. */
export function checkPresentationRenderAdmission(input: PresentationAdmissionInput): void {
  const env = input.env || process.env;
  if (env.PRESENTATION_RENDER_MEMORY_GUARD === 'false') return;
  const memory = input.memory || readMemorySnapshot(env);
  const headroom = memory.limitBytes - memory.usedBytes;
  const required = input.liveRelayActive
    ? envMegabytes(env.PRESENTATION_RENDER_LIVE_HEADROOM_MB, DEFAULT_LIVE_RENDER_HEADROOM_BYTES)
    : envMegabytes(env.PRESENTATION_RENDER_IDLE_HEADROOM_MB, DEFAULT_IDLE_RENDER_HEADROOM_BYTES);
  if (headroom >= required) return;
  throw new PresentationRenderError(
    503,
    'PRESENTATION_RENDER_DEFERRED',
    input.liveRelayActive
      ? 'The media server is carrying the live broadcast and has too little memory left to render this deck. It will be prepared in the browser instead.'
      : 'The media server is low on memory right now. Try again in a moment.'
  );
}
