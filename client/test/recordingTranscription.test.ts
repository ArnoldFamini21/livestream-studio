import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isRecordingTranscriptionCandidate,
  parseTranscriptTimedText,
  requestRecordingTranscription,
  selectRecordingTranscriptionCandidate,
} from '../src/utils/recordingTranscription.ts';

describe('recording transcription client helpers', () => {
  it('prefers isolated audio tracks for transcription', () => {
    const video = {
      label: 'Host camera',
      fileName: 'host-camera.webm',
      blob: new Blob(['video'], { type: 'video/webm' }),
      kind: 'video' as const,
    };
    const audio = {
      label: 'Host mic',
      fileName: 'host-mic.webm',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      kind: 'audio' as const,
    };

    assert.equal(isRecordingTranscriptionCandidate(video), false);
    assert.equal(isRecordingTranscriptionCandidate(audio), true);
    assert.equal(selectRecordingTranscriptionCandidate([video, audio]), audio);
  });

  it('accepts audio-like filenames when MIME metadata is missing', () => {
    const file = {
      label: 'Guest audio',
      fileName: 'guest-track.webm',
      blob: new Blob(['audio'], { type: '' }),
    };

    assert.equal(isRecordingTranscriptionCandidate(file), true);
    assert.equal(selectRecordingTranscriptionCandidate([file]), file);
  });

  it('posts audio bytes to the transcription API and returns normalized metadata', async () => {
    const file = {
      label: 'Host mic',
      fileName: 'host-mic.webm',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      kind: 'audio' as const,
    };
    let capturedUrl = '';
    let capturedInit;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        text: ' Welcome to the show. ',
        model: 'whisper-1',
        language: 'en',
        durationSeconds: 9,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await requestRecordingTranscription(file, 'en-US', fetchImpl as typeof fetch);

    assert.equal(capturedUrl, '/api/transcriptions');
    assert.equal(capturedInit?.method, 'POST');
    assert.equal((capturedInit?.headers as Record<string, string>)['Content-Type'], 'audio/webm');
    assert.equal((capturedInit?.headers as Record<string, string>)['X-File-Name'], 'host-mic.webm');
    assert.equal((capturedInit?.headers as Record<string, string>)['X-Transcription-Language'], 'en-US');
    assert.equal(capturedInit?.body, file.blob);
    assert.equal(result.text, 'Welcome to the show.');
    assert.equal(result.model, 'whisper-1');
    assert.equal(result.language, 'en');
    assert.equal(result.durationSeconds, 9);
    assert.equal(result.sourceFileName, 'host-mic.webm');
    assert.equal(result.sourceLabel, 'Host mic');
    assert.match(result.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps word and segment timings when the model returns them', async () => {
    const file = {
      label: 'Host mic',
      fileName: 'host-mic.webm',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      kind: 'audio' as const,
    };
    const fetchImpl = async () => new Response(JSON.stringify({
      text: 'Welcome to the show.',
      model: 'whisper-1',
      words: [
        { text: 'Welcome', startSeconds: 0.2, endSeconds: 0.7 },
        { text: 'to', startSeconds: 0.7, endSeconds: 0.82 },
        { text: 'bad', startSeconds: 3, endSeconds: 1 },
      ],
      segments: [{ text: 'Welcome to the show.', startSeconds: 0.2, endSeconds: 1.4 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const result = await requestRecordingTranscription(file, undefined, fetchImpl as typeof fetch);

    assert.deepEqual(result.words, [
      { text: 'Welcome', startSeconds: 0.2, endSeconds: 0.7 },
      { text: 'to', startSeconds: 0.7, endSeconds: 0.82 },
    ]);
    assert.deepEqual(result.segments, [{ text: 'Welcome to the show.', startSeconds: 0.2, endSeconds: 1.4 }]);
  });

  it('omits word timings entirely when the model returns none', async () => {
    const file = {
      label: 'Host mic',
      fileName: 'host-mic.webm',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      kind: 'audio' as const,
    };
    const fetchImpl = async () => new Response(JSON.stringify({
      text: 'Welcome to the show.',
      model: 'gpt-4o-transcribe',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const result = await requestRecordingTranscription(file, undefined, fetchImpl as typeof fetch);

    assert.equal(result.words, undefined);
    assert.equal(result.segments, undefined);
    assert.deepEqual(parseTranscriptTimedText(null), []);
  });

  it('surfaces transcription API errors', async () => {
    const file = {
      label: 'Host mic',
      fileName: 'host-mic.webm',
      blob: new Blob(['audio'], { type: 'audio/webm' }),
      kind: 'audio' as const,
    };
    const fetchImpl = async () => new Response(JSON.stringify({
      error: 'Transcription is not configured on this server.',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      requestRecordingTranscription(file, 'en-US', fetchImpl as typeof fetch),
      /not configured/
    );
  });
});
