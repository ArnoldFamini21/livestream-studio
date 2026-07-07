import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_TRANSLATION_SEGMENTS,
  buildCaptionTranslationPrompt,
  createOpenAICaptionTranslation,
  normalizeTranslationLanguage,
  normalizeTranslationSegments,
  parseCaptionTranslations,
  validateCaptionTranslationRequest,
} from '../dist/services/captionTranslation.js';

describe('caption translation service', () => {
  it('normalizes supported target languages and rejects others', () => {
    assert.equal(normalizeTranslationLanguage('es'), 'es');
    assert.equal(normalizeTranslationLanguage('es-ES'), 'es');
    assert.equal(normalizeTranslationLanguage('ZH_Hans'), 'zh');
    assert.equal(normalizeTranslationLanguage('xx'), null);
    assert.equal(normalizeTranslationLanguage(42), null);
  });

  it('validates translation requests', () => {
    assert.equal(validateCaptionTranslationRequest({
      targetLanguage: 'es',
      segments: [{ id: 0, text: 'Hello' }],
    }), null);
    assert.match(validateCaptionTranslationRequest(null) || '', /caption segments/i);
    assert.match(validateCaptionTranslationRequest({ targetLanguage: 'xx', segments: [{ id: 0, text: 'Hi' }] }) || '', /target language/i);
    assert.match(validateCaptionTranslationRequest({ targetLanguage: 'es', segments: [] }) || '', /caption segments/i);
    assert.match(validateCaptionTranslationRequest({ targetLanguage: 'es', segments: [{ id: -1, text: 'Hi' }] }) || '', /integer id/i);
    assert.match(validateCaptionTranslationRequest({ targetLanguage: 'es', segments: [{ id: 0, text: '  ' }] }) || '', /text to translate/i);
    assert.match(validateCaptionTranslationRequest({
      targetLanguage: 'es',
      segments: Array.from({ length: MAX_TRANSLATION_SEGMENTS + 1 }, (_, i) => ({ id: i, text: 'x' })),
    }) || '', /maximum/i);
  });

  it('dedupes and trims segments', () => {
    const segments = normalizeTranslationSegments([
      { id: 0, text: '  Hello  ' },
      { id: 0, text: 'Duplicate id ignored' },
      { id: 1, text: 'World' },
    ]);
    assert.deepEqual(segments, [
      { id: 0, text: 'Hello' },
      { id: 1, text: 'World' },
    ]);
  });

  it('builds a prompt naming the target language and JSON shape', () => {
    const prompt = buildCaptionTranslationPrompt([{ id: 0, text: 'Hello' }], 'es');
    assert.match(prompt, /into Spanish/);
    assert.match(prompt, /"segments"/);
    assert.match(prompt, /"id":0/);
  });

  it('parses translations, preserves order, and falls back to source text for missing ids', () => {
    const requested = [
      { id: 0, text: 'Hello' },
      { id: 1, text: 'World' },
    ];
    const parsed = parseCaptionTranslations(JSON.stringify({
      segments: [
        { id: 1, text: 'Mundo' },
        { id: 0, text: 'Hola' },
        { id: 9, text: 'ignored' },
      ],
    }), requested);
    assert.deepEqual(parsed, [
      { id: 0, text: 'Hola' },
      { id: 1, text: 'Mundo' },
    ]);
  });

  it('falls back entirely when the model output is unparseable', () => {
    const requested = [{ id: 0, text: 'Hello' }];
    assert.deepEqual(parseCaptionTranslations('not json', requested), [{ id: 0, text: 'Hello' }]);
  });

  it('requests chat completions and returns normalized translations', async () => {
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ segments: [{ id: 0, text: 'Hola' }] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await createOpenAICaptionTranslation({
      apiKey: 'sk-test',
      segments: [{ id: 0, text: 'Hello' }],
      targetLanguage: 'es',
      fetchImpl,
    });

    assert.equal(capturedBody.response_format.type, 'json_object');
    assert.equal(result.targetLanguage, 'es');
    assert.equal(result.model, 'gpt-4o-mini');
    assert.deepEqual(result.translations, [{ id: 0, text: 'Hola' }]);
  });

  it('rejects failed responses and empty content', async () => {
    await assert.rejects(
      () => createOpenAICaptionTranslation({
        apiKey: 'sk-test',
        segments: [{ id: 0, text: 'Hello' }],
        targetLanguage: 'es',
        fetchImpl: async () => new Response('{}', { status: 500 }),
      }),
      /status 500/
    );

    await assert.rejects(
      () => createOpenAICaptionTranslation({
        apiKey: 'sk-test',
        segments: [{ id: 0, text: 'Hello' }],
        targetLanguage: 'es',
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
      }),
      /did not include any content/
    );
  });
});
