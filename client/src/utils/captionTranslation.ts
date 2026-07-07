import { ApiRequestError, postJson } from './apiClient.ts';
import type { LiveCaptionSegment } from '../hooks/useLiveCaptions.ts';

const TRANSLATION_TIMEOUT_MS = 60_000;
const MAX_TRANSLATION_SEGMENTS = 1500;

export interface CaptionTranslationTargetLanguage {
  value: string;
  label: string;
}

// Kept in sync with the server's SUPPORTED_TRANSLATION_LANGUAGES map.
export const CAPTION_TRANSLATION_LANGUAGES: CaptionTranslationTargetLanguage[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese (Simplified)' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
  { value: 'fil', label: 'Filipino' },
];

export interface CaptionTranslationRequestInput {
  segments: LiveCaptionSegment[];
  targetLanguage: string;
}

export interface CaptionTranslationResult {
  segments: LiveCaptionSegment[];
  targetLanguage: string;
  model: string;
}

interface TranslatedSegmentPayload {
  id: number;
  text: string;
}

export function buildTranslationRequestSegments(
  segments: LiveCaptionSegment[]
): TranslatedSegmentPayload[] {
  return segments
    .filter((segment) => !segment.interim && segment.text.trim())
    .slice(0, MAX_TRANSLATION_SEGMENTS)
    .map((segment, index) => ({ id: index, text: segment.text.trim() }));
}

export function mergeTranslatedSegments(
  sourceSegments: LiveCaptionSegment[],
  translations: TranslatedSegmentPayload[]
): LiveCaptionSegment[] {
  const finals = sourceSegments.filter((segment) => !segment.interim && segment.text.trim());
  const byId = new Map<number, string>();
  for (const translation of translations) {
    if (translation && typeof translation.id === 'number' && typeof translation.text === 'string') {
      byId.set(translation.id, translation.text);
    }
  }
  return finals.map((segment, index) => ({
    ...segment,
    text: byId.get(index)?.trim() || segment.text,
  }));
}

export async function requestCaptionTranslation(
  input: CaptionTranslationRequestInput
): Promise<CaptionTranslationResult> {
  const requestSegments = buildTranslationRequestSegments(input.segments);
  if (requestSegments.length === 0) {
    throw new ApiRequestError('Record some captions before translating them.');
  }
  if (!input.targetLanguage) {
    throw new ApiRequestError('Choose a target language for the translation.');
  }

  const data = await postJson<{ translations?: TranslatedSegmentPayload[]; targetLanguage?: unknown; model?: unknown }>(
    '/api/translate-captions',
    {
      segments: requestSegments,
      targetLanguage: input.targetLanguage,
    },
    { timeoutMs: TRANSLATION_TIMEOUT_MS }
  );

  const translations = Array.isArray(data.translations) ? data.translations : [];
  return {
    segments: mergeTranslatedSegments(input.segments, translations),
    targetLanguage: typeof data.targetLanguage === 'string' ? data.targetLanguage : input.targetLanguage,
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : 'ai',
  };
}
