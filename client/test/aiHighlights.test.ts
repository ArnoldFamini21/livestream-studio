import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  hasEnoughCaptionsForAiHighlights,
  requestAiHighlights,
} from '../src/utils/aiHighlights.ts';
import { mapAiHighlightSuggestions } from '../src/utils/clipSuggestions.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const RECORDING_START = Date.parse('2026-07-07T10:00:00.000Z');

function captionAt(offsetSeconds: number, text: string) {
  return {
    speakerName: 'Host',
    text,
    timestamp: new Date(RECORDING_START + offsetSeconds * 1000).toISOString(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mapAiHighlightSuggestions', () => {
  it('maps AI highlights into clip suggestions with the ai reason', () => {
    const suggestions = mapAiHighlightSuggestions([
      { startSeconds: 12, endSeconds: 48, title: 'Pricing reveal', reason: 'Strong answer' },
      { startSeconds: 90, endSeconds: 130, title: 'Demo moment' },
    ], 300);

    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[0].reason, 'ai');
    assert.equal(suggestions[0].label, 'Pricing reveal');
    assert.equal(suggestions[0].startSeconds, 12);
    assert.ok(suggestions[0].score > suggestions[1].score);
  });

  it('clamps ranges to the duration and drops invalid or too-short items', () => {
    const suggestions = mapAiHighlightSuggestions([
      { startSeconds: 10, endSeconds: 2000, title: 'Clamped' },
      { startSeconds: 500, endSeconds: 520, title: 'Beyond end' },
      { startSeconds: Number.NaN, endSeconds: 40, title: 'Invalid' },
      { startSeconds: 20, endSeconds: 22, title: 'Too short' },
    ], 300);

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].endSeconds, 300);
  });

  it('drops overlapping highlights preferring earlier, higher-ranked ones', () => {
    const suggestions = mapAiHighlightSuggestions([
      { startSeconds: 10, endSeconds: 60, title: 'First' },
      { startSeconds: 20, endSeconds: 70, title: 'Overlap' },
    ], 300);

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].label, 'First');
  });
});

describe('hasEnoughCaptionsForAiHighlights', () => {
  it('requires at least three final caption segments', () => {
    assert.equal(hasEnoughCaptionsForAiHighlights(undefined), false);
    assert.equal(hasEnoughCaptionsForAiHighlights([captionAt(0, 'one'), captionAt(1, 'two')]), false);
    assert.equal(
      hasEnoughCaptionsForAiHighlights([captionAt(0, 'one'), captionAt(1, 'two'), captionAt(2, 'three')]),
      true
    );
  });
});

describe('requestAiHighlights', () => {
  it('posts caption segments and maps the returned highlights', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        model: 'gpt-4o-mini',
        suggestions: [
          { startSeconds: 12, endSeconds: 48, title: 'Pricing reveal', reason: 'Strong answer' },
        ],
      });
    };

    const result = await requestAiHighlights({
      captionSegments: [
        captionAt(10, 'How does pricing work for teams?'),
        captionAt(15, 'It starts free and scales with seats.'),
        captionAt(40, 'That is a huge deal for us.'),
      ],
      durationSeconds: 120,
    });

    assert.match(capturedUrl, /\/api\/highlights$/);
    const body = capturedBody as { segments: unknown[]; durationSeconds?: number };
    assert.equal(body.segments.length, 3);
    assert.equal(body.durationSeconds, 120);
    assert.equal(result.model, 'gpt-4o-mini');
    assert.equal(result.suggestions.length, 1);
    assert.equal(result.suggestions[0].reason, 'ai');
    assert.equal(result.suggestions[0].label, 'Pricing reveal');
  });

  it('rejects before calling the server when captions are too sparse', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse({ suggestions: [] });
    };

    await assert.rejects(
      () => requestAiHighlights({ captionSegments: [captionAt(0, 'only one line')] }),
      /live captions/i
    );
    assert.equal(called, false);
  });

  it('surfaces server errors from the highlights endpoint', async () => {
    globalThis.fetch = async () => jsonResponse({ error: 'AI highlight suggestions are not configured on this server.' }, 503);

    await assert.rejects(
      () => requestAiHighlights({
        captionSegments: [
          captionAt(0, 'first line here'),
          captionAt(2, 'second line here'),
          captionAt(4, 'third line here'),
        ],
      }),
      /not configured/i
    );
  });
});
