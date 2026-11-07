import { ApiRequestError, postJson } from './apiClient.ts';
import { accountHeaders } from './accountAuth.ts';
import type { LiveCaptionSegment } from '../hooks/useLiveCaptions.ts';
import { LOCAL_AI_REQUIREMENT_NOTE, loadCloudAiFallback, translateWithLocalAi, type LocalAiScope } from './localAi.ts';

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
  /** BCP-47 language the captions were recognized in (e.g. 'en-US'). */
  sourceLanguage?: string;
  /** Use the server route when on-device translation is unavailable (defaults to the saved preference). */
  cloudFallback?: boolean;
  /** Test seams. */
  localAi?: LocalAiScope;
  requestCloud?: (input: CaptionTranslationRequestInput) => Promise<CaptionTranslationResult>;
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

/**
 * Caption translation, free first: Chrome's on-device Translator (with the
 * LanguageDetector when the source language is unknown), then the studio
 * server when the owner opted in because they configured an OpenAI key.
 */
export async function requestCaptionTranslation(
  input: CaptionTranslationRequestInput
): Promise<CaptionTranslationResult> {
  const requestSegments = validateTranslationInput(input);
  let localProblem = '';
  try {
    const translated = await translateWithLocalAi(
      requestSegments.map((segment) => segment.text),
      input.targetLanguage,
      { sourceLanguage: input.sourceLanguage },
      input.localAi
    );
    if (translated) {
      return {
        segments: mergeTranslatedSegments(
          input.segments,
          translated.map((text, index) => ({ id: requestSegments[index].id, text }))
        ),
        targetLanguage: input.targetLanguage,
        model: 'Chrome built-in Translator (on this device)',
      };
    }
  } catch (err) {
    localProblem = `On-device translation failed (${err instanceof Error ? err.message : 'unknown error'}). `;
  }
  if (input.cloudFallback ?? loadCloudAiFallback()) {
    return (input.requestCloud || requestCloudCaptionTranslation)(input);
  }
  throw new ApiRequestError(
    `${localProblem}This language pair is not available on this device. ${LOCAL_AI_REQUIREMENT_NOTE} `
      + 'If the studio server has an OpenAI key, turn on the cloud AI fallback.'
  );
}

function validateTranslationInput(input: CaptionTranslationRequestInput): TranslatedSegmentPayload[] {
  const requestSegments = buildTranslationRequestSegments(input.segments);
  if (requestSegments.length === 0) {
    throw new ApiRequestError('Record some captions before translating them.');
  }
  if (!input.targetLanguage) {
    throw new ApiRequestError('Choose a target language for the translation.');
  }
  return requestSegments;
}

/** The studio server route (OpenAI). Used only when the owner opted into the cloud fallback. */
export async function requestCloudCaptionTranslation(
  input: CaptionTranslationRequestInput
): Promise<CaptionTranslationResult> {
  const requestSegments = validateTranslationInput(input);

  const data = await postJson<{ translations?: TranslatedSegmentPayload[]; targetLanguage?: unknown; model?: unknown }>(
    '/api/translate-captions',
    {
      segments: requestSegments,
      targetLanguage: input.targetLanguage,
    },
    { timeoutMs: TRANSLATION_TIMEOUT_MS, credentials: 'include', headers: accountHeaders() }
  );

  const translations = Array.isArray(data.translations) ? data.translations : [];
  return {
    segments: mergeTranslatedSegments(input.segments, translations),
    targetLanguage: typeof data.targetLanguage === 'string' ? data.targetLanguage : input.targetLanguage,
    model: typeof data.model === 'string' && data.model.trim() ? data.model.trim() : 'ai',
  };
}
