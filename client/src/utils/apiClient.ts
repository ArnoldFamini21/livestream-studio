const PRODUCTION_API_URL = 'https://livestream-studio-server.onrender.com';
const PRODUCTION_WS_URL = 'wss://livestream-studio-server.onrender.com/ws';
const PRODUCTION_MEDIA_WS_URL = 'wss://livestream-studio-media-server.onrender.com/rtmp';
const DEFAULT_TIMEOUT_MS = 30_000;

interface ClientRuntimeEnv {
  VITE_API_URL?: string;
  VITE_WS_URL?: string;
  VITE_MEDIA_WS_URL?: string;
  PROD?: boolean;
}

interface BrowserLocationLike {
  protocol: string;
  host: string;
  hostname?: string;
}

interface ApiRequestErrorOptions {
  status?: number;
  timedOut?: boolean;
  responseText?: string;
  cause?: unknown;
}

export class ApiRequestError extends Error {
  readonly status?: number;
  readonly timedOut: boolean;
  readonly responseText?: string;

  constructor(message: string, options: ApiRequestErrorOptions = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.timedOut = Boolean(options.timedOut);
    this.responseText = options.responseText;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function getRuntimeEnv(): ClientRuntimeEnv {
  return (import.meta as unknown as { env?: ClientRuntimeEnv }).env || {};
}

function getBrowserLocation(): BrowserLocationLike | undefined {
  return typeof window === 'undefined' ? undefined : window.location;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function getConfiguredUrl(value: unknown): string {
  return typeof value === 'string' ? trimTrailingSlash(value) : '';
}

function getWebSocketProtocol(location: BrowserLocationLike): 'ws:' | 'wss:' {
  return location.protocol === 'https:' ? 'wss:' : 'ws:';
}

function isLocalhost(location: BrowserLocationLike): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(location.hostname || location.host);
}

export function resolveApiBaseUrl(env: ClientRuntimeEnv = getRuntimeEnv()): string {
  const configured = getConfiguredUrl(env.VITE_API_URL);
  if (configured) return configured;
  return env.PROD ? PRODUCTION_API_URL : '';
}

export function resolveWebSocketUrl(
  env: ClientRuntimeEnv = getRuntimeEnv(),
  location: BrowserLocationLike | undefined = getBrowserLocation()
): string {
  const configured = getConfiguredUrl(env.VITE_WS_URL);
  if (configured) return configured;
  if (env.PROD || !location) return PRODUCTION_WS_URL;
  return `${getWebSocketProtocol(location)}//${location.host}/ws`;
}

export function resolveMediaWsUrl(
  env: ClientRuntimeEnv = getRuntimeEnv(),
  location: BrowserLocationLike | undefined = getBrowserLocation()
): string {
  const configured = getConfiguredUrl(env.VITE_MEDIA_WS_URL);
  if (configured) return configured;
  if (env.PROD || !location) return PRODUCTION_MEDIA_WS_URL;
  if (isLocalhost(location)) return `${getWebSocketProtocol(location)}//localhost:3002/rtmp`;
  return `${getWebSocketProtocol(location)}//${location.host}/rtmp`;
}

export function buildApiUrl(path: string, baseUrl = resolveApiBaseUrl()): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const normalizedBase = trimTrailingSlash(baseUrl);
  return normalizedBase ? `${normalizedBase}${normalizedPath}` : normalizedPath;
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get('content-type') || '').toLowerCase().includes('application/json');
}

async function readResponseText(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

function getJsonErrorMessage(text: string): string {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    return '';
  }
  return '';
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function isAbortError(error: unknown): boolean {
  return isAbortLike(error);
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function requestJson<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...requestInit } = init;
  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortFromCaller = () => controller.abort();
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await fetch(buildApiUrl(path), {
      ...requestInit,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await readResponseText(response);
      const detail = isJsonResponse(response) ? getJsonErrorMessage(text) : '';
      throw new ApiRequestError(
        detail || `Studio server returned ${response.status}. Please try again.`,
        { status: response.status, responseText: text }
      );
    }

    if (!isJsonResponse(response)) {
      const text = await readResponseText(response);
      throw new ApiRequestError(
        'Studio server returned an unexpected response. Please refresh and try again.',
        { status: response.status, responseText: text }
      );
    }

    return await response.json() as T;
  } catch (error) {
    if (timedOut && isAbortLike(error)) {
      throw new ApiRequestError(
        'Studio server timed out. Please try again in a moment.',
        { timedOut: true, cause: error }
      );
    }
    if (isAbortLike(error)) throw error;
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError('Network error. Please check your connection and try again.', { cause: error });
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function getJson<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  return requestJson<T>(path, init);
}

export function postJson<T>(
  path: string,
  body: unknown,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return requestJson<T>(path, {
    ...init,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}
