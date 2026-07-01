import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildYouTubeLiveChatMessagesUrl,
  fetchYouTubeLiveChatMessages,
  normalizeYouTubeApiKey,
  normalizeYouTubeLiveChatId,
  normalizeYouTubeLiveChatMessage,
} from '../dist/services/youtubeLiveChat.js';

const API_KEY = 'AIzaSyD_test_key_123456789012345678';
const LIVE_CHAT_ID = 'Cg0KC3N0dWRpby1jaGF0';

describe('YouTube live chat adapter', () => {
  it('normalizes live chat ids and API keys without accepting unsafe values', () => {
    assert.equal(normalizeYouTubeLiveChatId(` ${LIVE_CHAT_ID} `), LIVE_CHAT_ID);
    assert.equal(normalizeYouTubeLiveChatId('short'), '');
    assert.equal(normalizeYouTubeLiveChatId('bad id'), '');
    assert.equal(normalizeYouTubeApiKey(API_KEY), API_KEY);
    assert.equal(normalizeYouTubeApiKey('too-short'), '');
  });

  it('builds YouTube live chat message URLs without exposing secrets in logs', () => {
    const url = new URL(buildYouTubeLiveChatMessagesUrl({
      apiKey: API_KEY,
      liveChatId: LIVE_CHAT_ID,
      pageToken: 'next-page',
      maxResults: 50,
    }));

    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/liveChat/messages');
    assert.equal(url.searchParams.get('liveChatId'), LIVE_CHAT_ID);
    assert.equal(url.searchParams.get('part'), 'id,snippet,authorDetails');
    assert.equal(url.searchParams.get('pageToken'), 'next-page');
    assert.equal(url.searchParams.get('maxResults'), '50');
    assert.equal(url.searchParams.get('key'), API_KEY);
  });

  it('normalizes text messages with author metadata', () => {
    const message = normalizeYouTubeLiveChatMessage({
      id: 'yt-message-1',
      snippet: {
        displayMessage: 'Hello from YouTube',
        publishedAt: '2026-07-01T20:00:00.000Z',
      },
      authorDetails: {
        channelId: 'channel-1',
        channelUrl: 'https://www.youtube.com/channel/channel-1',
        displayName: 'Viewer',
        profileImageUrl: 'https://yt3.ggpht.com/avatar',
        isChatModerator: true,
        isChatOwner: false,
        isChatSponsor: true,
      },
    });

    assert.ok(message);
    assert.equal(message.authorName, 'Viewer');
    assert.equal(message.content, 'Hello from YouTube');
    assert.equal(message.source.platform, 'youtube');
    assert.equal(message.source.externalId, 'yt-message-1');
    assert.equal(message.source.isModerator, true);
    assert.equal(message.source.isSponsor, true);
  });

  it('fetches and normalizes messages while respecting server polling interval', async () => {
    let requestedUrl = '';
    const result = await fetchYouTubeLiveChatMessages({
      apiKey: API_KEY,
      liveChatId: LIVE_CHAT_ID,
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          nextPageToken: 'next-token',
          pollingIntervalMillis: 7500,
          items: [
            {
              id: 'yt-message-1',
              snippet: {
                textMessageDetails: { messageText: 'First' },
                publishedAt: '2026-07-01T20:00:00.000Z',
              },
              authorDetails: {
                displayName: 'Viewer',
              },
            },
            {
              id: 'missing-content',
              snippet: {},
              authorDetails: {
                displayName: 'Viewer',
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    assert.match(requestedUrl, /liveChat\/messages/);
    assert.equal(result.nextPageToken, 'next-token');
    assert.equal(result.pollingIntervalMillis, 7500);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'First');
  });

  it('surfaces YouTube API errors clearly', async () => {
    await assert.rejects(
      fetchYouTubeLiveChatMessages({
        apiKey: API_KEY,
        liveChatId: LIVE_CHAT_ID,
        fetchImpl: async () => new Response(JSON.stringify({
          error: { message: 'Live chat is not active' },
        }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      /Live chat is not active/
    );
  });
});
