import {
  createGoogleTokenAuthorizer,
  getGoogleOAuthApi,
  isGoogleOAuthClientId,
  prepareGoogleIdentity,
} from './googleOAuth.ts';

/**
 * Connected YouTube destinations (StreamYard-style): sign in once, and the
 * studio creates the YouTube broadcast, its RTMP stream, and binds them. The
 * broadcast auto-starts when the relay's first frames arrive and auto-stops
 * when the stream ends, so the host never copies a stream key by hand.
 */

export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_TITLE_MAX_LENGTH = 100;
export const YOUTUBE_DESCRIPTION_MAX_LENGTH = 5000;

export type YouTubePrivacyStatus = 'public' | 'unlisted' | 'private';
export type YouTubeLatencyPreference = 'normal' | 'low' | 'ultraLow';

export interface YouTubeBroadcastRequest {
  title: string;
  description?: string;
  privacyStatus: YouTubePrivacyStatus;
  latencyPreference?: YouTubeLatencyPreference;
  scheduledStartTime?: string;
  madeForKids?: boolean;
}

export interface YouTubeConnectedBroadcast {
  broadcastId: string;
  streamId: string;
  title: string;
  privacyStatus: YouTubePrivacyStatus;
  rtmpUrl: string;
  streamKey: string;
  watchUrl: string;
  studioUrl: string;
  liveChatId?: string;
}

interface GoogleApiErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> };
}

export class YouTubeApiError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

const clientId = import.meta.env?.VITE_GOOGLE_CLIENT_ID || '';

export function isYouTubeConnectionConfigured(): boolean {
  return isGoogleOAuthClientId(clientId);
}

const authorizer = createGoogleTokenAuthorizer({
  getOAuth: getGoogleOAuthApi,
  clientId,
  scope: YOUTUBE_SCOPE,
  missingScopeMessage: 'Allow the studio to manage your YouTube live broadcasts to connect this channel.',
});

/** Load Google sign-in ahead of the click so the popup opens from the user gesture. */
export async function prepareYouTubeConnection(): Promise<void> {
  if (!isYouTubeConnectionConfigured()) throw new Error('YouTube connection is not configured for this studio.');
  await prepareGoogleIdentity();
}

export function authorizeYouTube(): Promise<string> {
  return authorizer.authorize();
}

export function disconnectYouTube(): void {
  authorizer.clear();
}

/** YouTube rejects angle brackets in titles and descriptions; keep within its limits. */
export function sanitizeYouTubeText(value: string, maxLength: number): string {
  return value.replace(/[<>]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLength);
}

export function describeYouTubeApiError(status: number, reason: string, fallback: string): string {
  switch (reason) {
    case 'liveStreamingNotEnabled':
      return 'Live streaming is not enabled on this YouTube channel yet. Enable it in YouTube Studio; approval can take up to 24 hours.';
    case 'insufficientPermissions':
    case 'forbidden':
      return 'This Google account cannot manage live broadcasts for the channel. Choose the channel owner or manager account.';
    case 'invalidScheduledStartTime':
      return 'YouTube rejected the start time. Choose a time in the future and try again.';
    case 'quotaExceeded':
    case 'rateLimitExceeded':
    case 'userRequestsExceedRateLimit':
      return 'YouTube is limiting requests right now. Wait a minute and try again.';
    case 'titleRequired':
    case 'invalidTitle':
      return 'Enter a YouTube title of 100 characters or fewer.';
    case 'invalidDescription':
      return 'Shorten the YouTube description to 5,000 characters or fewer.';
    default:
      if (status === 401) return 'Your YouTube sign-in expired. Connect YouTube again.';
      return fallback || `YouTube returned ${status}.`;
  }
}

async function youtubeRequest<T>(
  fetchImpl: typeof fetch,
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (!response.ok) {
    const error = (parsed as GoogleApiErrorBody | null)?.error;
    const reason = error?.errors?.[0]?.reason || '';
    throw new YouTubeApiError(response.status, reason, describeYouTubeApiError(response.status, reason, error?.message || ''));
  }
  return parsed as T;
}

interface LiveBroadcastResource {
  id?: string;
  snippet?: { title?: string; liveChatId?: string };
  status?: { privacyStatus?: string };
}

