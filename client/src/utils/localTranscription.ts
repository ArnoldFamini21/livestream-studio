/**
 * Free, private transcription in the browser: decodes the track one 30 s
 * window at a time (audioWindowReader), runs Whisper in a Web Worker
 * (workers/transcription.worker.ts) and stitches the word timings back onto
 * the track timeline (transcriptionWindows). Nothing is uploaded; only the
 * model weights are downloaded once and cached by the browser.
 */
import type { TranscriptWord } from './transcriptCleanup.ts';
import { openAudioWindowReader, type AudioWindowReader } from './audioWindowReader.ts';
import {
  buildTranscriptTextFromWords,
  isSilentWindow,
  mapWindowWords,
  planTranscriptionWindows,
  stitchTranscriptWords,
  toWhisperLanguage,
  type TranscriptionWindow,
  type WhisperWordChunk,
} from './transcriptionWindows.ts';
import { getBrowserWhisperModel, type BrowserWhisperModelId } from './transcriptionSettings.ts';
import type { TranscriptionWorkerRequest, TranscriptionWorkerResponse } from '../workers/transcription.worker.ts';

export type TranscriptionProgressPhase = 'preparing' | 'loading-model' | 'transcribing' | 'uploading';

export interface TranscriptionProgress {
  phase: TranscriptionProgressPhase;
  /** 0..1 for the current phase. */
  fraction: number;
  /** Short human-readable status, e.g. "Downloading the speech model (42 of 80 MB)". */
  detail: string;
}

export interface LocalTranscriptionOptions {
  model?: BrowserWhisperModelId;
  language?: string;
  signal?: AbortSignal;
  onProgress?: (progress: TranscriptionProgress) => void;
  /** Test seams. */
  createWorker?: () => TranscriptionWorkerLike;
  openReader?: (blob: Blob) => Promise<AudioWindowReader>;
}

export interface LocalTranscriptionResult {
  text: string;
  words: TranscriptWord[];
  model: string;
  durationSeconds: number;
  language?: string;
  device: 'webgpu' | 'wasm';
}

export interface TranscriptionWorkerLike {
  postMessage(message: TranscriptionWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<TranscriptionWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export function isLocalTranscriptionSupported(): boolean {
  return typeof Worker === 'function' && typeof WebAssembly === 'object';
}

function createDefaultWorker(): TranscriptionWorkerLike {
  return new Worker(new URL('../workers/transcription.worker.ts', import.meta.url), {
    type: 'module',
    name: 'studio-transcription',
  }) as unknown as TranscriptionWorkerLike;
}

function abortError(): DOMException {
  return new DOMException('Transcription was cancelled', 'AbortError');
}

/** Sums per-file download progress so the bar covers every weight file. */
export function summarizeModelDownload(files: Map<string, { loaded: number; total: number }>): { loaded: number; total: number } {
  let loaded = 0;
  let total = 0;
  for (const file of files.values()) {
    loaded += Math.min(file.loaded, file.total || file.loaded);
    total += file.total;
  }
  return { loaded, total };
}

export async function transcribeRecordingLocally(blob: Blob, options: LocalTranscriptionOptions = {}): Promise<LocalTranscriptionResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) throw abortError();
  const model = getBrowserWhisperModel(options.model);
  const language = toWhisperLanguage(options.language);

  onProgress?.({ phase: 'preparing', fraction: 0, detail: 'Reading the audio track' });
  const reader = await (options.openReader || openAudioWindowReader)(blob);
  const worker = (options.createWorker || createDefaultWorker)();
  let nextRequestId = 1;
  const pending = new Map<number, { resolve: (value: WhisperWordChunk[]) => void; reject: (error: Error) => void }>();
  let loadSettled = false;
  let resolveLoad: (device: 'webgpu' | 'wasm') => void = () => undefined;
  let rejectLoad: (error: Error) => void = () => undefined;
  const loaded = new Promise<'webgpu' | 'wasm'>((resolve, reject) => {
    resolveLoad = resolve;
    rejectLoad = reject;
  });
  const downloads = new Map<string, { loaded: number; total: number }>();

