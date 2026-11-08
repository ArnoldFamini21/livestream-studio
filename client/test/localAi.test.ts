import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLocalAiStatus,
  hasAnyLocalAi,
  loadCloudAiFallback,
  normalizeTranslatorLanguage,
  parseJsonResponse,
  promptLocalAiJson,
  saveCloudAiFallback,
  splitForQuota,
  summarizeWithLocalAi,
  translateWithLocalAi,
  type LocalAiScope,
} from '../src/utils/localAi.ts';
import {
  buildAutoChapters,
  buildDeterministicHighlights,
  buildExtractiveSummary,
  buildTimedSegmentsFromWords,
  parseTimedTranscriptLines,
  type TimedTranscriptSegment,
} from '../src/utils/autoChapters.ts';
import { requestEpisodeContent } from '../src/utils/episodeContent.ts';
import { requestAiHighlights } from '../src/utils/aiHighlights.ts';
import { requestCaptionTranslation } from '../src/utils/captionTranslation.ts';

function fakeScope(overrides: Partial<Record<'summarizer' | 'translator' | 'detector' | 'model', string>> = {}) {
  const calls: string[] = [];
  const scope: LocalAiScope = {
    Summarizer: {
      availability: async () => (overrides.summarizer || 'available') as never,
      create: async (options) => ({
        inputQuota: 1000,
        summarize: async (text: string) => {
          calls.push(`summarize:${String(options?.type)}:${text.length}`);
          return options?.type === 'headline' ? 'Launching the studio' : `Summary of ${text.length} chars.`;
        },
        destroy: () => calls.push('summarizer-destroyed'),
      }),
    },
    Translator: {
      availability: async ({ targetLanguage }) => (targetLanguage === 'xx' ? 'unavailable' : (overrides.translator || 'available')) as never,
      create: async ({ sourceLanguage, targetLanguage }) => ({
        translate: async (text: string) => `${targetLanguage}(${sourceLanguage}):${text}`,
      }),
    },
    LanguageDetector: {
      availability: async () => (overrides.detector || 'available') as never,
      create: async () => ({ detect: async () => [{ detectedLanguage: 'en', confidence: 0.9 }] }),
    },
    LanguageModel: {
      availability: async () => (overrides.model || 'available') as never,
      create: async () => ({
        inputQuota: 4000,
        prompt: async (input: string) => {
          calls.push('prompt');
          if (input.includes('Chapters')) {
            return JSON.stringify({ titles: ['A', 'B', 'C'], socialPosts: ['Post one', 'Post two'], chapterTitles: ['Welcome', 'Pricing talk'] });
          }
          return '```json\n{"highlights":[{"startSeconds":30,"endSeconds":60,"title":"Big reveal","reason":"story"}]}\n```';
        },
      }),
    },
  };
  return { scope, calls };
}

const PRICING = 'Pricing for teams starts free. Seats scale the pricing plan. Enterprise pricing includes invoices and seats.';
const HIRING = 'Hiring engineers is hard. Interview loops for engineers take weeks. Remote hiring widened the engineer pool.';

function topicTranscript(): TimedTranscriptSegment[] {
  const segments: TimedTranscriptSegment[] = [];
  for (let second = 0; second < 600; second += 10) {
    segments.push({ seconds: second, text: second < 300 ? PRICING : HIRING, speaker: second % 20 ? 'Guest' : 'Host' });
  }
  return segments;
}

