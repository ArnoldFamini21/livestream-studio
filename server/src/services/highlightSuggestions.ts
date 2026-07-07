export const DEFAULT_HIGHLIGHT_MODEL = 'gpt-4o-mini';
export const MAX_HIGHLIGHT_SEGMENTS = 1200;
export const MAX_HIGHLIGHT_SUGGESTIONS = 6;
export const MIN_HIGHLIGHT_DURATION_SECONDS = 5;
export const MAX_HIGHLIGHT_DURATION_SECONDS = 600;

const MAX_SEGMENT_TEXT_LENGTH = 400;
const MAX_SPEAKER_LENGTH = 80;
const MAX_TITLE_LENGTH = 80;
const MAX_REASON_LENGTH = 160;

type FetchLike = typeof fetch;

export interface HighlightCaptionSegment {
  seconds: number;
  text: string;
  speaker?: string;
}

export interface HighlightSuggestion {
  startSeconds: number;
  endSeconds: number;
  title: string;
  reason: string;
}

export interface HighlightSuggestionResponse {
  suggestions: HighlightSuggestion[];
  model: string;
}

export interface OpenAIHighlightSuggestionInput {
  apiKey: string;
  segments: HighlightCaptionSegment[];
  durationSeconds?: number | null;
  model?: string;
  fetchImpl?: FetchLike;
}

export function validateHighlightSuggestionRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return 'Send caption segments to suggest highlights.';
  }
  const { segments, durationSeconds } = body as { segments?: unknown; durationSeconds?: unknown };
  if (!Array.isArray(segments) || segments.length === 0) {
    return 'Send caption segments to suggest highlights.';
  }
  if (segments.length > MAX_HIGHLIGHT_SEGMENTS) {
    return `A maximum of ${MAX_HIGHLIGHT_SEGMENTS} caption segments can be analyzed at once.`;
  }
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return 'Invalid caption segment.';
    const { seconds, text } = segment as { seconds?: unknown; text?: unknown };
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      return 'Caption segments need a non-negative seconds offset.';
    }
    if (typeof text !== 'string' || !text.trim()) {
      return 'Caption segments need transcript text.';
    }
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

export function normalizeHighlightSegments(segments: HighlightCaptionSegment[]): HighlightCaptionSegment[] {
  return segments
    .map((segment) => ({
      seconds: Math.max(0, Math.round(segment.seconds * 10) / 10),
      text: segment.text.trim().replace(/\s+/g, ' ').slice(0, MAX_SEGMENT_TEXT_LENGTH),
      ...(segment.speaker?.trim()
        ? { speaker: segment.speaker.trim().slice(0, MAX_SPEAKER_LENGTH) }
        : {}),
    }))
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.seconds - b.seconds);
}

function formatPromptTimecode(seconds: number): string {
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function buildHighlightPrompt(
  segments: HighlightCaptionSegment[],
  durationSeconds?: number | null
): string {
  const lines = segments.map((segment) => (
    `[${formatPromptTimecode(segment.seconds)}] ${segment.speaker || 'Speaker'}: ${segment.text}`
  ));
  const durationLine = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0
    ? `The recording is ${Math.round(durationSeconds as number)} seconds long.`
    : 'The recording length is unknown; keep ranges within the transcript timestamps.';
  return [
    'Transcript of a live-stream recording with [minutes:seconds] offsets:',
    '',
    ...lines,
    '',
    durationLine,
  ].join('\n');
}

function extractJsonPayload(rawText: string): unknown {
  const trimmed = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseHighlightSuggestions(
  rawText: string,
  durationSeconds?: number | null
): HighlightSuggestion[] {
  const payload = extractJsonPayload(rawText);
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { highlights?: unknown }).highlights)
      ? (payload as { highlights: unknown[] }).highlights
      : [];

  const duration = Number.isFinite(durationSeconds) && (durationSeconds as number) > 0
    ? (durationSeconds as number)
    : null;

  const suggestions: HighlightSuggestion[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    let start = Number(record.startSeconds);
    let end = Number(record.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.round(start * 10) / 10);
    end = Math.round(end * 10) / 10;
    if (duration !== null) {
      if (start >= duration) continue;
      end = Math.min(end, duration);
    }
    end = Math.min(end, start + MAX_HIGHLIGHT_DURATION_SECONDS);
    if (end - start < MIN_HIGHLIGHT_DURATION_SECONDS) continue;
    const title = typeof record.title === 'string' && record.title.trim()
      ? record.title.trim().slice(0, MAX_TITLE_LENGTH)
      : 'Suggested highlight';
    const reason = typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim().slice(0, MAX_REASON_LENGTH)
      : '';
    if (suggestions.some((existing) => Math.min(existing.endSeconds, end) - Math.max(existing.startSeconds, start) > (end - start) / 2)) {
      continue;
    }
    suggestions.push({ startSeconds: start, endSeconds: end, title, reason });
    if (suggestions.length >= MAX_HIGHLIGHT_SUGGESTIONS) break;
  }
  return suggestions.sort((a, b) => a.startSeconds - b.startSeconds);
}

const HIGHLIGHT_SYSTEM_PROMPT = [
  'You pick the most shareable highlight clips from live-stream transcripts.',
  'Choose self-contained moments: announcements, key insights, demos, strong questions and answers, emotional peaks.',
  `Each highlight must be ${MIN_HIGHLIGHT_DURATION_SECONDS} to ${MAX_HIGHLIGHT_DURATION_SECONDS} seconds long and start slightly before the moment begins.`,
  `Respond with JSON only: {"highlights": [{"startSeconds": number, "endSeconds": number, "title": string, "reason": string}]} with at most ${MAX_HIGHLIGHT_SUGGESTIONS} entries, ordered by how shareable they are.`,
].join(' ');

export async function createOpenAIHighlightSuggestions(
  input: OpenAIHighlightSuggestionInput
): Promise<HighlightSuggestionResponse> {
  const model = input.model?.trim() || DEFAULT_HIGHLIGHT_MODEL;
  const segments = normalizeHighlightSegments(input.segments);
  if (segments.length === 0) {
    throw new Error('No usable caption segments were provided for highlight suggestions');
  }

  const response = await (input.fetchImpl || fetch)('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: HIGHLIGHT_SYSTEM_PROMPT },
        { role: 'user', content: buildHighlightPrompt(segments, input.durationSeconds) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI highlight request failed with status ${response.status}`);
  }

  const data = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI highlight response did not include suggestions');
  }

  return {
    suggestions: parseHighlightSuggestions(content, input.durationSeconds),
    model,
  };
}
