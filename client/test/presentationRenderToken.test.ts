import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCachedTokenSource } from '../src/utils/presentationRenderToken.ts';
import {
  buildPresentationRenderHeaders,
  fetchServerPresentationPdf,
  isRecoverablePowerPointServerRenderFailure,
} from '../src/utils/presentationPreview.ts';

describe('presentation render token', () => {
  it('shares one request between concurrent callers and reuses a fresh token', async () => {
    let now = 1_000;
    let calls = 0;
    const source = createCachedTokenSource(async () => `token-${++calls}`, { reuseMs: 100, now: () => now });
    const [a, b] = await Promise.all([source(), source()]);
    assert.equal(a, 'token-1');
    assert.equal(b, 'token-1');
    now += 50;
    assert.equal(await source(), 'token-1');
    now += 100;
    assert.equal(await source(), 'token-2');
    source.clear();
    assert.equal(await source(), 'token-3');
  });

  it('resolves to undefined when signaling cannot issue a token, and asks again next time', async () => {
    let calls = 0;
    const source = createCachedTokenSource(async () => {
      calls += 1;
      throw new Error('Only hosts and co-hosts can start a live stream');
    });
    assert.equal(await source(), undefined);
    assert.equal(await source(), undefined);
    assert.equal(calls, 2);
  });

  it('sends the token as a bearer header with render requests', async () => {
    const file = { name: 'Deck.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    const withToken = await buildPresentationRenderHeaders(file, { getAuthToken: async () => 'render-token' });
    assert.equal(withToken.Authorization, 'Bearer render-token');
    assert.equal(withToken['Content-Type'], file.type);
    assert.equal(withToken['X-File-Name'], 'Deck.pptx');
    const withoutToken = await buildPresentationRenderHeaders(file, { getAuthToken: async () => { throw new Error('offline'); } });
    assert.equal(withoutToken.Authorization, undefined);
    assert.equal((await buildPresentationRenderHeaders(file)).Authorization, undefined);

    let seen = '';
    const deck = new File([new Uint8Array([1, 2, 3])], 'Deck.pptx', { type: file.type });
    const pdf = await fetchServerPresentationPdf(deck, {
      mediaHttpUrl: 'https://media.example.test',
      getAuthToken: async () => 'render-token',
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers).get('authorization') || '';
        return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }) as typeof fetch,
    });
    assert.equal(seen, 'Bearer render-token');
    assert.equal(pdf?.byteLength, 4);
  });

  it('treats a render deferred for the live show as recoverable', () => {
    assert.equal(isRecoverablePowerPointServerRenderFailure({ status: 503, code: 'PRESENTATION_RENDER_DEFERRED', message: 'busy' }), true);
    assert.equal(isRecoverablePowerPointServerRenderFailure({ status: 429, code: 'PRESENTATION_RENDER_BUSY', message: 'busy' }), true);
  });
});
