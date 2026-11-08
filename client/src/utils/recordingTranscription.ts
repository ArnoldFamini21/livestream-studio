import { ApiRequestError, buildApiUrl } from './apiClient.ts';
import { readAccountSessionToken } from './accountAuth.ts';
import type { LocalRecordingFileResult } from '../hooks/useLocalRecording.ts';
import type { TranscriptWord } from './transcriptCleanup.ts';
import { openAudioWindowReader, type AudioWindowReader } from './audioWindowReader.ts';
import { transcribeRecordingLocally, type TranscriptionProgress } from './localTranscription.ts';
import { WHISPER_SAMPLE_RATE, findQuietestCutOffset } from './transcriptionWindows.ts';
import {
  DEFAULT_TRANSCRIPTION_ENGINE,
  type BrowserWhisperModelId,
  type TranscriptionEngine,
} from './transcriptionSettings.ts';
import { encodePcm16Wav } from './wavEncoder.ts';

export interface RecordingTranscriptionSourceFile {
  label: string;
  fileName: string;
  blob: Blob;
  kind?: LocalRecordingFileResult['kind'];
}

export interface RecordingTranscriptionResult {
  text: string;
  model: string;
  createdAt: string;
  sourceFileName: string;
  sourceLabel: string;
  language?: string;
  durationSeconds?: number;
  /** Word timings (seconds into the source track) used by transcript cleanup. */
  words?: TranscriptWord[];
}

type FetchLike = typeof fetch;

const AUDIO_FILE_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm']);
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

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

export interface RecordingTranscriptionOptions {
  /** BCP-47 caption language, e.g. 'en-US'. */
  language?: string;
  /** 'browser' (default, free, private) or 'cloud' (the server's OpenAI route). */
  engine?: TranscriptionEngine;
  model?: BrowserWhisperModelId;
  signal?: AbortSignal;
  onProgress?: (progress: TranscriptionProgress) => void;
  fetchImpl?: FetchLike;
  /** Test seams. */
  transcribeLocally?: typeof transcribeRecordingLocally;
  openReader?: (blob: Blob) => Promise<AudioWindowReader>;
}

/**
 * Transcribes a recorded track. The default engine runs Whisper in this
 * browser, so it is free and the audio never leaves the computer; the cloud
 * engine posts to the studio server's OpenAI route when the owner set one up.
 */
