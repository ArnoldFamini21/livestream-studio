export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

type FetchLike = typeof fetch;

const SUPPORTED_TRANSCRIPTION_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
  'video/mp4',
  'video/webm',
]);

const EXTENSION_MIME_TYPES: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

export interface TranscriptionUploadValidationInput {
  byteLength: number;
  mimeType?: string;
  fileName?: string;
}

export interface OpenAITranscriptionInput {
  apiKey: string;
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  language?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

export interface RecordingTranscriptionResponse {
  text: string;
  language?: string;
  model: string;
  durationSeconds?: number;
}

function getFileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function normalizeMimeType(value: string | undefined): string {
  return (value || '').split(';')[0].trim().toLowerCase();
}

export function sanitizeTranscriptionFileName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const sanitized = raw
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .slice(0, 120);
  return sanitized || 'recording-audio.webm';
}

export function resolveTranscriptionMimeType(mimeType: string | undefined, fileName: string): string {
  const normalized = normalizeMimeType(mimeType);
  if (SUPPORTED_TRANSCRIPTION_MIME_TYPES.has(normalized)) return normalized;
  return EXTENSION_MIME_TYPES[getFileExtension(fileName)] || normalized || 'application/octet-stream';
}

export function normalizeTranscriptionLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const primary = value.trim().split(/[-_]/)[0]?.toLowerCase();
  return primary && /^[a-z]{2}$/.test(primary) ? primary : undefined;
}

export function validateTranscriptionUpload(input: TranscriptionUploadValidationInput): string | null {
  if (!Number.isFinite(input.byteLength) || input.byteLength <= 0) {
    return 'Upload an audio track before generating a transcript.';
  }
  if (input.byteLength > MAX_TRANSCRIPTION_BYTES) {
    return 'Audio track is too large for transcription. Use a track under 25 MB.';
  }

  const fileName = sanitizeTranscriptionFileName(input.fileName);
  const mimeType = resolveTranscriptionMimeType(input.mimeType, fileName);
  if (!SUPPORTED_TRANSCRIPTION_MIME_TYPES.has(mimeType)) {
    return 'Transcription supports AAC, FLAC, M4A, MP3, MP4, MPEG, OGG, WAV, and WebM audio.';
  }

  return null;
}

export async function createOpenAITranscription(input: OpenAITranscriptionInput): Promise<RecordingTranscriptionResponse> {
  const model = input.model?.trim() || DEFAULT_TRANSCRIPTION_MODEL;
  const form = new FormData();
  form.set('model', model);
  form.set('response_format', 'json');
  if (input.language) form.set('language', input.language);
  const bytes = new Uint8Array(input.buffer.byteLength);
  bytes.set(input.buffer);
  form.set('file', new Blob([bytes.buffer], { type: input.mimeType }), input.fileName);

  const response = await (input.fetchImpl || fetch)('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription request failed with status ${response.status}`);
  }

  const data = await response.json().catch(() => null) as {
    text?: unknown;
    language?: unknown;
    duration?: unknown;
  } | null;
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new Error('OpenAI transcription response did not include transcript text');

  const durationSeconds = Number(data?.duration);
  return {
    text,
    model,
    ...(typeof data?.language === 'string' && data.language.trim() ? { language: data.language.trim() } : {}),
    ...(Number.isFinite(durationSeconds) && durationSeconds >= 0 ? { durationSeconds } : {}),
  };
}
