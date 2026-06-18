export function estimateDroppedFrames(
  frameRate: number,
  chunkDurationMs: number,
  droppedChunks = 1
): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return 0;
  if (!Number.isFinite(chunkDurationMs) || chunkDurationMs <= 0) return 0;
  if (!Number.isFinite(droppedChunks) || droppedChunks <= 0) return 0;

  return Math.max(1, Math.round(frameRate * (chunkDurationMs / 1000) * droppedChunks));
}
