export const PREMIERE_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const PREMIERE_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export interface PremiereUploadClaims {
  v: 1;
  purpose: 'premiere-upload';
  watchId: string;
  startsAt: number;
  exp: number;
}

export interface PremiereStatus {
  phase: 'missing' | 'scheduled' | 'playing' | 'ended';
  startsAt?: number;
  durationMs?: number;
  serverTime: number;
}

export function getPremiereStatus(source: { startsAt: number; durationMs: number } | null, now: number): PremiereStatus {
  if (!source) return { phase: 'missing', serverTime: now };
  const { startsAt, durationMs } = source;
  const phase = now < startsAt ? 'scheduled' : now < startsAt + durationMs ? 'playing' : 'ended';
  return { phase, startsAt, durationMs, serverTime: now };
}
