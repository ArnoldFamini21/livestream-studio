import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMediaServerParityDiagnostics,
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

  it('summarizes ready media-server parity features', () => {
    const diagnostics = buildMediaServerParityDiagnostics({
      status: 'ready',
      mediaHttpUrl: 'https://media.example.test',
      message: 'Media server ready.',
      checkedAt: 123,
      presentationRenderer: {
        ready: true,
        message: 'Exact deck renderer ready.',
      },
    });

    assert.equal(diagnostics.status, 'ready');
    assert.equal(diagnostics.actions.length, 0);
    assert.deepEqual(diagnostics.features.map((feature) => feature.status), ['ready', 'ready', 'ready', 'ready']);
    assert.match(diagnostics.features.find((feature) => feature.id === 'exact-deck-rendering')?.detail || '', /ready/i);
  });

  it('surfaces no-server media-server parity blockers with Render recovery actions', () => {
    const diagnostics = buildMediaServerParityDiagnostics({
      status: 'unavailable',
      mediaHttpUrl: 'https://media.example.test',
      message: 'Media server is not provisioned on Render.',
      checkedAt: 123,
      httpStatus: 404,
      renderRouting: 'no-server',
    });

    assert.equal(diagnostics.status, 'blocked');
    assert.deepEqual(diagnostics.features.map((feature) => feature.status), ['blocked', 'blocked', 'blocked', 'blocked']);
    assert.match(diagnostics.features.find((feature) => feature.id === 'rtmp-relay')?.detail || '', /Go Live/);
    assert.match(diagnostics.features.find((feature) => feature.id === 'mp4-export')?.detail || '', /MP4 export/);
    assert.match(diagnostics.actions.map((action) => action.label).join(' '), /livestream-studio-media-server/);
    assert.match(diagnostics.actions.map((action) => action.label).join(' '), /RENDER_MEDIA_SERVER_DEPLOY_HOOK_URL/);
  });

  it('uses environment recovery actions when the media-server URL is missing', () => {
    const diagnostics = buildMediaServerParityDiagnostics({
      status: 'unavailable',
      mediaHttpUrl: '',
      message: 'Media server URL is not configured.',
      checkedAt: 123,
    });

    assert.equal(diagnostics.status, 'blocked');
    assert.match(diagnostics.actions.map((action) => action.label).join(' '), /VITE_MEDIA_HTTP_URL/);
    assert.match(diagnostics.actions.map((action) => action.label).join(' '), /VITE_MEDIA_WS_URL/);
  });

  it('keeps relay and export ready while exact deck rendering is degraded', () => {
    const diagnostics = buildMediaServerParityDiagnostics({
      status: 'ready',
      mediaHttpUrl: 'https://media.example.test',
      message: 'Media server reachable.',
      checkedAt: 123,
      presentationRenderer: {
        ready: false,
        message: 'Exact deck renderer unavailable: LibreOffice is not ready.',
      },
    });

    assert.equal(diagnostics.status, 'degraded');
    assert.equal(diagnostics.features.find((feature) => feature.id === 'rtmp-relay')?.status, 'ready');
    assert.equal(diagnostics.features.find((feature) => feature.id === 'mp4-export')?.status, 'ready');
    assert.equal(diagnostics.features.find((feature) => feature.id === 'exact-deck-rendering')?.status, 'degraded');
    assert.match(diagnostics.actions.map((action) => action.label).join(' '), /LibreOffice and Poppler/);
  });
});
