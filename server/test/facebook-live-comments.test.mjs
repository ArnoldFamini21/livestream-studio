import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFacebookLiveCommentsUrl,
  fetchFacebookLiveComments,
  normalizeFacebookAccessToken,
  normalizeFacebookLiveComment,
  normalizeFacebookLiveVideoId,
} from '../dist/services/facebookLiveComments.js';

const ACCESS_TOKEN = 'EAABwzLixnjYBO_valid_test_token_1234567890';
const LIVE_VIDEO_ID = '123456789012345';

describe('Facebook live comments adapter', () => {
  it('normalizes live video ids and access tokens defensively', () => {
    assert.equal(normalizeFacebookLiveVideoId(` ${LIVE_VIDEO_ID} `), LIVE_VIDEO_ID);
    assert.equal(normalizeFacebookLiveVideoId('bad id'), '');
    assert.equal(normalizeFacebookLiveVideoId('x'), '');
    assert.equal(normalizeFacebookAccessToken(ACCESS_TOKEN), ACCESS_TOKEN);
    assert.equal(normalizeFacebookAccessToken('too-short'), '');
  });

  it('builds Graph API comments URLs for a live video', () => {
    const url = new URL(buildFacebookLiveCommentsUrl({
      accessToken: ACCESS_TOKEN,
      liveVideoId: LIVE_VIDEO_ID,
      pageToken: 'after-cursor',
      limit: 25,
    }));

    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(url.pathname.endsWith(`/${LIVE_VIDEO_ID}/comments`), true);
    assert.equal(url.searchParams.get('fields'), 'id,message,created_time,from{id,name,picture}');
    assert.equal(url.searchParams.get('order'), 'chronological');
    assert.equal(url.searchParams.get('filter'), 'stream');
    assert.equal(url.searchParams.get('after'), 'after-cursor');
    assert.equal(url.searchParams.get('limit'), '25');
    assert.equal(url.searchParams.get('access_token'), ACCESS_TOKEN);
  });

  it('normalizes comment records with author metadata', () => {
    const comment = normalizeFacebookLiveComment({
      id: 'fb-comment-1',
      message: 'Hello from Facebook',
      created_time: '2026-07-01T20:00:00+0000',
      from: {
        id: 'viewer-1',
        name: 'Facebook Viewer',
        picture: {
          data: {
            url: 'https://platform-lookaside.fbsbx.com/avatar',
          },
        },
      },
    });

    assert.ok(comment);
    assert.equal(comment.authorName, 'Facebook Viewer');
    assert.equal(comment.content, 'Hello from Facebook');
    assert.equal(comment.source.platform, 'facebook');
    assert.equal(comment.source.externalId, 'fb-comment-1');
    assert.equal(comment.source.authorChannelId, 'viewer-1');
    assert.equal(comment.source.avatarUrl, 'https://platform-lookaside.fbsbx.com/avatar');
  });

  it('fetches and normalizes comments with pagination cursors', async () => {
    let requestedUrl = '';
    const result = await fetchFacebookLiveComments({
      accessToken: ACCESS_TOKEN,
      liveVideoId: LIVE_VIDEO_ID,
      pollIntervalMs: 12_000,
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          data: [
            {
              id: 'fb-comment-1',
              message: 'First',
              created_time: '2026-07-01T20:00:00+0000',
              from: { name: 'Viewer' },
            },
            {
              id: 'empty-message',
              message: '',
              created_time: '2026-07-01T20:00:01+0000',
              from: { name: 'Viewer' },
            },
          ],
          paging: {
            cursors: {
              after: 'next-cursor',
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    assert.match(requestedUrl, /graph\.facebook\.com/);
    assert.equal(result.nextPageToken, 'next-cursor');
    assert.equal(result.pollingIntervalMillis, 12000);
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].content, 'First');
  });

  it('surfaces Facebook Graph API errors clearly', async () => {
    await assert.rejects(
      fetchFacebookLiveComments({
        accessToken: ACCESS_TOKEN,
        liveVideoId: LIVE_VIDEO_ID,
        fetchImpl: async () => new Response(JSON.stringify({
          error: { message: 'Missing permissions' },
        }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      /Missing permissions/
    );
  });
});
