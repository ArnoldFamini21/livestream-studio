import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildInitialMediaServerHealth,
  checkMediaServerHealth,
  normalizeMediaServerHealthPayload,
} from '../src/utils/mediaServerHealth.ts';

describe('media-server health readiness', () => {
  it('builds an initial checking state from the configured media URL', () => {
    const health = buildInitialMediaServerHealth('https://media.example.test/');

    assert.deepEqual(health, {
      status: 'checking',
      mediaHttpUrl: 'https://media.example.test',
      message: 'Checking media-server readiness...',
      checkedAt: null,
    });
  });

  it('accepts current media-server health metadata', () => {
    const health = normalizeMediaServerHealthPayload({
      status: 'ok',
      service: 'media-server',
      version: '1.0.0',
      commit: '99f15fb',
      environment: 'production',
      capabilities: {
        presentationRenderer: {
          ready: true,
          message: 'Exact deck renderer ready.',
          details: {
            dependencies: [
              { name: 'LibreOffice', ready: true },
              { name: 'Poppler pdftoppm', ready: true },
            ],
          },
        },
      },
    }, {
      mediaHttpUrl: 'https://media.example.test',
      checkedAt: 123,
      httpStatus: 200,
    });

    assert.equal(health.status, 'ready');
    assert.equal(health.mediaHttpUrl, 'https://media.example.test');
    assert.equal(health.service, 'media-server');
    assert.equal(health.version, '1.0.0');
    assert.equal(health.commit, '99f15fb');
    assert.equal(health.environment, 'production');
    assert.equal(health.httpStatus, 200);
    assert.equal(health.presentationRenderer?.ready, true);
    assert.equal(health.presentationRenderer?.message, 'Exact deck renderer ready.');
    assert.match(health.message, /RTMP relay/);
  });

  it('keeps the media server ready while surfacing degraded exact deck rendering', () => {
    const health = normalizeMediaServerHealthPayload({
      status: 'ok',
      service: 'media-server',
      capabilities: {
        presentationRenderer: {
          ready: false,
          message: 'Exact deck renderer unavailable: LibreOffice is not ready.',
        },
      },
    }, {
      mediaHttpUrl: 'https://media.example.test',
      checkedAt: 321,
      httpStatus: 200,
    });

    assert.equal(health.status, 'ready');
    assert.equal(health.presentationRenderer?.ready, false);
    assert.match(health.message, /Exact deck rendering is unavailable/);
  });

  it('treats media-server health without renderer capability metadata as deck-render degraded', () => {
    const health = normalizeMediaServerHealthPayload({
      status: 'ok',
      service: 'media-server',
    }, {
      mediaHttpUrl: 'https://media.example.test',
      checkedAt: 654,
      httpStatus: 200,
    });

    assert.equal(health.status, 'ready');
    assert.equal(health.presentationRenderer?.ready, false);
    assert.match(health.presentationRenderer?.message || '', /older deployment/);
  });

  it('rejects stale health responses without service metadata', () => {
    const health = normalizeMediaServerHealthPayload({
      status: 'ok',
    }, {
      mediaHttpUrl: 'https://media.example.test',
      checkedAt: 456,
      httpStatus: 200,
    });

    assert.equal(health.status, 'unavailable');
    assert.equal(health.httpStatus, 200);
    assert.match(health.message, /older deployment/i);
  });

  it('reports Render no-server routing as a provisioning problem', async () => {
    const health = await checkMediaServerHealth({
      mediaHttpUrl: 'https://media.example.test/',
      nowMs: 789,
      fetchImpl: async (url, init) => {
        assert.equal(String(url), 'https://media.example.test/health');
        assert.equal(init?.method, 'GET');
        return new Response('Not Found\n', {
          status: 404,
          headers: {
            'x-render-routing': 'no-server',
          },
        });
      },
    });

    assert.equal(health.status, 'unavailable');
    assert.equal(health.httpStatus, 404);
    assert.equal(health.renderRouting, 'no-server');
    assert.match(health.message, /not provisioned on Render/);
  });

  it('surfaces media-server JSON error messages', async () => {
    const health = await checkMediaServerHealth({
      mediaHttpUrl: 'https://media.example.test',
      nowMs: 101,
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'service warming up',
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    assert.equal(health.status, 'unavailable');
    assert.equal(health.httpStatus, 503);
    assert.equal(health.message, 'service warming up');
  });

  it('reports a missing media URL before fetching', async () => {
    let fetched = false;
    const health = await checkMediaServerHealth({
      mediaHttpUrl: '',
      nowMs: 202,
      fetchImpl: async () => {
        fetched = true;
        return new Response('{}');
      },
    });

    assert.equal(fetched, false);
    assert.equal(health.status, 'unavailable');
    assert.match(health.message, /not configured/);
  });
});
