// Keep broadcast layout independent of the operator's window and open panels.
// Existing stage graphics are authored at this size; the compositor outputs 1080p.
export const STAGE_CANVAS_WIDTH = 960;
export const STAGE_CANVAS_HEIGHT = 540;

export function fitStageCanvas(availableWidth: number, availableHeight: number) {
  if (!Number.isFinite(availableWidth) || !Number.isFinite(availableHeight) || availableWidth <= 0 || availableHeight <= 0) {
    return { width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(availableWidth / STAGE_CANVAS_WIDTH, availableHeight / STAGE_CANVAS_HEIGHT);
  return { width: STAGE_CANVAS_WIDTH * scale, height: STAGE_CANVAS_HEIGHT * scale, scale };
}
