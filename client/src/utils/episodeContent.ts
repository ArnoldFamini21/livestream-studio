import { ApiRequestError, postJson } from './apiClient.ts';

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
}

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
}

export async function requestEpisodeContent(
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
    { timeoutMs: EPISODE_CONTENT_TIMEOUT_MS }
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
