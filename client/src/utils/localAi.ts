/**
 * Chrome's built-in AI (Gemini Nano on the device): Summarizer, Translator,
 * LanguageDetector and the Prompt API (LanguageModel). They are free, run
 * offline once the model is on the computer, and send nothing to a server.
 *
 * Every API is feature-detected and checked with availability() before use,
 * because it exists only in desktop Chrome (138+) on hardware that can run
 * Gemini Nano, and may still need a one-time model download. Callers fall
 * back to the studio server (when the owner configured an OpenAI key and
 * opted in) and then to the deterministic helpers in autoChapters.ts.
 */

export type LocalAiFeature = 'summarizer' | 'translator' | 'languageDetector' | 'languageModel';
export type LocalAiAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export const LOCAL_AI_REQUIREMENT_NOTE =
  'On-device AI needs desktop Chrome 138 or newer on a computer that can run Gemini Nano (about 22 GB free disk, 4 GB+ GPU or 16 GB RAM). Other browsers use the free built-in fallback.';

interface MonitorLike {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
}

interface CreateOptionsBase {
  monitor?: (monitor: MonitorLike) => void;
  signal?: AbortSignal;
}

interface SummarizerLike {
  summarize(text: string, options?: { context?: string; signal?: AbortSignal }): Promise<string>;
  measureInputUsage?(text: string): Promise<number>;
  inputQuota?: number;
  destroy?(): void;
}

interface SummarizerStatic {
  availability(options?: Record<string, unknown>): Promise<LocalAiAvailability>;
  create(options?: Record<string, unknown> & CreateOptionsBase): Promise<SummarizerLike>;
}

