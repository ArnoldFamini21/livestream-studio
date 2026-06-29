import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createOpenAITranscription,
  normalizeTranscriptionLanguage,
  resolveTranscriptionMimeType,
  sanitizeTranscriptionFileName,
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
    assert.equal(capturedForm.get('response_format'), 'json');
    assert.equal(capturedForm.get('file').name, 'host.webm');
    assert.deepEqual(result, {
      text: 'Welcome to the show.',
      model: 'whisper-1',
      language: 'en',
      durationSeconds: 12.5,
    });
  });
});
