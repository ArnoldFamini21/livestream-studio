import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_EPISODE_TRANSCRIPT_CHARS,
  buildEpisodeContentPrompt,
  createOpenAIEpisodeContent,
  normalizeEpisodeTranscript,
  parseEpisodeContent,
  validateEpisodeContentRequest,
} from '../dist/services/episodeContent.js';

describe('episode content service', () => {
  it('validates episode content requests', () => {
    assert.equal(validateEpisodeContentRequest({
      transcript: 'This is a long enough transcript to summarize for show notes.',
    }), null);
    assert.match(validateEpisodeContentRequest(null) || '', /transcript/i);
    assert.match(validateEpisodeContentRequest({ transcript: 'too short' }) || '', /at least 40/i);
    assert.match(validateEpisodeContentRequest({
      transcript: 'This is a long enough transcript to summarize for show notes.',
      durationSeconds: -5,
    }) || '', /durationSeconds/);
  });

  it('normalizes and bounds the transcript', () => {
    assert.equal(normalizeEpisodeTranscript('  hello world  '), 'hello world');
    const long = 'a'.repeat(MAX_EPISODE_TRANSCRIPT_CHARS + 500);
    assert.equal(normalizeEpisodeTranscript(long).length, MAX_EPISODE_TRANSCRIPT_CHARS);
  });

  it('builds a prompt with a duration hint', () => {
    const prompt = buildEpisodeContentPrompt('Welcome to the show, today we discuss launches.', 600);
    assert.match(prompt, /Welcome to the show/);
    assert.match(prompt, /about 10 minutes long/);
  });

  it('parses titles, description, chapters, and social posts', () => {
    const parsed = parseEpisodeContent(JSON.stringify({
      titles: ['How We Shipped Live Clips', '  ', 'Behind the Studio Rebuild'],
      description: '  A deep dive into building a live studio.  ',
      chapters: [
        { seconds: 65, title: 'Intro' },
        { seconds: 5, title: 'Cold open' },
        { seconds: 5, title: 'Duplicate second' },
        { seconds: 90, title: '   ' },
      ],
      socialPosts: ['We just shipped clips! 🎬', 'New episode is live.'],
    }), 300);

    assert.deepEqual(parsed.titles, ['How We Shipped Live Clips', 'Behind the Studio Rebuild']);
    assert.equal(parsed.description, 'A deep dive into building a live studio.');
    assert.deepEqual(parsed.chapters, [
      { seconds: 5, title: 'Cold open' },
      { seconds: 65, title: 'Intro' },
    ]);
    assert.equal(parsed.socialPosts.length, 2);
  });

  it('drops chapters beyond the recording duration', () => {
    const parsed = parseEpisodeContent(JSON.stringify({
      chapters: [
        { seconds: 30, title: 'Valid' },
        { seconds: 5000, title: 'Beyond the end' },
      ],
    }), 300);
    assert.equal(parsed.chapters.length, 1);
    assert.equal(parsed.chapters[0].title, 'Valid');
  });

  it('returns empty fields for unparseable output', () => {
    const parsed = parseEpisodeContent('not json', 300);
    assert.deepEqual(parsed.titles, []);
    assert.equal(parsed.description, '');
    assert.deepEqual(parsed.chapters, []);
    assert.deepEqual(parsed.socialPosts, []);
  });

  it('requests chat completions with JSON format and parses the response', async () => {
    let capturedUrl = '';
    let capturedBody = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              titles: ['Building a Live Studio'],
              description: 'How we built browser-native clips.',
              chapters: [{ seconds: 0, title: 'Welcome' }],
              socialPosts: ['New episode out now!'],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await createOpenAIEpisodeContent({
      apiKey: 'sk-test',
      transcript: 'Welcome to the show. Today we built browser-native clips for the studio.',
      durationSeconds: 300,
      fetchImpl,
    });

    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(capturedBody.response_format.type, 'json_object');
    assert.equal(result.model, 'gpt-4o-mini');
    assert.deepEqual(result.titles, ['Building a Live Studio']);
    assert.equal(result.chapters[0].title, 'Welcome');
    assert.equal(result.socialPosts[0], 'New episode out now!');
  });

  it('rejects failed responses and empty content', async () => {
    await assert.rejects(
      () => createOpenAIEpisodeContent({
        apiKey: 'sk-test',
        transcript: 'This transcript is long enough to summarize for the show notes generator.',
        fetchImpl: async () => new Response('{}', { status: 500 }),
      }),
      /status 500/
    );

    await assert.rejects(
      () => createOpenAIEpisodeContent({
        apiKey: 'sk-test',
        transcript: 'This transcript is long enough to summarize for the show notes generator.',
        fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
      }),
      /did not include any content/
    );
  });
});
