/** Intrinsic width/height of shared content, or null until the media reports it. */
export function getIntrinsicAspect(element: unknown): number | null {
  if (!element || typeof element !== 'object') return null;
  const media = element as Partial<{ naturalWidth: number; naturalHeight: number; videoWidth: number; videoHeight: number }>;
  const width = media.videoWidth || media.naturalWidth || 0;
  const height = media.videoHeight || media.naturalHeight || 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
}

/**
 * Ignore sub-percent changes (encoder rounding, 1px crops) so the stage does
 * not re-flow while a shared window is being resized by a few pixels.
 */
export function shouldUpdateContentAspect(current: number | null, next: number | null): boolean {
  if (next === null) return false;
  if (current === null) return true;
  return Math.abs(next / current - 1) >= 0.005;
}