  const failAll = (error: Error) => {
    if (!loadSettled) {
      loadSettled = true;
      rejectLoad(error);
    }
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const onAbort = () => failAll(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });

  worker.addEventListener('message', (event: MessageEvent<TranscriptionWorkerResponse>) => {
    const message = event.data;
    if (message.type === 'load-progress') {
      downloads.set(message.file, { loaded: message.loaded, total: message.total });
      const summary = summarizeModelDownload(downloads);
      const totalMb = Math.max(summary.total, model.approxDownloadMb * 1e6) / 1e6;
      onProgress?.({
        phase: 'loading-model',
        fraction: summary.total > 0 ? Math.min(1, summary.loaded / Math.max(summary.total, 1)) : 0,
        detail: `Downloading the speech model (${Math.round(summary.loaded / 1e6)} of ${Math.round(totalMb)} MB, once per browser)`,
      });
    } else if (message.type === 'ready') {
      if (!loadSettled) {
        loadSettled = true;
        resolveLoad(message.device);
      }
    } else if (message.type === 'result') {
      pending.get(message.id)?.resolve(message.chunks);
      pending.delete(message.id);
    } else if (message.type === 'error') {
      const error = new Error(message.message || 'Transcription failed');
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)?.reject(error);
        pending.delete(message.id);
      } else {
        failAll(error);
      }
    }
  });
  worker.addEventListener('error', (event: ErrorEvent) => {
    failAll(new Error(event.message || 'The transcription worker stopped'));
  });

  const transcribeWindow = (audio: Float32Array): Promise<WhisperWordChunk[]> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'transcribe', id, audio, ...(language ? { language } : {}) }, [audio.buffer]);
  });

  try {
    onProgress?.({ phase: 'loading-model', fraction: 0, detail: 'Loading the speech model' });
    worker.postMessage({ type: 'load', repo: model.repo, preferWebGpu: true });
    const device = await loaded;

    const windows = planTranscriptionWindows(reader.durationSeconds);
    if (windows.length === 0) throw new Error('The audio track is empty');
    const perWindow: TranscriptWord[][] = [];
    const startedAt = Date.now();
    for (const window of windows) {
      if (signal?.aborted) throw abortError();
      const audio = await reader.readWindow(window.startSeconds, window.endSeconds);
      if (audio.length > 0 && !isSilentWindow(audio)) {
        perWindow.push(mapWindowWords(window, await transcribeWindow(audio)));
      }
      onProgress?.({
        phase: 'transcribing',
        fraction: (window.index + 1) / windows.length,
        detail: describeTranscriptionProgress(window, windows, reader.durationSeconds, Date.now() - startedAt, device),
      });
    }
    const words = stitchTranscriptWords(perWindow);
    const text = buildTranscriptTextFromWords(words);
    if (!text) throw new Error('No speech was found in this track.');
    return {
      text,
      words,
      model: `${model.repo.split('/').pop()} (in browser, ${device === 'webgpu' ? 'WebGPU' : 'CPU'})`,
      durationSeconds: reader.durationSeconds,
      ...(language ? { language } : {}),
      device,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    worker.terminate();
    reader.close();
  }
}

export function describeTranscriptionProgress(
  window: TranscriptionWindow,
  windows: TranscriptionWindow[],
  durationSeconds: number,
  elapsedMs: number,
  device: 'webgpu' | 'wasm'
): string {
  const done = Math.min(durationSeconds, window.endSeconds);
  const remainingWindows = windows.length - window.index - 1;
  const perWindowMs = elapsedMs / Math.max(1, window.index + 1);
  const remainingSeconds = Math.round((remainingWindows * perWindowMs) / 1000);
  const eta = remainingWindows > 0 && remainingSeconds > 0 ? `, about ${formatDuration(remainingSeconds)} left` : '';
  return `Transcribed ${formatDuration(done)} of ${formatDuration(durationSeconds)} on ${device === 'webgpu' ? 'the GPU' : 'the CPU'}${eta}`;
}

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
