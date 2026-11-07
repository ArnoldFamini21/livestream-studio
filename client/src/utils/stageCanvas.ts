import type { BroadcastOrientation } from '@studio/shared';

// Keep broadcast layout independent of the operator's window and open panels.
// Existing stage graphics are authored at this size; the compositor outputs 1080p.
export const STAGE_CANVAS_WIDTH = 960;
export const STAGE_CANVAS_HEIGHT = 540;

/**
 * The stage surface the compositor maps from: 960x540 for 16:9 output, and
 * 540x960 for 9:16 portrait output, so DOM rects map 1:1 onto 1080x1920.
 */
export function getStageCanvasSize(orientation: BroadcastOrientation = 'landscape'): { width: number; height: number } {
  return orientation === 'portrait'
    ? { width: STAGE_CANVAS_HEIGHT, height: STAGE_CANVAS_WIDTH }
    : { width: STAGE_CANVAS_WIDTH, height: STAGE_CANVAS_HEIGHT };
}

export function fitStageCanvas(availableWidth: number, availableHeight: number, orientation: BroadcastOrientation = 'landscape') {
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight) || availableWidth <= 0 || availableHeight <= 0) {
    return { width: 0, height: 0, scale: 0 };
  }
  const stage = getStageCanvasSize(orientation);
  const scale = Math.min(availableWidth / stage.width, availableHeight / stage.height);
  return { width: stage.width * scale, height: stage.height * scale, scale };
}
