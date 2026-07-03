import { resolveMediaHttpUrl } from './apiClient.ts';

const DEFAULT_MEDIA_SERVER_HEALTH_TIMEOUT_MS = 4_000;

export type MediaServerHealthStatus = 'checking' | 'ready' | 'unavailable';

export interface MediaServerCapabilityHealth {
  ready: boolean;
  message: string;
  details?: Record<string, unknown>;
}

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
  presentationRenderer?: MediaServerCapabilityHealth;
}

export type MediaServerParityFeatureStatus = 'ready' | 'checking' | 'degraded' | 'blocked';

export interface MediaServerParityFeature {
  id: 'rtmp-relay' | 'mp4-export' | 'live-backup' | 'exact-deck-rendering';
  label: string;
  status: MediaServerParityFeatureStatus;
  detail: string;
}

export interface MediaServerRecoveryAction {
  id: string;
  label: string;
}

export interface MediaServerParityDiagnostics {
  status: 'ready' | 'checking' | 'degraded' | 'blocked';
  headline: string;
  detail: string;
  features: MediaServerParityFeature[];
  actions: MediaServerRecoveryAction[];
}

interface MediaServerHealthPayload {
  status?: unknown;
  service?: unknown;
  version?: unknown;
  commit?: unknown;
  environment?: unknown;
  capabilities?: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeCapability(value: unknown): MediaServerCapabilityHealth | undefined {
  if (!isRecord(value) || typeof value.ready !== 'boolean') return undefined;
  const message = readString(value.message) || (value.ready ? 'Capability ready.' : 'Capability unavailable.');
  const details = isRecord(value.details) ? value.details : undefined;
  return {
    ready: value.ready,
    message,
    ...(details ? { details } : {}),
  };
}

function getCapability(payload: MediaServerHealthPayload, key: string): MediaServerCapabilityHealth | undefined {
  if (!isRecord(payload.capabilities)) return undefined;
  return normalizeCapability(payload.capabilities[key]);
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

function createMediaServerFeature(
  id: MediaServerParityFeature['id'],
  label: string,
  status: MediaServerParityFeatureStatus,
  detail: string
): MediaServerParityFeature {
  return { id, label, status, detail };
}

function getUnavailableRecoveryActions(health: MediaServerHealth): MediaServerRecoveryAction[] {
  if (!health.mediaHttpUrl) {
    return [
      { id: 'configure-http-url', label: 'Set VITE_MEDIA_HTTP_URL to the Render media-server base URL.' },
      { id: 'configure-ws-url', label: 'Set VITE_MEDIA_WS_URL to the same service /rtmp WebSocket endpoint.' },
      { id: 'redeploy-client', label: 'Redeploy the Hostinger client after updating environment variables.' },
    ];
  }

  if (health.renderRouting?.toLowerCase() === 'no-server') {
    return [
      { id: 'sync-render-service', label: 'Create or sync livestream-studio-media-server from render.yaml in Render.' },
      { id: 'share-token-secret', label: 'Set the same LIVE_STREAM_TOKEN_SECRET on both Render services.' },
      { id: 'add-deploy-hook', label: 'Add RENDER_MEDIA_SERVER_DEPLOY_HOOK_URL to GitHub Actions secrets.' },
      { id: 'redeploy-media-server', label: 'Run the deploy workflow with deploy_media enabled, or merge a media-server change after the hook is set.' },
    ];
  }

  if (/older deployment|redeploy/i.test(health.message)) {
    return [
      { id: 'redeploy-media-server', label: 'Redeploy the Render media-server from the current main branch.' },
      { id: 'verify-health', label: 'Confirm /health reports service: media-server and the current commit.' },
    ];
  }

  return [
    { id: 'verify-render-service', label: 'Confirm the media-server Render service is running and reachable at the configured URL.' },
    { id: 'check-cors', label: 'Confirm CLIENT_URLS includes the studio origin for health, upload, and relay requests.' },
  ];
}

export function buildMediaServerParityDiagnostics(health: MediaServerHealth | null | undefined): MediaServerParityDiagnostics {
  if (!health || health.status === 'checking') {
    const detail = health?.message || 'Media-server readiness has not been checked yet.';
    return {
      status: 'checking',
      headline: 'Media-server readiness pending',
      detail,
      features: [
        createMediaServerFeature('rtmp-relay', 'RTMP multistreaming', 'checking', detail),
        createMediaServerFeature('mp4-export', 'Final MP4 export', 'checking', detail),
        createMediaServerFeature('live-backup', 'Live backup recording', 'checking', detail),
        createMediaServerFeature('exact-deck-rendering', 'Exact deck rendering', 'checking', detail),
      ],
      actions: [],
    };
  }

  if (health.status === 'unavailable') {
    return {
      status: 'blocked',
      headline: 'Media-server features blocked',
      detail: health.message,
      features: [
        createMediaServerFeature('rtmp-relay', 'RTMP multistreaming', 'blocked', 'Go Live relay cannot start without the media-server WebSocket endpoint.'),
        createMediaServerFeature('mp4-export', 'Final MP4 export', 'blocked', 'Browser recordings can save locally, but server-side final MP4 export is unavailable.'),
        createMediaServerFeature('live-backup', 'Live backup recording', 'blocked', 'The automatic server backup recording is unavailable until the media-server runs.'),
        createMediaServerFeature('exact-deck-rendering', 'Exact deck rendering', 'blocked', 'PDF, legacy PowerPoint, Keynote, and exact PPTX rendering need the media-server renderer.'),
      ],
      actions: getUnavailableRecoveryActions(health),
    };
  }

  const deckReady = health.presentationRenderer?.ready === true;
  const deckDetail = health.presentationRenderer?.message || 'Exact deck-renderer capability metadata is missing.';

  return {
    status: deckReady ? 'ready' : 'degraded',
    headline: deckReady ? 'Media-server features ready' : 'Media-server partially ready',
    detail: deckReady
      ? health.message
      : 'RTMP relay and MP4 export are reachable, but exact deck rendering still needs attention.',
    features: [
      createMediaServerFeature('rtmp-relay', 'RTMP multistreaming', 'ready', 'Go Live relay endpoint is reachable.'),
      createMediaServerFeature('mp4-export', 'Final MP4 export', 'ready', 'Recording upload and MP4 export endpoint is reachable.'),
      createMediaServerFeature('live-backup', 'Live backup recording', 'ready', 'Server-side live backup status and download routes are reachable.'),
      createMediaServerFeature(
        'exact-deck-rendering',
        'Exact deck rendering',
        deckReady ? 'ready' : 'degraded',
        deckReady ? deckDetail : `${deckDetail} Redeploy the Docker media-server with LibreOffice and Poppler available.`
      ),
    ],
    actions: deckReady
      ? []
      : [
          { id: 'install-renderer-deps', label: 'Redeploy the Docker media-server with LibreOffice and Poppler installed.' },
          { id: 'verify-deck-capability', label: 'Confirm /health reports presentationRenderer.ready: true.' },
        ],
  };
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
  const reportedPresentationRenderer = getCapability(value, 'presentationRenderer');

  if (value.status !== 'ok') {
    return failure('Media server health did not report ready status.', input);
  }
  if (!service) {
    return failure('Media server is an older deployment. Redeploy the Render media-server before using RTMP, exact deck rendering, or MP4 export.', input);
  }
  if (service !== 'media-server') {
    return failure(`Health endpoint reported ${service}; expected media-server.`, input);
  }
  const presentationRenderer = reportedPresentationRenderer || {
    ready: false,
    message: 'Media server is an older deployment and does not report exact deck-renderer capability metadata. Redeploy the Render media-server before uploading PowerPoint or PDF decks.',
  };

  return {
    status: 'ready',
    mediaHttpUrl: input.mediaHttpUrl,
    message: presentationRenderer && !presentationRenderer.ready
      ? 'Media server reachable. Exact deck rendering is unavailable until the presentation renderer dependencies are fixed.'
      : 'Media server ready for RTMP relay, exact deck rendering, MP4 export, and backup recordings.',
    checkedAt: input.checkedAt,
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    service,
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    ...(environment ? { environment } : {}),
    ...(presentationRenderer ? { presentationRenderer } : {}),
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
