/**
 * The studio server sleeps when idle and restarts on every deploy. A single
 * long request fails in both cases: it can hang on a restarting instance until
 * it times out. Instead, wait until `/health` answers (quick when the server
 * is already up), then send the request, and retry it once if it is lost to a
 * restart.
 */

import { ApiRequestError, buildApiUrl, postJson, resolveMediaHttpUrl } from './apiClient.ts';

const HEALTH_REQUEST_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;
const DEFAULT_WAKE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const STUDIO_SERVER_UNAVAILABLE_MESSAGE =
  'The studio server is not responding. It may be restarting; please try again in a minute.';

interface WakeDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  healthUrl?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

async function isHealthy(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), HEALTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Resolve once the studio server answers its health check; throw if it never does. */
export async function waitForStudioServer(
  timeoutMs = DEFAULT_WAKE_TIMEOUT_MS,
  deps: WakeDependencies = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || defaultSleep;
  const url = deps.healthUrl || buildApiUrl('/health');
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await isHealthy(url, fetchImpl)) return;
    if (now() + HEALTH_POLL_INTERVAL_MS >= deadline) {
      throw new ApiRequestError(STUDIO_SERVER_UNAVAILABLE_MESSAGE, { timedOut: true });
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
}

/** A request that never got an answer: timed out, or the connection dropped. */
export function isLostRequest(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.timedOut || error.status === undefined || error.status >= 502);
}

/**
 * POST once the server is awake, retrying a single time if the request is lost
 * to a restart. A retried create can, rarely, make a second studio if the first
 * attempt did reach the server; that is better than failing the host.
 */
export async function postWhenStudioServerReady<T>(
  path: string,
  body: unknown,
  deps: WakeDependencies & { post?: typeof postJson; onWaiting?: () => void } = {}
): Promise<T> {
  const post = deps.post || postJson;
  await waitForStudioServer(DEFAULT_WAKE_TIMEOUT_MS, deps);
  try {
    return await post<T>(path, body, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    if (!isLostRequest(error)) throw error;
    deps.onWaiting?.();
    await waitForStudioServer(DEFAULT_WAKE_TIMEOUT_MS, deps);
    return post<T>(path, body, { timeoutMs: REQUEST_TIMEOUT_MS });
  }
}

const PREWARM_REFRESH_MS = 5 * 60_000;
let lastPrewarmAt = 0;

/**
 * Wake both servers in the background as soon as the app opens. Free hosting
 * puts them to sleep after 15 idle minutes and waking takes about 30 seconds;
 * starting now means that time passes while the host fills in the form
 * instead of after they press Create.
 */
export function prewarmStudioServers(
  deps: { fetchImpl?: typeof fetch; now?: () => number; urls?: string[] } = {}
): boolean {
  const now = (deps.now || Date.now)();
  if (now - lastPrewarmAt < PREWARM_REFRESH_MS) return false;
  lastPrewarmAt = now;
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return false;
  let urls = deps.urls;
  if (!urls) {
    urls = [buildApiUrl('/health')];
    try {
      const media = resolveMediaHttpUrl();
      if (media) urls.push(`${media.replace(/\/+$/, '')}/health`);
    } catch {
      // No media server configured; the studio server alone is enough to create studios.
    }
  }
  for (const url of urls) {
    void fetchImpl(url, { cache: 'no-store', keepalive: true }).catch(() => undefined);
  }
  return true;
}

/** Test hook: forget the last prewarm time. */
export function resetStudioServerPrewarm(): void {
  lastPrewarmAt = 0;
}
