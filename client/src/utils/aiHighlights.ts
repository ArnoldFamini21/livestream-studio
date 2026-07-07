import { ApiRequestError, postJson } from './apiClient.ts';
import {
  mapAiHighlightSuggestions,
  toTimedCaptionSegments,
  type AiHighlightSuggestion,
  type ClipSuggestion,
  type ClipSuggestionCaptionSegment,
} from './clipSuggestions.ts';

const HIGHLIGHT_TIMEOUT_MS = 60_000;
const MAX_HIGHLIGHT_REQUEST_SEGMENTS = 1200;

export interface RequestAiHighlightsInput {
  captionSegments: ClipSuggestionCaptionSegment[];
  durationSeconds?: number | null;
}

export interface AiHighlightRequestResult {
  suggestions: ClipSuggestion[];
  model: string;
}

export function hasEnoughCaptionsForAiHighlights(
  captionSegments: ClipSuggestionCaptionSegment[] | undefined
): boolean {
  return toTimedCaptionSegments(captionSegments || []).length >= 3;
}

export async function requestAiHighlights(
  input: RequestAiHighlightsInput
): Promise<AiHighlightRequestResult> {
  const timed = toTimedCaptionSegments(input.captionSegments || []);
  if (timed.length < 3) {
    throw new ApiRequestError('Record with live captions on to get AI highlight suggestions.');
  }

  const segments = timed
    .slice(0, MAX_HIGHLIGHT_REQUEST_SEGMENTS)
    .map((segment) => ({
      seconds: segment.seconds,
      text: segment.text,
      speaker: segment.speakerName,
    }));

  const data = await postJson<{ suggestions?: AiHighlightSuggestion[]; model?: unknown }>(
    '/api/highlights',
    {
      segments,
      ...(Number.isFinite(input.durationSeconds) && (input.durationSeconds as number) > 0
        ? { durationSeconds: input.durationSeconds }
        : {}),
    },
    { timeoutMs: HIGHLIGHT_TIMEOUT_MS }
  );

  const highlights = Array.isArray(data.suggestions) ? data.suggestions : [];
  return {
    suggestions: mapAiHighlightSuggestions(highlights, input.durationSeconds),
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : 'ai',
  };
}