interface LiveStreamResource {
  id?: string;
  cdn?: {
    ingestionInfo?: {
      streamName?: string;
      ingestionAddress?: string;
    };
  };
}

export function buildYouTubeBroadcastBody(input: YouTubeBroadcastRequest, now = new Date()) {
  const title = sanitizeYouTubeText(input.title, YOUTUBE_TITLE_MAX_LENGTH);
  if (!title) throw new Error('Enter a title for the YouTube broadcast.');
  const description = sanitizeYouTubeText(input.description || '', YOUTUBE_DESCRIPTION_MAX_LENGTH);
  const requestedStart = input.scheduledStartTime ? Date.parse(input.scheduledStartTime) : Number.NaN;
  const scheduledStartTime = Number.isFinite(requestedStart) && requestedStart > now.getTime()
    ? new Date(requestedStart).toISOString()
    : now.toISOString();
  return {
    snippet: { title, description, scheduledStartTime },
    status: {
      privacyStatus: input.privacyStatus,
      selfDeclaredMadeForKids: input.madeForKids === true,
    },
    contentDetails: {
      enableAutoStart: true,
      enableAutoStop: true,
      enableDvr: true,
      recordFromStart: true,
      latencyPreference: input.latencyPreference || 'normal',
    },
  };
}

/**
 * Create a broadcast plus a single-use RTMP stream and bind them. Anything
 * created before a failure is deleted so the channel is not left with
 * orphaned upcoming broadcasts.
 */
export async function createYouTubeLiveBroadcast(
  input: YouTubeBroadcastRequest,
  options: { token: string; fetchImpl?: typeof fetch; now?: Date }
): Promise<YouTubeConnectedBroadcast> {
  const fetchImpl = options.fetchImpl ?? ((request: RequestInfo | URL, init?: RequestInit) => fetch(request, init));
  const body = buildYouTubeBroadcastBody(input, options.now);
  let broadcastId = '';
  let streamId = '';
  try {
    const broadcast = await youtubeRequest<LiveBroadcastResource>(
      fetchImpl, options.token, 'POST', '/liveBroadcasts?part=snippet,status,contentDetails', body
    );
    broadcastId = broadcast.id || '';
    if (!broadcastId) throw new Error('YouTube did not return the new broadcast.');

    const stream = await youtubeRequest<LiveStreamResource>(
      fetchImpl, options.token, 'POST', '/liveStreams?part=snippet,cdn,contentDetails',
      {
        snippet: { title: `${body.snippet.title} (studio)`.slice(0, YOUTUBE_TITLE_MAX_LENGTH) },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: false },
      }
    );
    streamId = stream.id || '';
    const rtmpUrl = stream.cdn?.ingestionInfo?.ingestionAddress || '';
    const streamKey = stream.cdn?.ingestionInfo?.streamName || '';
    if (!streamId || !rtmpUrl || !streamKey) throw new Error('YouTube did not return stream ingestion settings.');

    await youtubeRequest<unknown>(
      fetchImpl, options.token, 'POST',
      `/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&part=id,contentDetails&streamId=${encodeURIComponent(streamId)}`
    );

    return {
      broadcastId,
      streamId,
      title: broadcast.snippet?.title || body.snippet.title,
      privacyStatus: input.privacyStatus,
      rtmpUrl,
      streamKey,
      watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(broadcastId)}`,
      studioUrl: `https://studio.youtube.com/video/${encodeURIComponent(broadcastId)}/livestreaming`,
      ...(broadcast.snippet?.liveChatId ? { liveChatId: broadcast.snippet.liveChatId } : {}),
    };
  } catch (error) {
    const cleanup: Promise<unknown>[] = [];
    if (streamId) {
      cleanup.push(youtubeRequest(fetchImpl, options.token, 'DELETE', `/liveStreams?id=${encodeURIComponent(streamId)}`).catch(() => {}));
    }
    if (broadcastId) {
      cleanup.push(youtubeRequest(fetchImpl, options.token, 'DELETE', `/liveBroadcasts?id=${encodeURIComponent(broadcastId)}`).catch(() => {}));
    }
    await Promise.all(cleanup);
    throw error;
  }
}
