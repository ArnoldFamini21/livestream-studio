import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_HIGHLIGHT_SEGMENTS,
  buildHighlightPrompt,
  createOpenAIHighlightSuggestions,
  normalizeHighlightSegments,
  parseHighlightSuggestions,
  validateHighlightSuggestionRequest,
} from '../dist/services/highlightSuggestions.js';

describe('highlight suggestion service', () => {
  it('validates highlight suggestion requests', () => {
    assert.equal(validateHighlightSuggestionRequest({
      segments: [{ seconds: 0, text: 'Welcome to the show' }],
    }), null);
    assert.equal(validateHighlightSuggestionRequest({
      segments: [{ seconds: 10, text: 'Big announcement' }],
      durationSeconds: 120,
    }), null);
    assert.match(validateHighlightSuggestionRequest(null) || '', /caption segments/i);
    assert.match(validateHighlightSuggestionRequest({ segments: [] }) || '', /caption segments/i);
    assert.match(validateHighlightSuggestionRequest({
      segments: [{ seconds: -1, text: 'bad' }],
    }) || '', /non-negative/i);
    assert.match(validateHighlightSuggestionRequest({
      segments: [{ seconds: 1, text: '   ' }],
    }) || '', /transcript text/i);
    assert.match(validateHighlightSuggestionRequest({
      segments: [{ seconds: 1, text: 'ok' }],
      durationSeconds: -5,
    }) || '', /durationSeconds/);
    assert.match(validateHighlightSuggestionRequest({
      segments: Array.from({ length: MAX_HIGHLIGHT_SEGMENTS + 1 }, (_, i) => ({ seconds: i, text: 'x' })),
    }) || '', /maximum/i);
  });

  it('normalizes, sorts, and bounds caption segments', () => {
    const normalized = normalizeHighlightSegments([
      { seconds: 30.123, text: '  second   line ', speaker: '  Guest ' },
      { seconds: 5, text: 'first line' },
      { seconds: 10, text: '   ' },
    ]);
    assert.equal(normalized.length, 2);
    assert.deepEqual(normalized[0], { seconds: 5, text: 'first line' });
    assert.equal(normalized[1].seconds, 30.1);
    assert.equal(normalized[1].text, 'second line');
    assert.equal(normalized[1].speaker, 'Guest');
  });

  it('builds a timestamped transcript prompt', () => {
    const prompt = buildHighlightPrompt([
      { seconds: 5, text: 'Welcome everyone', speaker: 'Host' },
      { seconds: 65, text: 'Big reveal now' },
    ], 300);
    assert.match(prompt, /\[0:05\] Host: Welcome everyone/);
    assert.match(prompt, /\[1:05\] Speaker: Big reveal now/);
    assert.match(prompt, /300 seconds long/);
  });

  it('parses model responses with highlight arrays or wrapped objects', () => {
    const wrapped = parseHighlightSuggestions(JSON.stringify({
      highlights: [
        { startSeconds: 10, endSeconds: 40, title: 'Launch reveal', reason: 'Announcement' },
      ],
    }), 300);
    assert.equal(wrapped.length, 1);
    assert.equal(wrapped[0].title, 'Launch reveal');

    const bare = parseHighlightSuggestions('```json\n[{"startSeconds": 0, "endSeconds": 30, "title": "Intro"}]\n```', 300);
    assert.equal(bare.length, 1);
    assert.equal(bare[0].reason, '');
  });

  it('clamps, filters, and caps parsed suggestions', () => {
    const parsed = parseHighlightSuggestions(JSON.stringify({
      highlights: [
        { startSeconds: 10, endSeconds: 12, title: 'Too short' },
        { startSeconds: 350, endSeconds: 380, title: 'Beyond the end' },
        { startSeconds: 20, endSeconds: 2000, title: 'Too long gets clamped' },
        { startSeconds: 'bad', endSeconds: 50, title: 'Invalid' },
        { startSeconds: 25, endSeconds: 55, title: 'Overlaps the clamped one' },
      ],
    }), 300);

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].startSeconds, 20);
    assert.equal(parsed[0].endSeconds, 300);
    assert.equal(parsed[0].title, 'Too long gets clamped');
  });

  it('returns nothing for unparseable model output', () => {
    assert.deepEqual(parseHighlightSuggestions('not json at all', 300), []);
  });

  it('requests chat completions with JSON response format and parses suggestions', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = String(url);
      capturedAuth = init.headers.Authorization;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              highlights: [
                { startSeconds: 12, endSeconds: 48, title: 'Pricing question', reason: 'Strong Q&A moment' },
              ],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await createOpenAIHighlightSuggestions({
      apiKey: 'sk-test',
      segments: [
        { seconds: 10, text: 'How does pricing work?', speaker: 'Guest' },
        { seconds: 15, text: 'Great question, it starts free.' },
      ],
      durationSeconds: 120,
      fetchImpl,
    });

    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(capturedAuth, 'Bearer sk-test');
    assert.equal(capturedBody.model, 'gpt-4o-mini');
    assert.equal(capturedBody.response_format.type, 'json_object');
    assert.match(capturedBody.messages[1].content, /\[0:10\] Guest: How does pricing work\?/);
    assert.equal(result.model, 'gpt-4o-mini');
    assert.equal(result.suggestions.length, 1);
    assert.deepEqual(result.suggestions[0], {
      startSeconds: 12,
      endSeconds: 48,
      title: 'Pricing question',
      reason: 'Strong Q&A moment',
    });
  });

  it('rejects failed OpenAI responses and empty content', async () => {
    await assert.rejects(
      () => createOpenAIHighlightSuggestions({
        apiKey: 'sk-test',
        segments: [{ seconds: 0, text: 'hello there' }],
        fetchImpl: async () => new Response('{}', { status: 429 }),
      }),
      /status 429/
    );

    await assert.rejects(
      () => createOpenAIHighlightSuggestions({
        apiKey: 'sk-test',
        segments: [{ seconds: 0, text: 'hello there' }],
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
      }),
      /did not include suggestions/
    );
  });
});