describe('Chrome built-in AI detection', () => {
  it('reports unavailable when the APIs are missing and passes availability through', async () => {
    const none = await getLocalAiStatus({});
    assert.deepEqual(none, { summarizer: 'unavailable', translator: 'unavailable', languageDetector: 'unavailable', languageModel: 'unavailable' });
    assert.equal(hasAnyLocalAi(none), false);
    const { scope } = fakeScope({ model: 'downloadable' });
    const status = await getLocalAiStatus(scope);
    assert.equal(status.languageModel, 'downloadable');
    assert.equal(hasAnyLocalAi(status), true);
    const throwing = await getLocalAiStatus({ Summarizer: { availability: async () => { throw new Error('policy'); }, create: async () => { throw new Error('x'); } } });
    assert.equal(throwing.summarizer, 'unavailable');
  });

  it('summarizes long text in quota-sized pieces and cleans up', async () => {
    const { scope, calls } = fakeScope();
    const text = Array.from({ length: 150 }, (_, index) => `Sentence number ${index} talks about the launch.`).join(' ');
    const summary = await summarizeWithLocalAi(text, { type: 'tldr' }, scope);
    assert.match(summary || '', /^Summary of/);
    assert.ok(calls.filter((call) => call.startsWith('summarize:tldr')).length > 2, 'pieces were summarized first');
    assert.ok(calls.includes('summarizer-destroyed'));
    assert.equal(await summarizeWithLocalAi(text, { type: 'tldr' }, {}), null);
  });

  it('parses fenced JSON from the Prompt API and translates with detected source', async () => {
    const { scope } = fakeScope();
    const answer = await promptLocalAiJson<{ highlights: unknown[] }>('sys', 'pick', {}, scope);
    assert.equal(answer?.highlights.length, 1);
    assert.equal(parseJsonResponse('nope'), null);
    assert.deepEqual(parseJsonResponse('text {"a":1} tail'), { a: 1 });
    assert.deepEqual(await translateWithLocalAi(['Hello', ''], 'es', {}, scope), ['es(en):Hello', '']);
    assert.equal(await translateWithLocalAi(['Hello'], 'xx', {}, scope), null);
    assert.deepEqual(await translateWithLocalAi(['Hello'], 'en', { sourceLanguage: 'en-US' }, scope), ['Hello']);
    assert.equal(normalizeTranslatorLanguage('zh-TW'), 'zh-Hant');
    assert.equal(normalizeTranslatorLanguage('fil-PH'), 'fil');
    assert.deepEqual(splitForQuota('a. b. c.', 100), ['a. b. c.']);
    assert.ok(splitForQuota('x'.repeat(250), 100).every((piece) => piece.length <= 100));
  });

  it('remembers the cloud fallback opt-in', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
    assert.equal(loadCloudAiFallback(storage), false);
    saveCloudAiFallback(true, storage);
    assert.equal(loadCloudAiFallback(storage), true);
  });
});

describe('offline topic heuristics', () => {
  it('starts a chapter where the vocabulary changes and honors markers', () => {
    const chapters = buildAutoChapters(topicTranscript(), [{ seconds: 120, label: 'Listener question' }], 600);
    assert.equal(chapters[0].seconds, 0);
    assert.ok(chapters.some((chapter) => chapter.seconds === 120 && chapter.title === 'Listener question'));
    const shift = chapters.find((chapter) => Math.abs(chapter.seconds - 300) <= 45);
    assert.ok(shift, `expected a chapter near 5:00, got ${JSON.stringify(chapters.map((c) => [c.seconds, c.title]))}`);
    assert.match(shift!.title.toLowerCase(), /hir|engineer|interview/);
    assert.match(chapters[0].title.toLowerCase(), /pric|seat|team/);
    for (let index = 1; index < chapters.length; index += 1) assert.ok(chapters[index].seconds > chapters[index - 1].seconds);
  });

  it('falls back to marker chapters without speech', () => {
    assert.deepEqual(
      buildAutoChapters([], [{ seconds: 90, label: 'Demo' }], 300).map(({ seconds, title }) => [seconds, title]),
      [[0, 'Intro'], [90, 'Demo']]
    );
  });

  it('extracts topical sentences, groups words and parses timed lines', () => {
    const summary = buildExtractiveSummary(`${PRICING} ${HIRING} The weather was fine today and we said hello again.`, 2);
    assert.equal(summary.length, 2);
    assert.ok(summary.every((sentence) => !/weather/.test(sentence)));
    const segments = buildTimedSegmentsFromWords([
      { word: 'Hello', start: 0, end: 0.3 }, { word: 'there.', start: 0.3, end: 0.6 },
      { word: 'Next', start: 3, end: 3.2 }, { word: 'idea', start: 3.2, end: 3.5 },
    ]);
    assert.deepEqual(segments, [{ seconds: 0, text: 'Hello there.' }, { seconds: 3, text: 'Next idea' }]);
    assert.deepEqual(parseTimedTranscriptLines('[0:05] Host: Hi there\n[1:02:03] Guest: Later\nnoise'), [
      { seconds: 5, text: 'Hi there', speaker: 'Host' },
      { seconds: 3723, text: 'Later', speaker: 'Guest' },
    ]);
  });

  it('ranks distinctive, lively windows as highlights without overlap', () => {
    const segments = topicTranscript();
    segments.push({ seconds: 455, text: 'What was the biggest mistake you made hiring? That story changed everything!', speaker: 'Host' });
    const highlights = buildDeterministicHighlights(segments, 600, 3);
    assert.ok(highlights.length >= 1);
    for (const a of highlights) {
      for (const b of highlights) {
        if (a !== b) assert.ok(a.endSeconds <= b.startSeconds || b.endSeconds <= a.startSeconds);
      }
    }
    assert.ok(highlights[0].startSeconds <= 455 && highlights[0].endSeconds > 455, 'the question window ranks first');
  });
});

