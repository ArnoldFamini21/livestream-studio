/// <reference lib="webworker" />
/**
 * In-browser Whisper transcription (transformers.js, Apache-2.0).
 *
 * The page sends one 30 s window of 16 kHz mono audio at a time and gets the
 * window's words back with timestamps relative to the window. The model runs
 * on WebGPU when the browser has an adapter and on WebAssembly (CPU)
 * otherwise. Model weights download once from the Hugging Face CDN (allowed
 * by connect-src https:) and stay in the browser's Cache API store
 * ("transformers-cache"), so later transcripts start offline-fast.
 *
 * CSP: everything executable is same-origin. Vite bundles onnxruntime-web's
 * JavaScript glue into this worker and emits its .wasm as a hashed asset, so
 * the transformers.js default of fetching both from jsDelivr is switched off
 * (wasmPaths cleared) and 'wasm-unsafe-eval' lets the binary compile. The
 * library's optional wasm cache is off too because it would re-import the
 * glue from a blob: URL, which the policy's script-src does not allow.
 */
import { env, pipeline } from '@huggingface/transformers';
import type { WhisperWordChunk } from '../utils/transcriptionWindows.ts';

export type TranscriptionWorkerRequest =
  | { type: 'load'; repo: string; preferWebGpu?: boolean }
  | { type: 'transcribe'; id: number; audio: Float32Array; language?: string };

export type TranscriptionWorkerResponse =
  | { type: 'load-progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; text: string; chunks: WhisperWordChunk[] }
  | { type: 'error'; id?: number; message: string };

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = false;
// Use the bundled onnxruntime glue and its same-origin .wasm asset instead of the CDN.
if (env.backends.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = undefined;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let transcriberPromise: Promise<Transcriber> | null = null;

function post(message: TranscriptionWorkerResponse) {
  scope.postMessage(message);
}

async function detectWebGpu(): Promise<{ available: boolean; shaderF16: boolean }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return { available: false, shaderF16: false };
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? { available: true, shaderF16: adapter.features.has('shader-f16') } : { available: false, shaderF16: false };
  } catch {
    return { available: false, shaderF16: false };
  }
}

async function createTranscriber(repo: string, preferWebGpu: boolean): Promise<Transcriber> {
  const progress_callback = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (info.status === 'progress' && info.file) {
      post({ type: 'load-progress', file: info.file, loaded: Number(info.loaded) || 0, total: Number(info.total) || 0 });
    }
  };
  const gpu = preferWebGpu ? await detectWebGpu() : { available: false, shaderF16: false };
  if (gpu.available) {
    try {
      const transcriber = await pipeline('automatic-speech-recognition', repo, {
        device: 'webgpu',
        dtype: { encoder_model: gpu.shaderF16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      post({ type: 'ready', device: 'webgpu' });
      return transcriber as unknown as Transcriber;
    } catch {
      // Some GPUs/drivers fail to build the WebGPU session; the CPU path still works.
    }
  }
  const transcriber = await pipeline('automatic-speech-recognition', repo, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback,
  });
  post({ type: 'ready', device: 'wasm' });
  return transcriber as unknown as Transcriber;
}

function normalizeChunks(value: unknown): { text: string; chunks: WhisperWordChunk[] } {
  const output = (Array.isArray(value) ? value[0] : value) as { text?: unknown; chunks?: unknown } | undefined;
  const text = typeof output?.text === 'string' ? output.text : '';
  const chunks = Array.isArray(output?.chunks)
    ? (output.chunks as Array<{ text?: unknown; timestamp?: unknown }>)
        .filter((chunk) => typeof chunk?.text === 'string' && Array.isArray(chunk.timestamp))
        .map((chunk) => ({ text: chunk.text as string, timestamp: chunk.timestamp as [number, number | null] }))
    : [];
  return { text, chunks };
}

scope.onmessage = async (event: MessageEvent<TranscriptionWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'load') {
    transcriberPromise ||= createTranscriber(message.repo, message.preferWebGpu !== false);
    try {
      await transcriberPromise;
    } catch (err) {
      transcriberPromise = null;
      post({ type: 'error', message: err instanceof Error ? err.message : 'The speech model could not load' });
    }
    return;
  }
  if (message.type === 'transcribe') {
    try {
      if (!transcriberPromise) throw new Error('The speech model is not loaded');
      const transcriber = await transcriberPromise;
      const output = await transcriber(message.audio, {
        return_timestamps: 'word',
        task: 'transcribe',
        ...(message.language ? { language: message.language } : {}),
      });
      post({ type: 'result', id: message.id, ...normalizeChunks(output) });
    } catch (err) {
      post({ type: 'error', id: message.id, message: err instanceof Error ? err.message : 'Transcription failed' });
    }
  }
};
