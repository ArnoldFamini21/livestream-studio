/// <reference lib="webworker" />
// Ticks for the broadcast compositor. Timers in a dedicated worker keep
// running when the studio tab is hidden or covered; requestAnimationFrame
// stops there, which froze the live stream and recording.
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (event: MessageEvent<{ intervalMs?: number }>) => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  const intervalMs = event.data?.intervalMs;
  if (typeof intervalMs === 'number' && intervalMs > 0) {
    timer = setInterval(() => self.postMessage(0), intervalMs);
  }
};
