import { ApiRequestError, postJson } from './apiClient.ts';
import { accountHeaders } from './accountAuth.ts';
import {
  mapAiHighlightSuggestions,
  toTimedCaptionSegments,
  type AiHighlightSuggestion,
  type ClipSuggestion,
  type ClipSuggestionCaptionSegment,
} from './clipSuggestions.ts';
import { buildDeterministicHighlights, type TimedTranscriptSegment } from './autoChapters.ts';
import { LOCAL_AI_REQUIREMENT_NOTE, loadCloudAiFallback, promptLocalAiJson, type LocalAiScope } from './localAi.ts';

const HIGHLIGHT_TIMEOUT_MS = 60_000;
const MAX_HIGHLIGHT_REQUEST_SEGMENTS = 1200;

export interface RequestAiHighlightsInput {
  captionSegments: ClipSuggestionCaptionSegment[];
  durationSeconds?: number | null;
  /**
   * Timed transcript lines in seconds on the recording timeline (e.g. from
   * the in-browser Whisper transcript). Preferred over captions when given.
   */
  timedSegments?: TimedTranscriptSegment[];
  /** Use the server route when on-device AI is unavailable (defaults to the saved preference). */
  cloudFallback?: boolean;
  /** Test seams. */
  localAi?: LocalAiScope;
  requestCloud?: (input: RequestAiHighlightsInput) => Promise<AiHighlightRequestResult>;
}

export interface AiHighlightRequestResult {
  suggestions: ClipSuggestion[];
  model: string;
  engine?: 'on-device' | 'cloud' | 'offline';
  /** Shown with the picks, e.g. why the offline fallback was used. */
  notice?: string;
}

export function hasEnoughCaptionsForAiHighlights(
  captionSegments: ClipSuggestionCaptionSegment[] | undefined
): boolean {
  return toTimedCaptionSegments(captionSegments || []).length >= 3;
}

interface HighlightLine {
  seconds: number;
  text: string;
  speaker: string;
}

function collectHighlightLines(input: RequestAiHighlightsInput): HighlightLine[] {
  const timed = (input.timedSegments || [])
    .filter((segment) => Number.isFinite(segment.seconds) && segment.text?.trim())
    .map((segment) => ({ seconds: segment.seconds, text: segment.text.trim(), speaker: segment.speaker?.trim() || 'Speaker' }));
  if (timed.length >= 3) return timed.sort((a, b) => a.seconds - b.seconds);
  return toTimedCaptionSegments(input.captionSegments || [])
    .map((segment) => ({ seconds: segment.seconds, text: segment.text, speaker: segment.speakerName }));
}

/** The studio server route (OpenAI). Used only when the owner opted into the cloud fallback. */
export async function requestCloudAiHighlights(
  input: RequestAiHighlightsInput
): Promise<AiHighlightRequestResult> {
  const lines = collectHighlightLines(input);
  if (lines.length < 3) {
    throw new ApiRequestError('Record with live captions on to get AI highlight suggestions.');
  }

  const segments = lines.slice(0, MAX_HIGHLIGHT_REQUEST_SEGMENTS);

  const data = await postJson<{ suggestions?: AiHighlightSuggestion[]; model?: unknown }>(
    '/api/highlights',
    {
      segments,
      ...(Number.isFinite(input.durationSeconds) && (input.durationSeconds as number) > 0
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
    { timeoutMs: HIGHLIGHT_TIMEOUT_MS, credentials: 'include', headers: accountHeaders() }
  );

  const highlights = Array.isArray(data.suggestions) ? data.suggestions : [];
  return {
    suggestions: mapAiHighlightSuggestions(highlights, input.durationSeconds),
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : 'ai',
    engine: 'cloud',
  };
}

const HIGHLIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    highlights: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          startSeconds: { type: 'number' },
          endSeconds: { type: 'number' },
          title: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['startSeconds', 'endSeconds', 'title'],
      },
    },
  },
  required: ['highlights'],
};

const ON_DEVICE_MODEL_LABEL = 'Chrome built-in AI (Gemini Nano, on this device)';

/**
 * Shareable moments, free first: Chrome built-in AI (Prompt API) on this
 * computer, then the studio server when the owner opted in, then an offline
 * ranking of 30 s windows by distinctive topic words, questions and
 * back-and-forth (buildDeterministicHighlights).
 */
export async function requestAiHighlights(
  input: RequestAiHighlightsInput
): Promise<AiHighlightRequestResult> {
  const lines = collectHighlightLines(input);
  if (lines.length < 3) {
    throw new ApiRequestError('Record with live captions on to get AI highlight suggestions.');
  }
  const problems: string[] = [];
  try {
    const transcript = lines
      .slice(0, MAX_HIGHLIGHT_REQUEST_SEGMENTS)
      .map((line) => `[${Math.round(line.seconds)}s] ${line.speaker}: ${line.text}`)
      .join('\n');
    const answer = await promptLocalAiJson<{ highlights?: Array<Partial<AiHighlightSuggestion>> }>(
      'You pick the most shareable 20-60 second moments of a podcast for short vertical clips. '
        + 'Use the bracketed second offsets. Prefer strong opinions, stories, surprising facts and clear answers.',
      `Transcript with start times in seconds:\n${transcript}\n\n`
        + 'Return up to 5 highlights with startSeconds, endSeconds, a punchy title (at most 8 words) and a short reason.',
      HIGHLIGHTS_SCHEMA,
      input.localAi
    );
    if (answer && Array.isArray(answer.highlights)) {
      const valid: AiHighlightSuggestion[] = answer.highlights
        .filter((item) => item && Number.isFinite(Number(item.startSeconds)) && Number.isFinite(Number(item.endSeconds)))
        .map((item) => ({
          startSeconds: Number(item.startSeconds),
          endSeconds: Number(item.endSeconds),
          title: typeof item.title === 'string' ? item.title : 'Highlight',
          ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
        }));
      return {
        suggestions: mapAiHighlightSuggestions(valid, input.durationSeconds),
        model: ON_DEVICE_MODEL_LABEL,
        engine: 'on-device',
      };
    }
  } catch (err) {
    problems.push(`On-device AI failed (${err instanceof Error ? err.message : 'unknown error'}).`);
  }

  if (input.cloudFallback ?? loadCloudAiFallback()) {
    try {
      return await (input.requestCloud || requestCloudAiHighlights)(input);
    } catch (err) {
      problems.push(`Studio server AI failed (${err instanceof Error ? err.message : 'unknown error'}).`);
    }
  }

  const offline = buildDeterministicHighlights(lines, input.durationSeconds);
  return {
    suggestions: mapAiHighlightSuggestions(offline, input.durationSeconds),
    model: 'offline topic heuristics',
    engine: 'offline',
    notice: `Picked without an AI model. ${[...problems, LOCAL_AI_REQUIREMENT_NOTE].join(' ')}`,
  };
}
