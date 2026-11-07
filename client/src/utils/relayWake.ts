/**
 * The media server on the free tier sleeps when idle and takes up to a minute
 * to wake. A single short probe made Go Live fail with "did not respond in
 * time"; instead keep probing (each probe also nudges the host awake) and tell
 * the host what is happening until it answers or the wait runs out.
 */

export const RELAY_WAKE_TIMEOUT_MS = 90_000;
export const RELAY_WAKE_PROBE_INTERVAL_MS = 3_000;

export interface RelayWakeOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each failed probe while still waiting. */
  onWaiting?: (elapsedMs: number, attempt: number) => void;
  /** Return false to stop early (a newer check started, or the page closed). */
  shouldContinue?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

export async function probeUntilAwake(probe: () => Promise<void>, options: RelayWakeOptions = {}): Promise<void> {
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const timeoutMs = options.timeoutMs ?? RELAY_WAKE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? RELAY_WAKE_PROBE_INTERVAL_MS;
  const startedAt = now();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await probe();
      return;
    } catch (error) {
      const elapsed = now() - startedAt;
      if (elapsed + intervalMs >= timeoutMs || options.shouldContinue?.() === false) throw error;
      options.onWaiting?.(elapsed, attempt);
    }
    await sleep(intervalMs);
    if (options.shouldContinue?.() === false) throw new Error('Media relay check was replaced by a newer one.');
  }
}

export function formatRelayWakeMessage(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return `Waking up the media server… free hosting can take up to a minute (${seconds}s).`;
}
