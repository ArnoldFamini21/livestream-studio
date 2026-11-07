/**
 * Which engine writes recording transcripts, and with which Whisper model.
 *
 * The default is the free in-browser engine (Whisper ONNX through
 * transformers.js). The OpenAI route stays available as an optional "cloud"
 * engine for owners who configured OPENAI_API_KEY on the studio server.
 * Choices are a per-browser convenience kept in localStorage.
 */

export type TranscriptionEngine = 'browser' | 'cloud';
export type BrowserWhisperModelId = 'tiny' | 'base' | 'small';

export interface BrowserWhisperModel {
  id: BrowserWhisperModelId;
  label: string;
  /** Hugging Face repo with ONNX weights exported with cross-attentions (word timestamps). */
  repo: string;
  /** One-time download with the wasm (CPU) weights, in MB. */
  approxDownloadMb: number;
  description: string;
}

export const BROWSER_WHISPER_MODELS: BrowserWhisperModel[] = [
  {
    id: 'tiny',
    label: 'Fastest (Whisper tiny)',
    repo: 'onnx-community/whisper-tiny_timestamped',
    approxDownloadMb: 45,
    description: 'Quick drafts on slower laptops. Misses more words.',
  },
  {
    id: 'base',
    label: 'Balanced (Whisper base)',
    repo: 'onnx-community/whisper-base_timestamped',
    approxDownloadMb: 80,
    description: 'Good accuracy at a few times real-time speed on most computers.',
  },
  {
    id: 'small',
    label: 'Most accurate (Whisper small)',
    repo: 'onnx-community/whisper-small_timestamped',
    approxDownloadMb: 250,
    description: 'Best for accents and mixed languages. Slow without a GPU (WebGPU).',
  },
];

export const DEFAULT_BROWSER_WHISPER_MODEL: BrowserWhisperModelId = 'base';
export const DEFAULT_TRANSCRIPTION_ENGINE: TranscriptionEngine = 'browser';

export interface TranscriptionSettings {
  engine: TranscriptionEngine;
  model: BrowserWhisperModelId;
}

const STORAGE_KEY = 'studio.transcription.settings.v1';

export function getBrowserWhisperModel(id: string | undefined | null): BrowserWhisperModel {
  return BROWSER_WHISPER_MODELS.find((model) => model.id === id)
    || BROWSER_WHISPER_MODELS.find((model) => model.id === DEFAULT_BROWSER_WHISPER_MODEL)!;
}

export function normalizeTranscriptionSettings(value: unknown): TranscriptionSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof TranscriptionSettings, unknown>>;
  const engine: TranscriptionEngine = raw.engine === 'cloud' ? 'cloud' : DEFAULT_TRANSCRIPTION_ENGINE;
  const model = BROWSER_WHISPER_MODELS.some((item) => item.id === raw.model)
    ? raw.model as BrowserWhisperModelId
    : DEFAULT_BROWSER_WHISPER_MODEL;
  return { engine, model };
}

export function loadTranscriptionSettings(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): TranscriptionSettings {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return normalizeTranscriptionSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return normalizeTranscriptionSettings(null);
  }
}

export function saveTranscriptionSettings(
  settings: TranscriptionSettings,
  storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeTranscriptionSettings(settings)));
  } catch {
    // Private windows or blocked storage just forget the choice.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
