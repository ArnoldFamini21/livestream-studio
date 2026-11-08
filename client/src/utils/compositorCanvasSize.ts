import type { BroadcastOrientation } from '@studio/shared';

/**
 * The program canvas follows the output orientation: 1920x1080 for 16:9 and
 * 1080x1920 for 9:16. Every overlay draw helper lays itself out from the
 * canvas it draws into, never from fixed 1920/1080 constants.
 */

export interface CanvasSize {
  width: number;
  height: number;
}

export const LANDSCAPE_PROGRAM_SIZE: CanvasSize = { width: 1920, height: 1080 };
export const PORTRAIT_PROGRAM_SIZE: CanvasSize = { width: 1080, height: 1920 };

export function getProgramCanvasSize(orientation: BroadcastOrientation = 'landscape'): CanvasSize {
  return orientation === 'portrait' ? PORTRAIT_PROGRAM_SIZE : LANDSCAPE_PROGRAM_SIZE;
}

interface ContextWithCanvas {
  canvas?: { width?: number; height?: number } | null;
}

/** The size of the canvas (or OffscreenCanvas) a 2D context draws into; 1920x1080 when unknown. */
export function getContextCanvasSize(ctx: ContextWithCanvas): CanvasSize {
  const width = Number(ctx.canvas?.width);
  const height = Number(ctx.canvas?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
  return LANDSCAPE_PROGRAM_SIZE;
}

/** True for a canvas taller than it is wide. */
export function isPortraitCanvas(size: CanvasSize): boolean {
  return size.height > size.width;
}
