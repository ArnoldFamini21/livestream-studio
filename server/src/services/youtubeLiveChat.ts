import type { ExternalChatSource } from '@studio/shared';

const YOUTUBE_LIVE_CHAT_MESSAGES_URL = 'https://www.googleapis.com/youtube/v3/liveChat/messages';
const DEFAULT_MAX_RESULTS = 200;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MIN_LIVE_CHAT_ID_LENGTH = 6;
const MAX_LIVE_CHAT_ID_LENGTH = 512;

export interface YouTubeLiveChatMessage {
  id: string;
  authorName: string;
  content: string;
  publishedAt: string;
  source: ExternalChatSource;
}

export interface YouTubeLiveChatPollResult {
  messages: YouTubeLiveChatMessage[];
  nextPageToken?: string;
  pollingIntervalMillis: number;
}

export interface FetchYouTubeLiveChatMessagesOptions {
  apiKey: string;
  liveChatId: string;
  pageToken?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

interface YouTubeLiveChatApiResponse {
  nextPageToken?: unknown;
  pollingIntervalMillis?: unknown;
  items?: unknown;
  error?: {
    message?: unknown;
  };
}

interface YouTubeLiveChatApiItem {
  id?: unknown;
  snippet?: {
    displayMessage?: unknown;
    publishedAt?: unknown;
    type?: unknown;
    textMessageDetails?: {
      messageText?: unknown;
    };
  };
  authorDetails?: {
    channelId?: unknown;
    channelUrl?: unknown;
    displayName?: unknown;
    profileImageUrl?: unknown;
    isChatModerator?: unknown;
    isChatOwner?: unknown;
    isChatSponsor?: unknown;
  };
}

export function normalizeYouTubeLiveChatId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\x00-\x1F\x7F]/g, '');
  if (
    normalized.length < MIN_LIVE_CHAT_ID_LENGTH ||
    normalized.length > MAX_LIVE_CHAT_ID_LENGTH ||
    /\s/.test(normalized)
  ) {
    return '';
  }
  return normalized;
}

export function normalizeYouTubeApiKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length >= 20 && normalized.length <= 256 ? normalized : '';
}

function clampPollingInterval(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return MIN_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed)));
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

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function getMessageContent(item: YouTubeLiveChatApiItem): string {
  const displayMessage = typeof item.snippet?.displayMessage === 'string'
    ? item.snippet.displayMessage
    : '';
  const textMessage = typeof item.snippet?.textMessageDetails?.messageText === 'string'
    ? item.snippet.textMessageDetails.messageText
    : '';
  return (displayMessage || textMessage).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

export function normalizeYouTubeLiveChatMessage(item: unknown): YouTubeLiveChatMessage | null {
  if (!item || typeof item !== 'object') return null;
  const input = item as YouTubeLiveChatApiItem;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const authorName = typeof input.authorDetails?.displayName === 'string'
    ? input.authorDetails.displayName.replace(/[\x00-\x1F\x7F]/g, '').trim()
    : '';
  const content = getMessageContent(input);
  const publishedAt = typeof input.snippet?.publishedAt === 'string' && Number.isFinite(Date.parse(input.snippet.publishedAt))
    ? input.snippet.publishedAt
    : new Date().toISOString();

  if (!id || !authorName || !content) return null;

  const source: ExternalChatSource = {
    platform: 'youtube',
    externalId: id,
    publishedAt,
    ...(typeof input.authorDetails?.channelId === 'string' && input.authorDetails.channelId.trim()
      ? { authorChannelId: input.authorDetails.channelId.trim() }
      : {}),
    ...(normalizeOptionalUrl(input.authorDetails?.channelUrl)
      ? { authorUrl: normalizeOptionalUrl(input.authorDetails?.channelUrl) }
      : {}),
    ...(normalizeOptionalUrl(input.authorDetails?.profileImageUrl)
      ? { avatarUrl: normalizeOptionalUrl(input.authorDetails?.profileImageUrl) }
      : {}),
    ...(normalizeBoolean(input.authorDetails?.isChatModerator) !== undefined
      ? { isModerator: normalizeBoolean(input.authorDetails?.isChatModerator) }
      : {}),
    ...(normalizeBoolean(input.authorDetails?.isChatOwner) !== undefined
      ? { isOwner: normalizeBoolean(input.authorDetails?.isChatOwner) }
      : {}),
    ...(normalizeBoolean(input.authorDetails?.isChatSponsor) !== undefined
      ? { isSponsor: normalizeBoolean(input.authorDetails?.isChatSponsor) }
      : {}),
  };

  return {
    id,
    authorName,
    content,
    publishedAt,
    source,
  };
}

export function buildYouTubeLiveChatMessagesUrl(options: FetchYouTubeLiveChatMessagesOptions): string {
  const apiKey = normalizeYouTubeApiKey(options.apiKey);
  const liveChatId = normalizeYouTubeLiveChatId(options.liveChatId);
  if (!apiKey) throw new Error('YouTube API key is required');
  if (!liveChatId) throw new Error('A valid YouTube live chat id is required');

  const url = new URL(YOUTUBE_LIVE_CHAT_MESSAGES_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('liveChatId', liveChatId);
  url.searchParams.set('part', 'id,snippet,authorDetails');
  url.searchParams.set('maxResults', String(Math.min(2000, Math.max(1, options.maxResults || DEFAULT_MAX_RESULTS))));
  if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);
  return url.toString();
}

export async function fetchYouTubeLiveChatMessages(
  options: FetchYouTubeLiveChatMessagesOptions
): Promise<YouTubeLiveChatPollResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(buildYouTubeLiveChatMessagesUrl(options), {
    headers: {
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  let body: YouTubeLiveChatApiResponse = {};
  try {
    body = JSON.parse(text) as YouTubeLiveChatApiResponse;
  } catch {
    throw new Error(`YouTube Live Chat returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const message = typeof body.error?.message === 'string' && body.error.message.trim()
      ? body.error.message.trim()
      : `YouTube Live Chat returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  return {
    messages: items
      .map((item) => normalizeYouTubeLiveChatMessage(item))
      .filter((item): item is YouTubeLiveChatMessage => Boolean(item)),
    nextPageToken: typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined,
    pollingIntervalMillis: clampPollingInterval(body.pollingIntervalMillis),
  };
}