interface TranslatorLike {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

interface TranslatorStatic {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<LocalAiAvailability>;
  create(options: { sourceLanguage: string; targetLanguage: string } & CreateOptionsBase): Promise<TranslatorLike>;
}

interface LanguageDetectorLike {
  detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
  destroy?(): void;
}

interface LanguageDetectorStatic {
  availability(options?: Record<string, unknown>): Promise<LocalAiAvailability>;
  create(options?: CreateOptionsBase): Promise<LanguageDetectorLike>;
}

interface LanguageModelSessionLike {
  prompt(input: string, options?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  measureInputUsage?(input: string): Promise<number>;
  inputQuota?: number;
  destroy?(): void;
}

interface LanguageModelStatic {
  availability(options?: Record<string, unknown>): Promise<LocalAiAvailability>;
  create(options?: Record<string, unknown> & CreateOptionsBase): Promise<LanguageModelSessionLike>;
}

export interface LocalAiScope {
  Summarizer?: SummarizerStatic;
  Translator?: TranslatorStatic;
  LanguageDetector?: LanguageDetectorStatic;
  LanguageModel?: LanguageModelStatic;
}

export type LocalAiStatus = Record<LocalAiFeature, LocalAiAvailability>;

function defaultScope(): LocalAiScope {
  return globalThis as unknown as LocalAiScope;
}

function isUsable(availability: LocalAiAvailability): boolean {
  return availability !== 'unavailable';
}

async function safeAvailability(check: () => Promise<LocalAiAvailability> | undefined): Promise<LocalAiAvailability> {
  try {
    const result = await check();
    return result === 'available' || result === 'downloadable' || result === 'downloading' ? result : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

const TEXT_OPTIONS = { expectedInputLanguages: ['en'], outputLanguage: 'en' };

export async function getLocalAiStatus(scope: LocalAiScope = defaultScope()): Promise<LocalAiStatus> {
  const [summarizer, translator, languageDetector, languageModel] = await Promise.all([
    scope.Summarizer ? safeAvailability(() => scope.Summarizer?.availability(TEXT_OPTIONS)) : 'unavailable' as const,
    scope.Translator ? safeAvailability(() => scope.Translator?.availability({ sourceLanguage: 'en', targetLanguage: 'es' })) : 'unavailable' as const,
    scope.LanguageDetector ? safeAvailability(() => scope.LanguageDetector?.availability()) : 'unavailable' as const,
    scope.LanguageModel ? safeAvailability(() => scope.LanguageModel?.availability(LANGUAGE_MODEL_OPTIONS)) : 'unavailable' as const,
  ]);
  return { summarizer, translator, languageDetector, languageModel };
}

export function hasAnyLocalAi(status: LocalAiStatus): boolean {
  return Object.values(status).some(isUsable);
}

/** Splits text into pieces of at most `maxChars`, on line or sentence breaks where possible. */
export function splitForQuota(text: string, maxChars: number): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const pieces: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const cut = breakAt > maxChars * 0.5 ? breakAt + 1 : maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Characters that safely fit an API's token quota (about 3.5 characters per token, with headroom). */
function charsForQuota(quota: number | undefined, fallbackChars: number): number {
  return Number.isFinite(quota) && (quota as number) > 0 ? Math.floor((quota as number) * 3) : fallbackChars;
}

export type SummaryType = 'tldr' | 'key-points' | 'headline' | 'teaser';

export interface LocalSummaryOptions {
  type: SummaryType;
  length?: 'short' | 'medium' | 'long';
  format?: 'plain-text' | 'markdown';
  context?: string;
  signal?: AbortSignal;
}

/**
 * Summarizes text of any length: pieces that exceed the input quota are
 * summarized first and the joined summaries summarized again. Returns null
 * when the Summarizer is unavailable.
 */
export async function summarizeWithLocalAi(
  text: string,
  options: LocalSummaryOptions,
  scope: LocalAiScope = defaultScope()
): Promise<string | null> {
  const api = scope.Summarizer;
  if (!api || !isUsable(await safeAvailability(() => api.availability(TEXT_OPTIONS)))) return null;
  const create = (type: SummaryType, length: LocalSummaryOptions['length']) => api.create({
    ...TEXT_OPTIONS,
    type,
    length: length || 'medium',
    format: options.format || 'plain-text',
    ...(options.context ? { sharedContext: options.context } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const summarizer = await create(options.type, options.length);
  try {
    const maxChars = charsForQuota(summarizer.inputQuota, 12_000);
    const pieces = splitForQuota(text, maxChars);
    if (pieces.length === 0) return null;
    if (pieces.length === 1) return (await summarizer.summarize(pieces[0], { signal: options.signal })).trim();
    const partial = await create('tldr', 'medium');
    try {
      const summaries: string[] = [];
      for (const piece of pieces) summaries.push((await partial.summarize(piece, { signal: options.signal })).trim());
      const joined = summaries.join('\n');
      return (await summarizer.summarize(joined.slice(0, maxChars), { signal: options.signal })).trim();
    } finally {
      partial.destroy?.();
    }
  } finally {
    summarizer.destroy?.();
  }
}

const LANGUAGE_MODEL_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

/**
 * Asks the on-device LanguageModel for JSON matching `schema` (structured
 * output via responseConstraint). Returns null when the Prompt API is
 * unavailable or the answer does not parse.
 */
export async function promptLocalAiJson<T>(
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  scope: LocalAiScope = defaultScope(),
  signal?: AbortSignal
): Promise<T | null> {
  const api = scope.LanguageModel;
  if (!api || !isUsable(await safeAvailability(() => api.availability(LANGUAGE_MODEL_OPTIONS)))) return null;
  const session = await api.create({
    ...LANGUAGE_MODEL_OPTIONS,
    initialPrompts: [{ role: 'system', content: system }],
    ...(signal ? { signal } : {}),
  });
  try {
    const maxChars = charsForQuota(session.inputQuota, 12_000) - system.length - 200;
    const input = prompt.length > maxChars ? `${prompt.slice(0, Math.max(500, maxChars))}\n[transcript truncated]` : prompt;
    const raw = await session.prompt(input, { responseConstraint: schema, ...(signal ? { signal } : {}) });
    return parseJsonResponse<T>(raw);
  } finally {
    session.destroy?.();
  }
}

export function parseJsonResponse<T>(raw: string): T | null {
  const trimmed = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** The dominant language of `text` (BCP-47 base code), or null. */
export async function detectLanguageWithLocalAi(text: string, scope: LocalAiScope = defaultScope()): Promise<string | null> {
  const api = scope.LanguageDetector;
  if (!api || !isUsable(await safeAvailability(() => api.availability()))) return null;
  const detector = await api.create();
  try {
    const results = await detector.detect(text.slice(0, 4000));
    const best = results.find((result) => result.detectedLanguage && result.detectedLanguage !== 'und');
    return best && best.confidence >= 0.4 ? best.detectedLanguage.split('-')[0] : null;
  } finally {
    detector.destroy?.();
  }
}

export interface LocalTranslationOptions {
  sourceLanguage?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Translates each text with the on-device Translator. The source language
 * comes from the caller or the LanguageDetector. Returns null when the pair
 * is not available on this device.
 */
export async function translateWithLocalAi(
  texts: string[],
  targetLanguage: string,
  options: LocalTranslationOptions = {},
  scope: LocalAiScope = defaultScope()
): Promise<string[] | null> {
  const api = scope.Translator;
  if (!api || texts.length === 0) return null;
  const target = normalizeTranslatorLanguage(targetLanguage);
  const source = normalizeTranslatorLanguage(options.sourceLanguage || '')
    || await detectLanguageWithLocalAi(texts.join(' '), scope).catch(() => null)
    || 'en';
  if (source === target) return [...texts];
  const availability = await safeAvailability(() => api.availability({ sourceLanguage: source, targetLanguage: target }));
  if (!isUsable(availability)) return null;
  const translator = await api.create({ sourceLanguage: source, targetLanguage: target, ...(options.signal ? { signal: options.signal } : {}) });
  try {
    const output: string[] = [];
    for (const [index, text] of texts.entries()) {
      output.push(text.trim() ? (await translator.translate(text, { signal: options.signal })).trim() || text : text);
      options.onProgress?.(index + 1, texts.length);
    }
    return output;
  } finally {
    translator.destroy?.();
  }
}

/** Translator language tags: base codes, except Chinese which needs the script ('zh' is Simplified). */
export function normalizeTranslatorLanguage(language: string): string {
  const value = (language || '').trim();
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hant') return 'zh-Hant';
  if (lower.startsWith('zh')) return 'zh';
  if (lower === 'fil' || lower.startsWith('fil-') || lower === 'tl') return 'fil';
  return lower.split(/[-_]/)[0];
}

// ---------- Cloud fallback preference ----------

const CLOUD_FALLBACK_KEY = 'studio.ai.cloudFallback.v1';

/** Whether to use the studio server's OpenAI routes when on-device AI is unavailable (off by default). */
export function loadCloudAiFallback(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(CLOUD_FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveCloudAiFallback(enabled: boolean, storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()): void {
  try {
    storage?.setItem(CLOUD_FALLBACK_KEY, enabled ? '1' : '0');
  } catch {
    // Blocked storage just forgets the choice.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
