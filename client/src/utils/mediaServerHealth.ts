import { resolveMediaHttpUrl } from './apiClient.ts';

const DEFAULT_MEDIA_SERVER_HEALTH_TIMEOUT_MS = 4_000;

export type MediaServerHealthStatus = 'checking' | 'ready' | 'unavailable';

export interface MediaServerHealth {
  status: MediaServerHealthStatus;
  mediaHttpUrl: string;
  message: string;
  checkedAt: number | null;
  service?: string;
  version?: string;
  commit?: string;
  environment?: string;
  httpStatus?: number;
  renderRouting?: string;
}

interface MediaServerHealthPayload {
  status?: unknown;
  service?: unknown;
  version?: unknown;
  commit?: unknown;
  environment?: unknown;
}

interface CheckMediaServerHealthOptions {
  mediaHttpUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: number;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function buildMediaServerUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function failure(
  message: string,
  input: {
    mediaHttpUrl: string;
    checkedAt: number;
    httpStatus?: number;
    renderRouting?: string;
  }
): MediaServerHealth {
  return {
    status: 'unavailable',
    mediaHttpUrl: input.mediaHttpUrl,
    message,
    checkedAt: input.checkedAt,
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    ...(input.renderRouting ? { renderRouting: input.renderRouting } : {}),
  };
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

async function readFailureMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      const json = JSON.parse(text) as { error?: unknown; message?: unknown };
      const jsonMessage = readString(json.error) || readString(json.message);
      if (jsonMessage) return jsonMessage;
    } catch {
      const plain = text.trim();
      if (plain) return plain.slice(0, 180);
    }
  }
  return `Media server returned HTTP ${response.status}.`;
}

export function buildInitialMediaServerHealth(mediaHttpUrl = resolveMediaHttpUrl()): MediaServerHealth {
  return {
    status: 'checking',
    mediaHttpUrl: normalizeBaseUrl(mediaHttpUrl),
    message: 'Checking media-server readiness...',
    checkedAt: null,
  };
}

export function normalizeMediaServerHealthPayload(
  value: MediaServerHealthPayload,
  input: {
    mediaHttpUrl: string;
    checkedAt: number;
    httpStatus?: number;
  }
): MediaServerHealth {
  const service = readString(value.service);
  const version = readString(value.version);
  const commit = readString(value.commit);
  const environment = readString(value.environment);

  if (value.status !== 'ok') {
    return failure('Media server health did not report ready status.', input);
  }
  if (!service) {
    return failure('Media server is an older deployment. Redeploy the Render media-server before using RTMP, exact deck rendering, or MP4 export.', input);
  }
  if (service !== 'media-server') {
    return failure(`Health endpoint reported ${service}; expected media-server.`, input);
  }

  return {
    status: 'ready',
    mediaHttpUrl: input.mediaHttpUrl,
    message: 'Media server ready for RTMP relay, exact deck rendering, MP4 export, and backup recordings.',
    checkedAt: input.checkedAt,
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    service,
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    ...(environment ? { environment } : {}),
  };
}

export async function checkMediaServerHealth(
  options: CheckMediaServerHealthOptions = {}
): Promise<MediaServerHealth> {
  const checkedAt = options.nowMs ?? Date.now();
  const mediaHttpUrl = normalizeBaseUrl(
    options.mediaHttpUrl !== undefined ? options.mediaHttpUrl : resolveMediaHttpUrl()
  );
  const fetchImpl = options.fetchImpl || fetch;

  if (!mediaHttpUrl) {
    return failure('Media server URL is not configured. Set VITE_MEDIA_HTTP_URL for exact deck rendering, MP4 export, and RTMP support.', {
      mediaHttpUrl,
      checkedAt,
    });
  }
  if (typeof fetchImpl !== 'function') {
    return failure('This browser cannot check media-server readiness.', {
      mediaHttpUrl,
      checkedAt,
    });
  }

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    Math.max(1_000, options.timeoutMs ?? DEFAULT_MEDIA_SERVER_HEALTH_TIMEOUT_MS)
  );

  try {
    const response = await fetchImpl(buildMediaServerUrl(mediaHttpUrl, '/health'), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    const renderRouting = response.headers.get('x-render-routing') || undefined;

    if (!response.ok) {
      if (renderRouting?.toLowerCase() === 'no-server') {
        return failure('Media server is not provisioned on Render. Create or sync livestream-studio-media-server from render.yaml, then redeploy.', {
          mediaHttpUrl,
          checkedAt,
          httpStatus: response.status,
          renderRouting,
        });
      }
      const message = await readFailureMessage(response);
      return failure(message, {
        mediaHttpUrl,
        checkedAt,
        httpStatus: response.status,
        ...(renderRouting ? { renderRouting } : {}),
      });
    }

    const payload = await response.json() as MediaServerHealthPayload;
    return normalizeMediaServerHealthPayload(payload, {
      mediaHttpUrl,
      checkedAt,
      httpStatus: response.status,
    });
  } catch (error) {
    return failure(
      isAbortLike(error)
        ? 'Media server health check timed out.'
        : error instanceof Error && error.message
          ? `Media server health check failed: ${error.message}`
          : 'Media server health check failed.',
      {
        mediaHttpUrl,
        checkedAt,
      }
    );
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
