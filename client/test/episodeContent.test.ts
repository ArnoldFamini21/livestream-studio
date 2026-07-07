import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  buildEpisodeContentText,
  buildTranscriptFromCaptions,
  formatEpisodeChapterTimecode,
  hasEnoughTranscriptForEpisodeContent,
  requestEpisodeContent,
} from '../src/utils/episodeContent.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const RECORDING_START = Date.parse('2026-07-07T10:00:00.000Z');

function captionAt(offsetSeconds: number, text: string, speakerName = 'Host') {
  return {
    speakerName,
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

describe('buildTranscriptFromCaptions', () => {
  it('builds a timestamped transcript from final captions', () => {
    const transcript = buildTranscriptFromCaptions([
      captionAt(65, 'Second line', 'Guest'),
      captionAt(5, 'First line'),
      { speakerName: 'Host', text: 'interim', timestamp: new Date(RECORDING_START + 3000).toISOString(), interim: true },
    ]);
    assert.equal(transcript, '[0:00] Host: First line\n[1:00] Guest: Second line');
  });

  it('returns empty string with no usable captions', () => {
    assert.equal(buildTranscriptFromCaptions([]), '');
  });
});

describe('hasEnoughTranscriptForEpisodeContent', () => {
  it('requires at least 40 characters', () => {
    assert.equal(hasEnoughTranscriptForEpisodeContent(''), false);
    assert.equal(hasEnoughTranscriptForEpisodeContent('too short'), false);
    assert.equal(
      hasEnoughTranscriptForEpisodeContent('This transcript is definitely long enough to summarize.'),
      true
    );
  });
});

describe('formatEpisodeChapterTimecode', () => {
  it('formats chapter offsets', () => {
    assert.equal(formatEpisodeChapterTimecode(0), '0:00');
    assert.equal(formatEpisodeChapterTimecode(65), '1:05');
    assert.equal(formatEpisodeChapterTimecode(3671), '1:01:11');
  });
});

describe('buildEpisodeContentText', () => {
  it('renders a copy-ready show notes document', () => {
    const text = buildEpisodeContentText({
      titles: ['Launch Day'],
      description: 'A recap of the launch.',
      chapters: [{ seconds: 0, title: 'Intro' }, { seconds: 65, title: 'Demo' }],
      socialPosts: ['We are live!'],
      model: 'gpt-4o-mini',
    });
    assert.match(text, /# Title options\n- Launch Day/);
    assert.match(text, /# Description\nA recap of the launch\./);
    assert.match(text, /# Chapters\n0:00 Intro\n1:05 Demo/);
    assert.match(text, /# Social posts\n- We are live!/);
  });

  it('omits empty sections', () => {
    const text = buildEpisodeContentText({
      titles: [],
      description: 'Only a description.',
      chapters: [],
      socialPosts: [],
      model: 'ai',
    });
    assert.equal(text, '# Description\nOnly a description.');
  });
});

describe('requestEpisodeContent', () => {
  it('posts the transcript and normalizes the response', async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/api\/episode-content$/);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        model: 'gpt-4o-mini',
        titles: ['Launch Day', 42],
        description: 'A recap.',
        chapters: [{ seconds: 0, title: 'Intro' }, { seconds: 'bad', title: 'Skip' }],
        socialPosts: ['We are live!'],
      });
    };

    const result = await requestEpisodeContent({
      transcript: 'This is a long enough transcript to summarize for the episode content generator.',
      durationSeconds: 300,
    });

    const body = capturedBody as { transcript: string; durationSeconds?: number };
    assert.match(body.transcript, /long enough transcript/);
    assert.equal(body.durationSeconds, 300);
    assert.deepEqual(result.titles, ['Launch Day']);
    assert.equal(result.chapters.length, 1);
    assert.equal(result.socialPosts[0], 'We are live!');
  });

  it('rejects before calling the server when the transcript is too short', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return jsonResponse({});
    };

    await assert.rejects(
      () => requestEpisodeContent({ transcript: 'short' }),
      /transcript or record with captions/i
    );
    assert.equal(called, false);
  });

  it('surfaces server errors', async () => {
    globalThis.fetch = async () => jsonResponse({ error: 'AI episode content is not configured on this server.' }, 503);
    await assert.rejects(
      () => requestEpisodeContent({
        transcript: 'This is a long enough transcript to summarize for the episode content generator.',
      }),
      /not configured/i
    );
  });
});
