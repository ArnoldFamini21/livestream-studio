import { ApiRequestError, postJson } from './apiClient.ts';
import { accountHeaders } from './accountAuth.ts';
import {
  buildAutoChapters,
  buildExtractiveSummary,
  buildKeywordTitle,
  parseTimedTranscriptLines,
  type AutoChapterMarker,
  type TimedTranscriptSegment,
} from './autoChapters.ts';
import {
  LOCAL_AI_REQUIREMENT_NOTE,
  getLocalAiStatus,
  loadCloudAiFallback,
  promptLocalAiJson,
  summarizeWithLocalAi,
  type LocalAiScope,
} from './localAi.ts';

const EPISODE_CONTENT_TIMEOUT_MS = 60_000;
const MIN_TRANSCRIPT_CHARS = 40;
const MAX_TRANSCRIPT_CHARS = 24_000;

export interface EpisodeContentChapter {
  seconds: number;
  title: string;
}

export interface EpisodeContentResult {
  titles: string[];
  description: string;
  chapters: EpisodeContentChapter[];
  socialPosts: string[];
  model: string;
  /** Where the notes came from: Chrome built-in AI, the studio server, or the offline heuristics. */
  engine?: EpisodeContentEngine;
  /** Shown under the notes, e.g. why the offline fallback was used. */
  notice?: string;
}

export type EpisodeContentEngine = 'on-device' | 'cloud' | 'offline';

export interface EpisodeContentCaptionSegment {
  speakerName?: string;
  text: string;
  timestamp: string;
  interim?: boolean;
}

export function buildTranscriptFromCaptions(segments: EpisodeContentCaptionSegment[]): string {
  const finals = segments
    .filter((segment) => segment && !segment.interim && typeof segment.text === 'string' && segment.text.trim())
    .map((segment) => ({ segment, timeMs: Date.parse(segment.timestamp) }))
    .filter((entry) => Number.isFinite(entry.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
  if (finals.length === 0) return '';
  const originMs = finals[0].timeMs;
  return finals
    .map((entry) => {
      const offset = Math.max(0, Math.round((entry.timeMs - originMs) / 1000));
      const m = Math.floor(offset / 60);
      const s = offset % 60;
      const speaker = entry.segment.speakerName?.trim() || 'Speaker';
      return `[${m}:${String(s).padStart(2, '0')}] ${speaker}: ${entry.segment.text.trim()}`;
    })
    .join('\n');
}

export function hasEnoughTranscriptForEpisodeContent(transcript: string | undefined | null): boolean {
  return Boolean(transcript && transcript.trim().length >= MIN_TRANSCRIPT_CHARS);
}

export interface RequestEpisodeContentInput {
  transcript: string;
  durationSeconds?: number | null;
  /** Timed lines for chapters; parsed from "[m:ss] Speaker: text" transcripts when omitted. */
  timedSegments?: TimedTranscriptSegment[];
  markers?: AutoChapterMarker[];
  /** Use the server route when on-device AI is unavailable (defaults to the saved preference). */
  cloudFallback?: boolean;
  /** Test seams. */
  localAi?: LocalAiScope;
  requestCloud?: (input: RequestEpisodeContentInput) => Promise<EpisodeContentResult>;
}

/** The studio server route (OpenAI). Used only when the owner opted into the cloud fallback. */
export async function requestCloudEpisodeContent(
  input: RequestEpisodeContentInput
): Promise<EpisodeContentResult> {
  const transcript = (input.transcript || '').trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new ApiRequestError('Generate a transcript or record with captions to create show notes.');
  }

  const data = await postJson<Partial<EpisodeContentResult>>(
    '/api/episode-content',
    {
      transcript,
      ...(Number.isFinite(input.durationSeconds) && (input.durationSeconds as number) > 0
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
    { timeoutMs: EPISODE_CONTENT_TIMEOUT_MS, credentials: 'include', headers: accountHeaders() }
  );

  return {
    titles: Array.isArray(data.titles) ? data.titles.filter((title): title is string => typeof title === 'string') : [],
    description: typeof data.description === 'string' ? data.description : '',
    chapters: Array.isArray(data.chapters)
      ? data.chapters.filter((chapter): chapter is EpisodeContentChapter => (
          Boolean(chapter) && typeof chapter.seconds === 'number' && typeof chapter.title === 'string'
        ))
      : [],
    socialPosts: Array.isArray(data.socialPosts)
      ? data.socialPosts.filter((post): post is string => typeof post === 'string')
      : [],
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : 'ai',
    engine: 'cloud',
  };
}

/**
 * Show notes, free first: Chrome built-in AI on this computer, then the
 * studio server (only when the owner opted in because they set an OpenAI
 * key), then offline heuristics (topic-shift chapters and an extractive
 * summary), so the button always produces something.
 */
export async function requestEpisodeContent(
  input: RequestEpisodeContentInput
): Promise<EpisodeContentResult> {
  const transcript = (input.transcript || '').trim();
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new ApiRequestError('Generate a transcript or record with captions to create show notes.');
  }
  const timedSegments = input.timedSegments?.length ? input.timedSegments : parseTimedTranscriptLines(transcript);
  const markers = input.markers || [];
  const durationSeconds = Number.isFinite(input.durationSeconds) && (input.durationSeconds as number) > 0
    ? input.durationSeconds as number
    : null;
  const chapters = buildAutoChapters(timedSegments, markers, durationSeconds);
  const problems: string[] = [];

  try {
    const local = await generateEpisodeContentOnDevice(transcript, chapters, input.localAi);
    if (local) return local;
  } catch (err) {
    problems.push(`On-device AI failed (${err instanceof Error ? err.message : 'unknown error'}).`);
  }

  const cloudFallback = input.cloudFallback ?? loadCloudAiFallback();
  if (cloudFallback) {
    try {
      const cloud = await (input.requestCloud || requestCloudEpisodeContent)({ ...input, transcript });
      return cloud.chapters.length > 0 ? cloud : { ...cloud, chapters: chapters.map(({ seconds, title }) => ({ seconds, title })) };
    } catch (err) {
      problems.push(`Studio server AI failed (${err instanceof Error ? err.message : 'unknown error'}).`);
    }
  }

  return buildOfflineEpisodeContent(transcript, chapters, [...problems, LOCAL_AI_REQUIREMENT_NOTE].join(' '));
}

/** Show notes from the transcript alone: chapters from topic shifts and the most topical sentences. */
export function buildOfflineEpisodeContent(
  transcript: string,
  chapters: Array<{ seconds: number; title: string }>,
  notice?: string
): EpisodeContentResult {
  const summary = buildExtractiveSummary(transcript, 3);
  const keyword = buildKeywordTitle(transcript);
  return {
    titles: [keyword, ...(chapters.length > 1 ? [`${keyword}: ${chapters[1].title}`] : [])].filter(Boolean),
    description: summary.join(' '),
    chapters: chapters.map(({ seconds, title }) => ({ seconds, title })),
    socialPosts: summary.slice(0, 2).map((sentence) => `New episode: "${sentence}"`),
    model: 'offline topic heuristics',
    engine: 'offline',
    ...(notice ? { notice: `Made without an AI model. ${notice}` } : {}),
  };
}

interface OnDeviceShowNotes {
  titles?: unknown;
  socialPosts?: unknown;
  chapterTitles?: unknown;
}

const SHOW_NOTES_SCHEMA = {
  type: 'object',
  properties: {
    titles: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    socialPosts: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
    chapterTitles: { type: 'array', items: { type: 'string' } },
  },
  required: ['titles', 'socialPosts', 'chapterTitles'],
};

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()).slice(0, limit)
    : [];
}

