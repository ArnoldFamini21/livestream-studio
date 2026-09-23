import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  YOUTUBE_TITLE_MAX_LENGTH,
  YouTubeApiError,
  buildYouTubeBroadcastBody,
  createYouTubeLiveBroadcast,
  describeYouTubeApiError,
  sanitizeYouTubeText,
} from '../src/utils/youtubeLiveBroadcast.ts';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
}

function createYouTubeApi(options: { failBind?: boolean; failStreamReason?: string } = {}) {
  const requests: RecordedRequest[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    requests.push({
      method,
      url,
      authorization: new Headers(init?.headers).get('authorization') || '',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('/liveBroadcasts/bind')) {
      return options.failBind
        ? json({ error: { code: 403, message: 'Bind failed', errors: [{ reason: 'forbidden' }] } }, 403)
        : json({ id: 'broadcast-123' });
    }
    if (url.includes('/liveBroadcasts?')) {
      return json({
        id: 'broadcast-123',
        snippet: { title: 'Sabbath Service', liveChatId: 'chat-abc' },
        status: { privacyStatus: 'unlisted' },
      });
    }
    if (url.includes('/liveStreams?')) {
      if (options.failStreamReason) {
        return json({ error: { code: 403, message: 'Nope', errors: [{ reason: options.failStreamReason }] } }, 403);
      }
      return json({
        id: 'stream-456',
        cdn: { ingestionInfo: { streamName: 'abcd-efgh-ijkl', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2' } },
      });
    }
    return json({}, 404);
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

describe('connected YouTube broadcasts', () => {
  it('creates, binds, and returns ready-to-stream ingestion settings', async () => {
    const api = createYouTubeApi();
    const broadcast = await createYouTubeLiveBroadcast(
      { title: 'Sabbath <Service>', description: 'Divine service', privacyStatus: 'unlisted' },
      { token: 'yt-token', fetchImpl: api.fetchImpl, now: new Date('2026-09-26T01:00:00.000Z') }
    );

    assert.deepEqual(broadcast, {
      broadcastId: 'broadcast-123',
      streamId: 'stream-456',
      title: 'Sabbath Service',
      privacyStatus: 'unlisted',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
      streamKey: 'abcd-efgh-ijkl',
      watchUrl: 'https://www.youtube.com/watch?v=broadcast-123',
      studioUrl: 'https://studio.youtube.com/video/broadcast-123/livestreaming',
      liveChatId: 'chat-abc',
    });
    assert.deepEqual(api.requests.map((request) => request.method), ['POST', 'POST', 'POST']);
    assert.ok(api.requests.every((request) => request.authorization === 'Bearer yt-token'));
    const created = api.requests[0].body as ReturnType<typeof buildYouTubeBroadcastBody>;
    assert.equal(created.snippet.title, 'Sabbath Service');
    assert.equal(created.snippet.scheduledStartTime, '2026-09-26T01:00:00.000Z');
    assert.equal(created.contentDetails.enableAutoStart, true);
    assert.equal(created.contentDetails.enableAutoStop, true);
    assert.equal(created.status.selfDeclaredMadeForKids, false);
    assert.deepEqual((api.requests[1].body as { contentDetails: unknown }).contentDetails, { isReusable: false });
    assert.match(api.requests[2].url, /liveBroadcasts\/bind\?id=broadcast-123&part=id,contentDetails&streamId=stream-456$/);
  });

  it('deletes the broadcast and stream when binding fails', async () => {
    const api = createYouTubeApi({ failBind: true });
    await assert.rejects(
      createYouTubeLiveBroadcast({ title: 'Vespers', privacyStatus: 'public' }, { token: 't', fetchImpl: api.fetchImpl }),
      (error) => error instanceof YouTubeApiError && /cannot manage live broadcasts/.test(error.message)
    );
    const deletes = api.requests.filter((request) => request.method === 'DELETE').map((request) => request.url);
    assert.equal(deletes.length, 2);
    assert.ok(deletes.some((url) => url.endsWith('/liveStreams?id=stream-456')));
    assert.ok(deletes.some((url) => url.endsWith('/liveBroadcasts?id=broadcast-123')));
  });

  it('explains a channel that is not yet enabled for live streaming', async () => {
    const api = createYouTubeApi({ failStreamReason: 'liveStreamingNotEnabled' });
    await assert.rejects(
      createYouTubeLiveBroadcast({ title: 'Midweek', privacyStatus: 'private' }, { token: 't', fetchImpl: api.fetchImpl }),
      /not enabled on this YouTube channel/
    );
    assert.ok(api.requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/liveBroadcasts?id=broadcast-123')));
  });

  it('builds a valid request body from user input', () => {
    const now = new Date('2026-09-26T01:00:00.000Z');
    const scheduled = buildYouTubeBroadcastBody(
      { title: 'Bible study', privacyStatus: 'public', scheduledStartTime: '2026-09-27T09:00:00.000Z', latencyPreference: 'low' },
      now
    );
    assert.equal(scheduled.snippet.scheduledStartTime, '2026-09-27T09:00:00.000Z');
    assert.equal(scheduled.contentDetails.latencyPreference, 'low');
    const past = buildYouTubeBroadcastBody(
      { title: 'Bible study', privacyStatus: 'public', scheduledStartTime: '2020-01-01T00:00:00.000Z' },
      now
    );
    assert.equal(past.snippet.scheduledStartTime, now.toISOString(), 'past start times go live now');
    assert.throws(() => buildYouTubeBroadcastBody({ title: ' <> ', privacyStatus: 'public' }, now), /Enter a title/);
  });

  it('sanitizes text to YouTube limits', () => {
    assert.equal(sanitizeYouTubeText('  Hope <for> today\u0007 ', 100), 'Hope for today');
    assert.equal(sanitizeYouTubeText('x'.repeat(200), YOUTUBE_TITLE_MAX_LENGTH).length, YOUTUBE_TITLE_MAX_LENGTH);
  });

  it('maps API failures to actionable messages', () => {
    assert.match(describeYouTubeApiError(403, 'quotaExceeded', ''), /Wait a minute/);
    assert.match(describeYouTubeApiError(401, '', ''), /expired/);
    assert.equal(describeYouTubeApiError(500, '', 'Backend error'), 'Backend error');
  });
});
