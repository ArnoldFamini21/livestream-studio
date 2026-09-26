/**
 * Calls `onFrame` at a steady rate that survives a hidden or covered tab.
 *
 * requestAnimationFrame follows the screen: Chrome stops it in background
 * tabs and slows it to about 1 fps in covered windows, so a broadcast drawn
 * on it froze whenever the host switched tabs. Timers in a dedicated worker
 * are not throttled that way. Without Worker support (tests, very old
 * browsers) a main-thread interval is used instead.
 */
export interface FrameTicker {
  stop(): void;
}

export function createFrameTicker(fps: number, onFrame: () => void): FrameTicker {
  const intervalMs = Math.max(1, Math.round(1000 / fps));
  let stopped = false;
  let lastFrameAt = 0;
  const tick = () => {
    if (stopped) return;
    // A slow frame queues worker messages; drop the backlog instead of
    // drawing several frames back to back.
    const now = performance.now();
    if (now - lastFrameAt < intervalMs * 0.5) return;
    lastFrameAt = now;
    onFrame();
  };

  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./frameTicker.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = tick;
      worker.postMessage({ intervalMs });
      return {
        stop() {
          stopped = true;
          worker.terminate();
        },
      };
    } catch {
      // Fall through to the main-thread timer.
    }
  }

  const timer = setInterval(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