async function generateEpisodeContentOnDevice(
  transcript: string,
  chapters: Array<{ seconds: number; title: string; text?: string }>,
  scope: LocalAiScope | undefined
): Promise<EpisodeContentResult | null> {
  const status = await getLocalAiStatus(scope);
  const canSummarize = status.summarizer !== 'unavailable';
  const canPrompt = status.languageModel !== 'unavailable';
  if (!canSummarize && !canPrompt) return null;

  const context = 'A podcast or livestream episode transcript. Write for the show notes page.';
  const description = canSummarize
    ? await summarizeWithLocalAi(transcript, { type: 'tldr', length: 'long', context }, scope)
    : null;
  let titles: string[] = [];
  let socialPosts: string[] = [];
  let chapterTitles: string[] = [];
  if (canPrompt) {
    const chapterList = chapters
      .map((chapter, index) => `${index + 1}. [${formatEpisodeChapterTimecode(chapter.seconds)}] ${(chapter.text || chapter.title).slice(0, 400)}`)
      .join('\n');
    const answer = await promptLocalAiJson<OnDeviceShowNotes>(
      'You write concise, accurate podcast show notes. Use only facts from the transcript. No hashtags spam, no emojis.',
      [
        description ? `Episode summary:\n${description}` : `Transcript:\n${transcript.slice(0, 6000)}`,
        `Chapters (one title each, at most 6 words, in this order):\n${chapterList}`,
        'Return 3 episode title options, 2-3 short social posts, and one title per chapter.',
      ].join('\n\n'),
      SHOW_NOTES_SCHEMA,
      scope
    );
    titles = stringList(answer?.titles, 3);
    socialPosts = stringList(answer?.socialPosts, 3);
    chapterTitles = stringList(answer?.chapterTitles, chapters.length);
  }
  if (titles.length === 0 && canSummarize) {
    const headline = await summarizeWithLocalAi(description || transcript, { type: 'headline', length: 'short' }, scope);
    if (headline) titles = [headline.replace(/^#+\s*/, '').trim()];
  }
  if (socialPosts.length === 0 && canSummarize) {
    const keyPoints = await summarizeWithLocalAi(transcript, { type: 'key-points', length: 'short', context }, scope);
    socialPosts = (keyPoints || '')
      .split('\n')
      .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((point) => `New episode: ${point}`);
  }
  const summaryText = (description || '').trim();
  if (!summaryText && titles.length === 0) return null;
  return {
    titles: titles.length ? titles : [buildKeywordTitle(transcript)],
    description: summaryText || buildExtractiveSummary(transcript, 3).join(' '),
    chapters: chapters.map((chapter, index) => ({ seconds: chapter.seconds, title: chapterTitles[index] || chapter.title })),
    socialPosts,
    model: 'Chrome built-in AI (Gemini Nano, on this device)',
    engine: 'on-device',
  };
}

export function formatEpisodeChapterTimecode(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildEpisodeContentText(result: EpisodeContentResult): string {
  const lines: string[] = [];
  if (result.titles.length > 0) {
    lines.push('# Title options', ...result.titles.map((title) => `- ${title}`), '');
  }
  if (result.description.trim()) {
    lines.push('# Description', result.description.trim(), '');
  }
  if (result.chapters.length > 0) {
    lines.push('# Chapters', ...result.chapters.map((chapter) => (
      `${formatEpisodeChapterTimecode(chapter.seconds)} ${chapter.title}`
    )), '');
  }
  if (result.socialPosts.length > 0) {
    lines.push('# Social posts', ...result.socialPosts.map((post) => `- ${post}`), '');
  }
  return lines.join('\n').trim();
}
