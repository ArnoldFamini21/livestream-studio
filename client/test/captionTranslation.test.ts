import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildTranslationRequestSegments,
  mergeTranslatedSegments,
  requestCaptionTranslation,
} from '../src/utils/captionTranslation.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function segment(id: string, text: string, interim = false) {
  return {
    id,
    speakerName: 'Host',
    text,
    interim,
    timestamp: '2026-07-07T10:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildTranslationRequestSegments', () => {
  it('indexes final, non-empty segments', () => {
    const request = buildTranslationRequestSegments([
      segment('a', 'Hello'),
      segment('b', '   ', false),
      segment('c', 'Interim', true),
      segment('d', 'World'),
    ]);
    assert.deepEqual(request, [
      { id: 0, text: 'Hello' },
      { id: 1, text: 'World' },
    ]);
  });
});

describe('mergeTranslatedSegments', () => {
  it('replaces text by index while preserving timestamps and speakers', () => {
    const source = [segment('a', 'Hello'), segment('b', 'World')];
    const merged = mergeTranslatedSegments(source, [
      { id: 0, text: 'Hola' },
      { id: 1, text: 'Mundo' },
    ]);
    assert.equal(merged[0].text, 'Hola');
    assert.equal(merged[0].speakerName, 'Host');
    assert.equal(merged[1].text, 'Mundo');
  });

  it('falls back to source text when a translation is missing', () => {
    const source = [segment('a', 'Hello'), segment('b', 'World')];
    const merged = mergeTranslatedSegments(source, [{ id: 0, text: 'Hola' }]);
    assert.equal(merged[0].text, 'Hola');
    assert.equal(merged[1].text, 'World');
  });
});

describe('requestCaptionTranslation', () => {
  it('posts indexed segments and merges the translation back', async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/api\/translate-captions$/);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        targetLanguage: 'es',
        model: 'gpt-4o-mini',
        translations: [{ id: 0, text: 'Hola' }, { id: 1, text: 'Mundo' }],
      });
    };

    const result = await requestCaptionTranslation({
      segments: [segment('a', 'Hello'), segment('b', 'World')],
      targetLanguage: 'es',
    });

    const body = capturedBody as { segments: unknown[]; targetLanguage: string };
    assert.equal(body.segments.length, 2);
    assert.equal(body.targetLanguage, 'es');
    assert.equal(result.targetLanguage, 'es');
    assert.equal(result.segments[0].text, 'Hola');
    assert.equal(result.segments[1].text, 'Mundo');
  });

  it('rejects before calling the server when there are no captions', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    await assert.rejects(
      () => requestCaptionTranslation({ segments: [segment('a', '  ', true)], targetLanguage: 'es' }),
      /before translating/i
    );
    assert.equal(called, false);
  });

  it('surfaces server errors', async () => {
    globalThis.fetch = async () => jsonResponse({ error: 'AI caption translation is not configured on this server.' }, 503);
    await assert.rejects(
      () => requestCaptionTranslation({ segments: [segment('a', 'Hello')], targetLanguage: 'es' }),
      /not configured/i
    );
  });
});
