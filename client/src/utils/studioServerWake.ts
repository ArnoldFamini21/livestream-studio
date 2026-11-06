/**
 * The studio server sleeps when idle and restarts on every deploy. A single
 * long request fails in both cases: it can hang on a restarting instance until
 * it times out. Instead, wait until `/health` answers (quick when the server
 * is already up), then send the request, and retry it once if it is lost to a
 * restart.
 */

import { ApiRequestError, buildApiUrl, getJson, postJson, resolveMediaHttpUrl } from './apiClient.ts';

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
  /** Stop waiting (for example when the page that asked is closed). */
  signal?: AbortSignal;
  /** Called before each health poll with the time spent waiting so far. */
  onProgress?: (elapsedMs: number) => void;
}

function abortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('The wait was cancelled.', 'AbortError')
    : Object.assign(new Error('The wait was cancelled.'), { name: 'AbortError' });
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
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    if (deps.signal?.aborted) throw abortError();
    deps.onProgress?.(now() - startedAt);
    if (await isHealthy(url, fetchImpl)) return;
    if (deps.signal?.aborted) throw abortError();
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

/** How long a guest's join page waits for a sleeping studio server before offering a manual retry. */
export const STUDIO_LOOKUP_WAKE_TIMEOUT_MS = 90_000;
const FIRST_LOOKUP_TIMEOUT_MS = 12_000;

export type StudioLookupFailure = 'not-found' | 'unreachable' | 'error';

/**
 * Only a real 404 means the studio does not exist. A timeout, a dropped
 * connection or a 502/503 is the free host waking up (or restarting).
 */
export function classifyStudioLookupError(error: unknown): StudioLookupFailure {
  if (error instanceof ApiRequestError && error.status === 404) return 'not-found';
  if (isLostRequest(error)) return 'unreachable';
  return 'error';
}

/**
 * GET with a quick first attempt; if that is lost to a sleeping or restarting
 * server, tell the caller (`onWaking`), wait for `/health` and try once more.
 * A 404 or any other real answer is returned (or thrown) at once.
 */
export async function getWhenStudioServerReady<T>(
  path: string,
  deps: WakeDependencies & {
    get?: typeof getJson;
    onWaking?: () => void;
    wakeTimeoutMs?: number;
    firstAttemptTimeoutMs?: number;
  } = {}
): Promise<T> {
  const get = deps.get || getJson;
  try {
    return await get<T>(path, { signal: deps.signal, timeoutMs: deps.firstAttemptTimeoutMs ?? FIRST_LOOKUP_TIMEOUT_MS });
  } catch (error) {
    if (!isLostRequest(error)) throw error;
  }
  deps.onWaking?.();
  await waitForStudioServer(deps.wakeTimeoutMs ?? STUDIO_LOOKUP_WAKE_TIMEOUT_MS, deps);
  return get<T>(path, { signal: deps.signal, timeoutMs: REQUEST_TIMEOUT_MS });
}

/**
 * POST once the server is awake, retrying a single time if the request is lost
 * to a restart. A retried create can, rarely, make a second studio if the first
 * attempt did reach the server; that is better than failing the host.
 */
export async function postWhenStudioServerReady<T>(
  path: string,
  body: unknown,
  deps: WakeDependencies & { post?: typeof postJson; onWaiting?: () => void; requestInit?: RequestInit } = {}
): Promise<T> {
  const post = deps.post || postJson;
  const init = { ...deps.requestInit, timeoutMs: REQUEST_TIMEOUT_MS };
  await waitForStudioServer(DEFAULT_WAKE_TIMEOUT_MS, deps);
  try {
    return await post<T>(path, body, init);
  } catch (error) {
    if (!isLostRequest(error)) throw error;
    deps.onWaiting?.();
    await waitForStudioServer(DEFAULT_WAKE_TIMEOUT_MS, deps);
    return post<T>(path, body, init);
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
