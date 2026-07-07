export const DEFAULT_CAPTION_TRANSLATION_MODEL = 'gpt-4o-mini';
export const MAX_TRANSLATION_SEGMENTS = 1500;
export const MAX_TRANSLATION_TEXT_LENGTH = 600;

type FetchLike = typeof fetch;

// Common target languages offered in the studio caption UI.
export const SUPPORTED_TRANSLATION_LANGUAGES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  hi: 'Hindi',
  ar: 'Arabic',
  fil: 'Filipino',
};

export interface CaptionTranslationSegment {
  id: number;
  text: string;
}

export interface CaptionTranslationResult {
  translations: CaptionTranslationSegment[];
  targetLanguage: string;
  model: string;
}

export interface OpenAICaptionTranslationInput {
  apiKey: string;
  segments: CaptionTranslationSegment[];
  targetLanguage: string;
  model?: string;
  fetchImpl?: FetchLike;
}

export function normalizeTranslationLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().split(/[-_]/)[0];
  return key && SUPPORTED_TRANSLATION_LANGUAGES[key] ? key : null;
}

export function validateCaptionTranslationRequest(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return 'Send caption segments and a target language to translate.';
  }
  const { segments, targetLanguage } = body as { segments?: unknown; targetLanguage?: unknown };
  if (!normalizeTranslationLanguage(targetLanguage)) {
    return 'Choose a supported target language for the translation.';
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return 'Send caption segments to translate.';
  }
  if (segments.length > MAX_TRANSLATION_SEGMENTS) {
    return `A maximum of ${MAX_TRANSLATION_SEGMENTS} caption segments can be translated at once.`;
  }
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') return 'Invalid caption segment.';
    const { id, text } = segment as { id?: unknown; text?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
      return 'Caption segments need an integer id.';
    }
    if (typeof text !== 'string' || !text.trim()) {
      return 'Caption segments need text to translate.';
    }
  }
  return null;
}

export function normalizeTranslationSegments(segments: CaptionTranslationSegment[]): CaptionTranslationSegment[] {
  const seen = new Set<number>();
  const result: CaptionTranslationSegment[] = [];
  for (const segment of segments) {
    if (seen.has(segment.id)) continue;
    seen.add(segment.id);
    result.push({ id: segment.id, text: segment.text.trim().slice(0, MAX_TRANSLATION_TEXT_LENGTH) });
  }
  return result;
}

export function buildCaptionTranslationPrompt(
  segments: CaptionTranslationSegment[],
  targetLanguage: string
): string {
  const languageName = SUPPORTED_TRANSLATION_LANGUAGES[targetLanguage] || targetLanguage;
  const payload = JSON.stringify({ segments });
  return [
    `Translate each caption segment's "text" into ${languageName}.`,
    'Preserve meaning and speaking tone; keep it concise enough for on-screen subtitles.',
    'Return JSON only in the form {"segments":[{"id":number,"text":string}]} with the same ids.',
    '',
    payload,
  ].join('\n');
}

export function parseCaptionTranslations(
  rawText: string,
  requested: CaptionTranslationSegment[]
): CaptionTranslationSegment[] {
  const trimmed = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let payload: unknown = null;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    // Leave payload null so every segment falls back to its source text below.
  }
  const rawSegments = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { segments?: unknown }).segments)
      ? (payload as { segments: unknown[] }).segments
      : [];

  const requestedIds = new Set(requested.map((segment) => segment.id));
  const byId = new Map<number, string>();
  for (const item of rawSegments) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isInteger(id) || !requestedIds.has(id) || byId.has(id)) continue;
    const text = typeof record.text === 'string' ? record.text.trim().slice(0, MAX_TRANSLATION_TEXT_LENGTH) : '';
    if (text) byId.set(id, text);
  }

  // Preserve the requested order and fall back to source text for any missing ids.
  return requested.map((segment) => ({
    id: segment.id,
    text: byId.get(segment.id) || segment.text,
  }));
}

export async function createOpenAICaptionTranslation(
  input: OpenAICaptionTranslationInput
): Promise<CaptionTranslationResult> {
  const targetLanguage = normalizeTranslationLanguage(input.targetLanguage);
  if (!targetLanguage) {
    throw new Error('Unsupported caption translation target language');
  }
  const model = input.model?.trim() || DEFAULT_CAPTION_TRANSLATION_MODEL;
  const segments = normalizeTranslationSegments(input.segments);
  if (segments.length === 0) {
    throw new Error('No caption segments were provided for translation');
  }

  const response = await (input.fetchImpl || fetch)('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a professional subtitle translator. Respond with JSON only.' },
        { role: 'user', content: buildCaptionTranslationPrompt(segments, targetLanguage) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI caption translation request failed with status ${response.status}`);
  }

  const data = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI caption translation response did not include any content');
  }

  return {
    translations: parseCaptionTranslations(content, segments),
    targetLanguage,
    model,
  };
}
