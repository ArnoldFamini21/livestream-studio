import { ApiRequestError, buildApiUrl } from './apiClient.ts';
import type { LocalRecordingFileResult } from '../hooks/useLocalRecording.ts';

export interface RecordingTranscriptionSourceFile {
  label: string;
  fileName: string;
  blob: Blob;
  kind?: LocalRecordingFileResult['kind'];
}

export interface TranscriptTimedText {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface RecordingTranscriptionResult {
  text: string;
  model: string;
  createdAt: string;
  sourceFileName: string;
  sourceLabel: string;
  language?: string;
  durationSeconds?: number;
  /** Word-level timings, present when the transcription model supports them. */
  words?: TranscriptTimedText[];
  segments?: TranscriptTimedText[];
}

type FetchLike = typeof fetch;

const AUDIO_FILE_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_TIMED_ENTRIES = 20_000;

function getFileExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function isAudioMimeType(value: string | undefined): boolean {
  return Boolean(value && value.toLowerCase().startsWith('audio/'));
}

export function isRecordingTranscriptionCandidate(file: RecordingTranscriptionSourceFile): boolean {
  if (file.kind === 'audio') return true;
  if (isAudioMimeType(file.blob.type)) return true;
  return AUDIO_FILE_EXTENSIONS.has(getFileExtension(file.fileName)) && /audio|mic|voice|podcast/i.test(`${file.label} ${file.fileName}`);
}

export function selectRecordingTranscriptionCandidate(
  files: RecordingTranscriptionSourceFile[]
): RecordingTranscriptionSourceFile | null {
  return files.find((file) => file.kind === 'audio')
    || files.find((file) => isAudioMimeType(file.blob.type))
    || files.find(isRecordingTranscriptionCandidate)
    || null;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '_').slice(0, 120);
}

async function readTranscriptionError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `Studio server returned ${response.status}. Please try again.`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Fall through to the generic error.
  }
  return `Studio server returned ${response.status}. Please try again.`;
}

export async function requestRecordingTranscription(
  file: RecordingTranscriptionSourceFile,
  language?: string,
  fetchImpl: FetchLike = fetch
): Promise<RecordingTranscriptionResult> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(buildApiUrl('/api/transcriptions'), {
      method: 'POST',
      headers: {
        'Content-Type': file.blob.type || 'application/octet-stream',
        'X-File-Name': sanitizeHeaderValue(file.fileName),
        ...(language ? { 'X-Transcription-Language': sanitizeHeaderValue(language) } : {}),
      },
      body: file.blob,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiRequestError('Transcript generation timed out. Please try a shorter audio track.', { timedOut: true, cause: err });
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new ApiRequestError(await readTranscriptionError(response), { status: response.status });
  }

  const data = await response.json().catch(() => null) as {
    text?: unknown;
    model?: unknown;
    language?: unknown;
    durationSeconds?: unknown;
    words?: unknown;
    segments?: unknown;
  } | null;
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  const model = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : 'whisper-1';
  if (!text) throw new ApiRequestError('Transcript generation returned no text.');

  const durationSeconds = Number(data?.durationSeconds);
  const words = parseTranscriptTimedText(data?.words);
  const segments = parseTranscriptTimedText(data?.segments);
  return {
    text,
    model,
    createdAt: new Date().toISOString(),
    sourceFileName: file.fileName,
    sourceLabel: file.label,
    ...(typeof data?.language === 'string' && data.language.trim() ? { language: data.language.trim() } : {}),
    ...(Number.isFinite(durationSeconds) && durationSeconds >= 0 ? { durationSeconds } : {}),
    ...(words.length > 0 ? { words } : {}),
    ...(segments.length > 0 ? { segments } : {}),
  };
}

export function parseTranscriptTimedText(value: unknown): TranscriptTimedText[] {
  if (!Array.isArray(value)) return [];
  const entries: TranscriptTimedText[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { text?: unknown; startSeconds?: unknown; endSeconds?: unknown };
    const text = typeof entry.text === 'string' ? entry.text : '';
    const startSeconds = Number(entry.startSeconds);
    const endSeconds = Number(entry.endSeconds);
    if (!text.trim()) continue;
    if (!Number.isFinite(startSeconds) || startSeconds < 0) continue;
    if (!Number.isFinite(endSeconds) || endSeconds < startSeconds) continue;
    entries.push({ text, startSeconds, endSeconds });
    if (entries.length >= MAX_TRANSCRIPT_TIMED_ENTRIES) break;
  }
  return entries;
}
