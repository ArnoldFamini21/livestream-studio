import type { ExternalChatSource } from '@studio/shared';

const GRAPH_API_VERSION = 'v25.0';
const FACEBOOK_GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const DEFAULT_LIMIT = 100;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MIN_LIVE_VIDEO_ID_LENGTH = 4;
const MAX_LIVE_VIDEO_ID_LENGTH = 128;

export interface FacebookLiveComment {
  id: string;
  authorName: string;
  content: string;
  publishedAt: string;
  source: ExternalChatSource;
}

export interface FacebookLiveCommentsPollResult {
  comments: FacebookLiveComment[];
  nextPageToken?: string;
  pollingIntervalMillis: number;
}

export interface FetchFacebookLiveCommentsOptions {
  accessToken: string;
  liveVideoId: string;
  pageToken?: string;
  limit?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

interface FacebookGraphResponse {
  data?: unknown;
  paging?: {
    cursors?: {
      after?: unknown;
    };
  };
  error?: {
    message?: unknown;
  };
}

interface FacebookCommentItem {
  id?: unknown;
  message?: unknown;
  created_time?: unknown;
  from?: {
    id?: unknown;
    name?: unknown;
    picture?: {
      data?: {
        url?: unknown;
      };
    };
  };
}

export function normalizeFacebookLiveVideoId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (
    normalized.length < MIN_LIVE_VIDEO_ID_LENGTH ||
    normalized.length > MAX_LIVE_VIDEO_ID_LENGTH ||
    !/^[A-Za-z0-9_.:-]+$/.test(normalized)
  ) {
    return '';
  }
  return normalized;
}

export function normalizeFacebookAccessToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length >= 20 && normalized.length <= 4096 ? normalized : '';
}

function normalizeOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function getPollInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed)));
}

export function normalizeFacebookLiveComment(item: unknown): FacebookLiveComment | null {
  if (!item || typeof item !== 'object') return null;
  const input = item as FacebookCommentItem;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const authorName = typeof input.from?.name === 'string'
    ? input.from.name.replace(/[\x00-\x1F\x7F]/g, '').trim()
    : '';
  const content = typeof input.message === 'string'
    ? input.message.replace(/[\x00-\x1F\x7F]/g, '').trim()
    : '';
  const publishedAt = typeof input.created_time === 'string' && Number.isFinite(Date.parse(input.created_time))
    ? input.created_time
    : new Date().toISOString();

  if (!id || !authorName || !content) return null;

  const avatarUrl = normalizeOptionalUrl(input.from?.picture?.data?.url);

  return {
    id,
    authorName,
    content,
    publishedAt,
    source: {
      platform: 'facebook',
      externalId: id,
      publishedAt,
      ...(typeof input.from?.id === 'string' && input.from.id.trim()
        ? { authorChannelId: input.from.id.trim() }
        : {}),
      ...(avatarUrl
        ? { avatarUrl }
        : {}),
    },
  };
}

export function buildFacebookLiveCommentsUrl(options: FetchFacebookLiveCommentsOptions): string {
  const accessToken = normalizeFacebookAccessToken(options.accessToken);
  const liveVideoId = normalizeFacebookLiveVideoId(options.liveVideoId);
  if (!accessToken) throw new Error('Facebook access token is required');
  if (!liveVideoId) throw new Error('A valid Facebook live video id is required');

  const url = new URL(`${FACEBOOK_GRAPH_URL}/${encodeURIComponent(liveVideoId)}/comments`);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('fields', 'id,message,created_time,from{id,name,picture}');
  url.searchParams.set('order', 'chronological');
  url.searchParams.set('limit', String(Math.min(100, Math.max(1, options.limit || DEFAULT_LIMIT))));
  url.searchParams.set('filter', 'stream');
  if (options.pageToken) url.searchParams.set('after', options.pageToken);
  return url.toString();
}

export async function fetchFacebookLiveComments(
  options: FetchFacebookLiveCommentsOptions
): Promise<FacebookLiveCommentsPollResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(buildFacebookLiveCommentsUrl(options), {
    headers: {
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  let body: FacebookGraphResponse = {};
  try {
    body = JSON.parse(text) as FacebookGraphResponse;
  } catch {
    throw new Error(`Facebook Live Comments returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const message = typeof body.error?.message === 'string' && body.error.message.trim()
      ? body.error.message.trim()
      : `Facebook Live Comments returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const data = Array.isArray(body.data) ? body.data : [];
  return {
    comments: data
      .map((item) => normalizeFacebookLiveComment(item))
      .filter((item): item is FacebookLiveComment => Boolean(item)),
    nextPageToken: typeof body.paging?.cursors?.after === 'string' ? body.paging.cursors.after : undefined,
    pollingIntervalMillis: getPollInterval(options.pollIntervalMs),
  };
}
