import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ApiRequestError,
  buildApiUrl,
  getJson,
  postJson,
  resolveApiBaseUrl,
  resolveMediaHttpUrl,
  resolveMediaWsUrl,
  resolveWebSocketUrl,
} from '../src/utils/apiClient.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('client API configuration', () => {
  it('uses Render services as production fallbacks', () => {
    assert.equal(resolveApiBaseUrl({ PROD: true }), 'https://livestream-studio-server.onrender.com');
    assert.equal(
      resolveWebSocketUrl({ PROD: true }, { protocol: 'https:', host: 'studio.arnoldfamini.com' }),
      'wss://livestream-studio-server.onrender.com/ws'
    );
    assert.equal(
      resolveMediaWsUrl({ PROD: true }, { protocol: 'https:', host: 'studio.arnoldfamini.com' }),
      'wss://livestream-studio-media-server.onrender.com/rtmp'
    );
    assert.equal(
      resolveMediaHttpUrl({ PROD: true }, { protocol: 'https:', host: 'studio.arnoldfamini.com' }),
      'https://livestream-studio-media-server.onrender.com'
    );
  });

  it('normalizes configured URLs and local API paths', () => {
    assert.equal(resolveApiBaseUrl({ VITE_API_URL: 'https://api.example.com/' }), 'https://api.example.com');
    assert.equal(resolveMediaHttpUrl({ VITE_MEDIA_HTTP_URL: 'https://media.example.com/' }), 'https://media.example.com');
    assert.equal(buildApiUrl('/api/rooms', 'https://api.example.com/'), 'https://api.example.com/api/rooms');
    assert.equal(buildApiUrl('api/rooms', ''), '/api/rooms');
  });

  it('keeps media relay local during development', () => {
    assert.equal(
      resolveMediaWsUrl({}, { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' }),
      'ws://localhost:3002/rtmp'
    );
    assert.equal(
      resolveMediaHttpUrl({}, { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' }),
      'http://localhost:3002'
    );
  });

  it('derives the media HTTP base from configured media WebSocket URLs', () => {
    assert.equal(
      resolveMediaHttpUrl({ VITE_MEDIA_WS_URL: 'wss://media.example.com/rtmp' }),
      'https://media.example.com'
    );
    assert.equal(
      resolveMediaHttpUrl({ VITE_MEDIA_WS_URL: 'ws://localhost:3002/rtmp/' }),
      'http://localhost:3002'
    );
  });
});

describe('client API requests', () => {
  it('rejects static host HTML instead of treating it as a created room', async () => {
    globalThis.fetch = async () => new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

    await assert.rejects(
      () => getJson('/api/rooms'),
      (error) => error instanceof ApiRequestError &&
        /unexpected response/i.test(error.message) &&
        error.status === 200
    );
  });

  it('surfaces JSON API errors without leaking HTML bodies', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Too many rooms are open.' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });

    await assert.rejects(
      () => postJson('/api/rooms', { name: 'Studio', hostName: 'Arnold' }),
      (error) => error instanceof ApiRequestError &&
        error.message === 'Too many rooms are open.' &&
        error.status === 429
    );
  });

  it('times out stalled create requests', async () => {
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });

    await assert.rejects(
      () => postJson('/api/rooms', { name: 'Studio', hostName: 'Arnold' }, { timeoutMs: 5 }),
      (error) => error instanceof ApiRequestError &&
        error.timedOut &&
        /timed out/i.test(error.message)
    );
  });
});
