import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createOpenAITranscription,
  normalizeTranscriptionLanguage,
  normalizeTranscriptSegments,
  normalizeTranscriptWords,
  resolveTranscriptionMimeType,
  sanitizeTranscriptionFileName,
  supportsTranscriptWordTimestamps,
  validateTranscriptionUpload,
} from '../dist/services/transcription.js';

describe('recording transcription service', () => {
  it('sanitizes filenames and resolves supported audio MIME types', () => {
    assert.equal(sanitizeTranscriptionFileName('../bad:name.webm'), '.._bad_name.webm');
    assert.equal(resolveTranscriptionMimeType('application/octet-stream', 'host-mic.webm'), 'audio/webm');
    assert.equal(resolveTranscriptionMimeType('audio/mpeg; charset=utf-8', 'voice.mp3'), 'audio/mpeg');
  });

  it('validates upload size and supported audio formats', () => {
    assert.equal(validateTranscriptionUpload({
      byteLength: 1024,
      mimeType: 'audio/webm',
      fileName: 'host.webm',
    }), null);
    assert.match(validateTranscriptionUpload({
      byteLength: 0,
      mimeType: 'audio/webm',
      fileName: 'host.webm',
    }) || '', /Upload an audio track/);
    assert.match(validateTranscriptionUpload({
      byteLength: 26 * 1024 * 1024,
      mimeType: 'audio/webm',
      fileName: 'host.webm',
    }) || '', /under 25 MB/);
    assert.match(validateTranscriptionUpload({
      byteLength: 1024,
      mimeType: 'text/plain',
      fileName: 'notes.txt',
    }) || '', /supports/);
  });

  it('normalizes recording caption locale hints for Whisper language input', () => {
    assert.equal(normalizeTranscriptionLanguage('en-US'), 'en');
    assert.equal(normalizeTranscriptionLanguage('es'), 'es');
    assert.equal(normalizeTranscriptionLanguage('fil-PH'), undefined);
    assert.equal(normalizeTranscriptionLanguage('bad-value'), undefined);
  });

  it('builds a bounded OpenAI transcription request without leaking API keys', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedForm;
    const fetchImpl = async (url, init) => {
      capturedUrl = String(url);
      capturedAuth = init.headers.Authorization;
      capturedForm = init.body;
      return new Response(JSON.stringify({
        text: 'Welcome to the show.',
        language: 'en',
        duration: 12.5,
        words: [
          { word: 'Welcome', start: 0.2, end: 0.7 },
          { word: 'to', start: 0.7, end: 0.82 },
          { word: 'the', start: 0.82, end: 0.95 },
          { word: 'show.', start: 0.95, end: 1.4 },
        ],
        segments: [
          { id: 0, start: 0.2, end: 1.4, text: 'Welcome to the show.' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await createOpenAITranscription({
      apiKey: 'secret-key',
      buffer: Buffer.from('audio-bytes'),
      mimeType: 'audio/webm',
      fileName: 'host.webm',
      language: 'en',
      fetchImpl,
    });

    assert.equal(capturedUrl, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(capturedAuth, 'Bearer secret-key');
    assert.equal(capturedForm.get('model'), 'whisper-1');
    assert.equal(capturedForm.get('language'), 'en');
    assert.equal(capturedForm.get('response_format'), 'verbose_json');
    assert.deepEqual(capturedForm.getAll('timestamp_granularities[]'), ['word', 'segment']);
    assert.equal(capturedForm.get('file').name, 'host.webm');
    assert.deepEqual(result, {
      text: 'Welcome to the show.',
      model: 'whisper-1',
      language: 'en',
      durationSeconds: 12.5,
      words: [
        { text: 'Welcome', startSeconds: 0.2, endSeconds: 0.7 },
        { text: 'to', startSeconds: 0.7, endSeconds: 0.82 },
        { text: 'the', startSeconds: 0.82, endSeconds: 0.95 },
        { text: 'show.', startSeconds: 0.95, endSeconds: 1.4 },
      ],
      segments: [
        { text: 'Welcome to the show.', startSeconds: 0.2, endSeconds: 1.4 },
      ],
    });
  });

  it('falls back to plain JSON for models without word timestamp support', async () => {
    let capturedForm;
    const fetchImpl = async (_url, init) => {
      capturedForm = init.body;
      return new Response(JSON.stringify({ text: 'Welcome to the show.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    assert.equal(supportsTranscriptWordTimestamps('whisper-1'), true);
    assert.equal(supportsTranscriptWordTimestamps('gpt-4o-transcribe'), false);

    const result = await createOpenAITranscription({
      apiKey: 'secret-key',
      buffer: Buffer.from('audio-bytes'),
      mimeType: 'audio/webm',
      fileName: 'host.webm',
      model: 'gpt-4o-transcribe',
      fetchImpl,
    });

    assert.equal(capturedForm.get('response_format'), 'json');
    assert.deepEqual(capturedForm.getAll('timestamp_granularities[]'), []);
    assert.deepEqual(result, { text: 'Welcome to the show.', model: 'gpt-4o-transcribe' });
  });

  it('drops malformed word and segment timings instead of trusting them', () => {
    assert.deepEqual(
      normalizeTranscriptWords([
        { word: 'kept', start: 1, end: 1.5 },
        { word: '   ', start: 2, end: 2.5 },
        { word: 'backwards', start: 3, end: 2 },
        { word: 'negative', start: -1, end: 1 },
        { word: 'missing-end', start: 4 },
        'not-an-object',
      ]),
      [{ text: 'kept', startSeconds: 1, endSeconds: 1.5 }]
    );
    assert.deepEqual(normalizeTranscriptWords(undefined), []);
    assert.deepEqual(
      normalizeTranscriptSegments([{ text: 'Kept segment.', start: 0, end: 2.25 }, { text: '', start: 3, end: 4 }]),
      [{ text: 'Kept segment.', startSeconds: 0, endSeconds: 2.25 }]
    );
  });
});