describe('free-first AI orchestration', () => {
  const transcript = topicTranscript().map((segment) => `[${Math.floor(segment.seconds / 60)}:${String(segment.seconds % 60).padStart(2, '0')}] ${segment.speaker}: ${segment.text}`).join('\n');

  it('writes show notes on the device when built-in AI is available', async () => {
    const { scope } = fakeScope();
    let cloudCalled = false;
    const result = await requestEpisodeContent({
      transcript,
      durationSeconds: 600,
      localAi: scope,
      cloudFallback: true,
      requestCloud: async () => { cloudCalled = true; throw new Error('no'); },
    });
    assert.equal(cloudCalled, false);
    assert.equal(result.engine, 'on-device');
    assert.deepEqual(result.titles, ['A', 'B', 'C']);
    assert.equal(result.chapters[0].title, 'Welcome');
    assert.match(result.description, /^Summary of/);
  });

  it('uses the server only when opted in, and the offline notes otherwise', async () => {
    let cloudCalled = false;
    const cloud = await requestEpisodeContent({
      transcript,
      localAi: {},
      cloudFallback: true,
      requestCloud: async () => {
        cloudCalled = true;
        return { titles: ['Cloud'], description: 'd', chapters: [], socialPosts: [], model: 'gpt', engine: 'cloud' };
      },
    });
    assert.ok(cloudCalled);
    assert.equal(cloud.engine, 'cloud');
    assert.ok(cloud.chapters.length > 0, 'offline chapters fill in when the server returns none');

    const offline = await requestEpisodeContent({ transcript, durationSeconds: 600, localAi: {}, cloudFallback: false });
    assert.equal(offline.engine, 'offline');
    assert.ok(offline.description.length > 20);
    assert.ok(offline.chapters.length >= 2);
    assert.match(offline.notice || '', /desktop Chrome/);
  });

  it('picks highlights on the device, then falls back offline', async () => {
    const captionSegments = topicTranscript().map((segment) => ({
      speakerName: segment.speaker,
      text: segment.text,
      timestamp: new Date(Date.UTC(2026, 0, 1) + segment.seconds * 1000).toISOString(),
    }));
    const { scope } = fakeScope();
    const local = await requestAiHighlights({ captionSegments, durationSeconds: 600, localAi: scope });
    assert.equal(local.engine, 'on-device');
    assert.equal(local.suggestions[0].label, 'Big reveal');
    const offline = await requestAiHighlights({ captionSegments, durationSeconds: 600, localAi: {}, cloudFallback: false });
    assert.equal(offline.engine, 'offline');
    assert.ok(offline.suggestions.length > 0);
    assert.match(offline.notice || '', /without an AI model/);
  });

  it('translates captions on the device and explains when it cannot', async () => {
    const segments = [{ id: '1', speakerName: 'Host', text: 'Hello', interim: false, timestamp: new Date().toISOString() }];
    const { scope } = fakeScope();
    const result = await requestCaptionTranslation({ segments, targetLanguage: 'es', sourceLanguage: 'en-US', localAi: scope });
    assert.equal(result.segments[0].text, 'es(en):Hello');
    await assert.rejects(
      requestCaptionTranslation({ segments, targetLanguage: 'es', localAi: {}, cloudFallback: false }),
      /desktop Chrome/
    );
  });
});
