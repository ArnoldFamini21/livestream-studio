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

/**
 * Decides which timer ticks draw a frame.
 *
 * Two gaps are required: half an interval since the previous frame *started*
 * (drops a backlog of queued ticks) and a quarter interval since it *ended*.
 * The second one matters on slow machines: with only the first, a frame slower
 * than half the interval let the next queued tick draw at once, frames ran back
 * to back and the page's main thread never idled, so signaling, recording
 * transfers and the UI starved. Frames up to ~3/4 of the interval still run at
 * the full rate; slower frames drop the rate instead of freezing the page.
 */
export function createFrameGate(intervalMs: number, onFrame: () => void, now: () => number = () => performance.now()): () => boolean {
  const minStartGapMs = intervalMs * 0.5;
  const minIdleMs = intervalMs * 0.25;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let lastEndedAt = Number.NEGATIVE_INFINITY;
  return () => {
    const startedAt = now();
    if (startedAt - lastStartedAt < minStartGapMs || startedAt - lastEndedAt < minIdleMs) return false;
    lastStartedAt = startedAt;
    try {
      onFrame();
    } finally {
      lastEndedAt = now();
    }
    return true;
  };
}

export function createFrameTicker(fps: number, onFrame: () => void): FrameTicker {
  const intervalMs = Math.max(1, Math.round(1000 / fps));
  let stopped = false;
  const gate = createFrameGate(intervalMs, onFrame);
  const tick = () => {
    if (stopped) return;
    // A slow frame queues worker messages; the gate drops that backlog.
    gate();
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
