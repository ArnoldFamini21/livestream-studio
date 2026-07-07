export const DEFAULT_EPISODE_CONTENT_MODEL = 'gpt-4o-mini';
export const MAX_EPISODE_TRANSCRIPT_CHARS = 24_000;
export const MAX_EPISODE_TITLES = 5;
export const MAX_EPISODE_CHAPTERS = 12;
export const MAX_EPISODE_SOCIAL_POSTS = 4;

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1200;
const MAX_CHAPTER_TITLE_LENGTH = 80;
const MAX_SOCIAL_POST_LENGTH = 600;

type FetchLike = typeof fetch;

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

export interface OpenAIEpisodeContentInput {
  apiKey: string;
  transcript: string;
  durationSeconds?: number | null;
  model?: string;
  fetchImpl?: FetchLike;
}

export function validateEpisodeContentRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return 'Send a transcript to generate episode content.';
  }
  const { transcript, durationSeconds } = body as { transcript?: unknown; durationSeconds?: unknown };
  if (typeof transcript !== 'string' || transcript.trim().length < 40) {
    return 'A transcript of at least 40 characters is required to generate episode content.';
  }
  if (
    durationSeconds !== undefined &&
    durationSeconds !== null &&
    (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0)
  ) {
    return 'durationSeconds must be a positive number when provided.';
  }
  return null;
}

export function normalizeEpisodeTranscript(transcript: string): string {
  return transcript.trim().replace(/\r\n/g, '\n').slice(0, MAX_EPISODE_TRANSCRIPT_CHARS);
}

export function buildEpisodeContentPrompt(transcript: string, durationSeconds?: number | null): string {
  const durationLine = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0
    ? `The recording is about ${Math.round((durationSeconds as number) / 60)} minutes long; keep chapter timestamps within that range.`
    : 'Keep chapter timestamps within the transcript timeline.';
  return [
    'Transcript of a live-stream / podcast recording:',
    '',
    normalizeEpisodeTranscript(transcript),
    '',
    durationLine,
  ].join('\n');
}

function extractJsonPayload(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, maxLength);
    if (trimmed) result.push(trimmed);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeChapters(value: unknown, durationSeconds?: number | null): EpisodeContentChapter[] {
  if (!Array.isArray(value)) return [];
  const duration = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0
    ? (durationSeconds as number)
    : null;
  const chapters: EpisodeContentChapter[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const seconds = Number(record.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    if (duration !== null && seconds > duration) continue;
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, MAX_CHAPTER_TITLE_LENGTH) : '';
    if (!title) continue;
    chapters.push({ seconds: Math.round(seconds), title });
    if (chapters.length >= MAX_EPISODE_CHAPTERS) break;
  }
  return chapters
    .sort((a, b) => a.seconds - b.seconds)
    .filter((chapter, index, list) => index === 0 || chapter.seconds !== list[index - 1].seconds);
}

export function parseEpisodeContent(rawText: string, durationSeconds?: number | null): Omit<EpisodeContentResult, 'model'> {
  const payload = extractJsonPayload(rawText);
  const description = payload && typeof payload.description === 'string'
    ? payload.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
    : '';
  return {
    titles: toStringList(payload?.titles, MAX_EPISODE_TITLES, MAX_TITLE_LENGTH),
    description,
    chapters: normalizeChapters(payload?.chapters, durationSeconds),
    socialPosts: toStringList(payload?.socialPosts, MAX_EPISODE_SOCIAL_POSTS, MAX_SOCIAL_POST_LENGTH),
  };
}

const EPISODE_CONTENT_SYSTEM_PROMPT = [
  'You write launch-ready show notes for creators publishing a recorded live stream or podcast.',
  'From the transcript produce catchy title options, a compelling description, timestamped chapter markers, and short social posts.',
  'Chapters must use whole-second offsets from the start of the recording and cover the main topics in order.',
  `Respond with JSON only: {"titles": string[], "description": string, "chapters": [{"seconds": number, "title": string}], "socialPosts": string[]} with at most ${MAX_EPISODE_TITLES} titles, ${MAX_EPISODE_CHAPTERS} chapters, and ${MAX_EPISODE_SOCIAL_POSTS} social posts.`,
].join(' ');

export async function createOpenAIEpisodeContent(
  input: OpenAIEpisodeContentInput
): Promise<EpisodeContentResult> {
  const model = input.model?.trim() || DEFAULT_EPISODE_CONTENT_MODEL;
  const transcript = normalizeEpisodeTranscript(input.transcript);
  if (transcript.length < 40) {
    throw new Error('Transcript is too short to generate episode content');
  }

  const response = await (input.fetchImpl || fetch)('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EPISODE_CONTENT_SYSTEM_PROMPT },
        { role: 'user', content: buildEpisodeContentPrompt(transcript, input.durationSeconds) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI episode content request failed with status ${response.status}`);
  }

  const data = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI episode content response did not include any content');
  }

  return {
    ...parseEpisodeContent(content, input.durationSeconds),
    model,
  };
}