export async function requestRecordingTranscription(
  file: RecordingTranscriptionSourceFile,
  options: RecordingTranscriptionOptions = {}
): Promise<RecordingTranscriptionResult> {
  if ((options.engine || DEFAULT_TRANSCRIPTION_ENGINE) === 'cloud') {
    return requestCloudRecordingTranscription(file, options);
  }
  const local = await (options.transcribeLocally || transcribeRecordingLocally)(file.blob, {
    model: options.model,
    language: options.language,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return {
    text: local.text,
    model: local.model,
    createdAt: new Date().toISOString(),
    sourceFileName: file.fileName,
    sourceLabel: file.label,
    ...(local.language ? { language: local.language } : {}),
    durationSeconds: local.durationSeconds,
    ...(local.words.length ? { words: local.words } : {}),
  };
}

/** OpenAI's upload cap is 25 MB; stay under it with headroom for the multipart envelope. */
export const CLOUD_TRANSCRIPTION_MAX_BYTES = 24 * 1024 * 1024;
/** 10 minutes of 16 kHz mono 16-bit WAV is about 19 MB. */
export const CLOUD_TRANSCRIPTION_CHUNK_SECONDS = 600;
const CLOUD_RATE_LIMIT_RETRIES = 6;

interface CloudTranscriptionPiece {
  text: string;
  model: string;
  language?: string;
  durationSeconds?: number;
  words: TranscriptWord[];
}

/**
 * The server's OpenAI route. A track over the upload cap is decoded in
 * pieces, re-encoded as 16 kHz mono WAV in about 10 minute chunks cut at the
 * quietest moment near each boundary, and transcribed chunk by chunk with the
 * word timings shifted back onto the track timeline.
 */
export async function requestCloudRecordingTranscription(
  file: RecordingTranscriptionSourceFile,
  options: RecordingTranscriptionOptions = {}
): Promise<RecordingTranscriptionResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const base = {
    createdAt: new Date().toISOString(),
    sourceFileName: file.fileName,
    sourceLabel: file.label,
  };
  if (file.blob.size <= CLOUD_TRANSCRIPTION_MAX_BYTES) {
    options.onProgress?.({ phase: 'uploading', fraction: 0, detail: 'Sending the track to the studio server' });
    const piece = await postCloudTranscription(file.blob, file.fileName, options.language, fetchImpl, options.signal);
    return {
      ...base,
      text: piece.text,
      model: piece.model,
      ...(piece.language ? { language: piece.language } : {}),
      ...(piece.durationSeconds !== undefined ? { durationSeconds: piece.durationSeconds } : {}),
      ...(piece.words.length ? { words: piece.words } : {}),
    };
  }

  options.onProgress?.({ phase: 'preparing', fraction: 0, detail: 'Splitting the long track into upload chunks' });
  const reader = await (options.openReader || openAudioWindowReader)(file.blob);
  try {
    const duration = reader.durationSeconds;
    const texts: string[] = [];
    const words: TranscriptWord[] = [];
    let model = 'whisper-1';
    let language: string | undefined;
    let start = 0;
    let chunkIndex = 0;
    const chunkCount = Math.max(1, Math.ceil(duration / CLOUD_TRANSCRIPTION_CHUNK_SECONDS));
    while (start < duration - 0.05) {
      if (options.signal?.aborted) throw new DOMException('Transcription was cancelled', 'AbortError');
      const end = Math.min(duration, start + CLOUD_TRANSCRIPTION_CHUNK_SECONDS);
      let samples = await reader.readWindow(start, end);
      let chunkEnd = end;
      if (end < duration && samples.length > 0) {
        const cut = findQuietestCutOffset(samples, WHISPER_SAMPLE_RATE);
        samples = samples.subarray(0, cut);
        chunkEnd = start + cut / WHISPER_SAMPLE_RATE;
      }
      if (samples.length === 0) break;
      options.onProgress?.({
        phase: 'uploading',
        fraction: chunkIndex / chunkCount,
        detail: `Transcribing part ${chunkIndex + 1} of about ${chunkCount} on the studio server`,
      });
      const wav = encodePcm16Wav([samples], WHISPER_SAMPLE_RATE);
      const piece = await postCloudTranscription(
        wav,
        `${file.fileName.replace(/\.[a-z0-9]+$/i, '')}-part${chunkIndex + 1}.wav`,
        options.language,
        fetchImpl,
        options.signal
      );
      if (piece.text) texts.push(piece.text);
      for (const word of piece.words) {
        words.push({ word: word.word, start: word.start + start, end: word.end + start });
      }
      model = piece.model;
      language ||= piece.language;
      start = Math.max(chunkEnd, start + 1);
      chunkIndex += 1;
    }
    const text = texts.join(' ').trim();
    if (!text) throw new ApiRequestError('Transcript generation returned no text.');
    options.onProgress?.({ phase: 'uploading', fraction: 1, detail: 'Transcript ready' });
    return {
      ...base,
      text,
      model,
      ...(language ? { language } : {}),
      durationSeconds: duration,
      ...(words.length ? { words } : {}),
    };
  } finally {
    reader.close();
  }
}

async function postCloudTranscription(
  blob: Blob,
  fileName: string,
  language: string | undefined,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined
): Promise<CloudTranscriptionPiece> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await postCloudTranscriptionOnce(blob, fileName, language, fetchImpl, signal);
    if (response.status === 429 && attempt < CLOUD_RATE_LIMIT_RETRIES) {
      // The server allows a few transcription calls per minute; wait it out between chunks.
      const retryAfter = Number(response.headers.get('Retry-After'));
      await waitFor((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15) * 1000, signal);
      continue;
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
    } | null;
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) throw new ApiRequestError('Transcript generation returned no text.');
    const durationSeconds = Number(data?.durationSeconds);
    return {
      text,
      model: typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : 'whisper-1',
      ...(typeof data?.language === 'string' && data.language.trim() ? { language: data.language.trim() } : {}),
      ...(Number.isFinite(durationSeconds) && durationSeconds >= 0 ? { durationSeconds } : {}),
      words: parseTranscriptWords(data?.words),
    };
  }
}

async function postCloudTranscriptionOnce(
  blob: Blob,
  fileName: string,
  language: string | undefined,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const accountToken = readAccountSessionToken();
  try {
    return await fetchImpl(buildApiUrl('/api/transcriptions'), {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-File-Name': sanitizeHeaderValue(fileName),
        ...(language ? { 'X-Transcription-Language': sanitizeHeaderValue(language) } : {}),
        ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}),
      },
      body: blob,
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Transcription was cancelled', 'AbortError');
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiRequestError('Transcript generation timed out. Please try again.', { timedOut: true, cause: err });
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Transcription was cancelled', 'AbortError'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Transcription was cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function parseTranscriptWords(value: unknown): TranscriptWord[] {
  if (!Array.isArray(value)) return [];
  const words: TranscriptWord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { word, start, end } = item as { word?: unknown; start?: unknown; end?: unknown };
    if (typeof word !== 'string' || !word.trim()) continue;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    words.push({ word: word.trim(), start, end });
  }
  return words;
}
