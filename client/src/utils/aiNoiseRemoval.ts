import { hasAudioWorkletSupport } from './audioWorkletSupport.ts';
/**
 * "AI noise removal": RNNoise running in an AudioWorklet on this
 * participant's own processed microphone, before it is published and before
 * it reaches the program mix. The lossless local WAV/ISO opens its own raw
 * microphone (pcmWavRecorder.openRawMicrophone), so it stays untouched.
 *
 * Everything heavy is lazy: the worklet module and the ~150 KB WebAssembly
 * binary are fetched only when the toggle is on.
 */

/** Must match registerProcessor() in rnnoise.worklet.js. */
export const RNNOISE_WORKLET_NAME = 'studio-rnnoise';
/** Same-origin module URL (Vite emits it as an asset, never inlined: see vite.config.ts). */
export const RNNOISE_WORKLET_URL = new URL('./rnnoise.worklet.js', import.meta.url);
/** RNNoise only works at 48 kHz (480-sample, 10 ms frames). */
export const RNNOISE_SAMPLE_RATE = 48_000;
export const RNNOISE_FRAME_SIZE = 480;
/** Fixed delay the worklet adds to line 128-sample render quanta up with 480-sample frames. */
export const RNNOISE_LATENCY_FRAMES = 448;
const READY_TIMEOUT_MS = 10_000;

export type AiNoiseRemovalStatus = 'off' | 'loading' | 'active' | 'unavailable';

/** The short state shown beside the AI noise removal switch. */
export function getAiNoiseRemovalStateLabel(
  preferences: { aiNoiseRemoval: boolean; musicMode: boolean },
  status: AiNoiseRemovalStatus
): string {
  if (!preferences.aiNoiseRemoval || preferences.musicMode) return 'Off';
  if (status === 'active') return 'On';
  if (status === 'unavailable') return 'Unavailable';
  return 'Loading';
}

// The smallest module using a v128 instruction (from wasm-feature-detect).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function supportsWasmSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** AudioWorklet and WebAssembly are both required; older Safari and some in-app browsers lack one. */
export function isAiNoiseRemovalSupported(): boolean {
  return typeof AudioWorkletNode !== 'undefined'
    && typeof AudioContext !== 'undefined'
    && hasAudioWorkletSupport()
    && typeof WebAssembly === 'object';
}

let wasmPromise: Promise<ArrayBuffer> | null = null;

/** Fetch (once) the RNNoise binary, the SIMD build where the browser supports it. */
export function loadRnnoiseWasm(fetchImpl: typeof fetch = fetch): Promise<ArrayBuffer> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const assets = await import('./rnnoiseAssets.ts');
      const url = supportsWasmSimd() ? assets.rnnoiseSimdWasmUrl : assets.rnnoiseWasmUrl;
      const response = await fetchImpl(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`RNNoise download failed (${response.status})`);
      return response.arrayBuffer();
    })();
    // A failed download (offline for a moment) may be retried next time.
    wasmPromise.catch(() => { wasmPromise = null; });
  }
  return wasmPromise;
}

const workletContexts = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorklet(context: AudioContext): Promise<void> {
  let loading = workletContexts.get(context);
  if (!loading) {
    loading = context.audioWorklet.addModule(RNNOISE_WORKLET_URL.href);
    workletContexts.set(context, loading);
    loading.catch(() => workletContexts.delete(context));
  }
  return loading;
}

/** Ask the processor to free its RNNoise state; the node can then be dropped. */
export function disposeAiNoiseRemovalNode(node: AudioWorkletNode) {
  try { node.port.postMessage({ type: 'dispose' }); } catch { /* port already closed */ }
  try { node.disconnect(); } catch { /* already disconnected */ }
  try { node.port.close(); } catch { /* already closed */ }
}

/**
 * Create a mono RNNoise node on a 48 kHz context. Resolves once the model is
 * running, rejects when the browser or the context cannot run it.
 */
export async function createAiNoiseRemovalNode(context: AudioContext): Promise<AudioWorkletNode> {
  if (!isAiNoiseRemovalSupported()) throw new Error('AI noise removal needs AudioWorklet and WebAssembly');
  if (context.sampleRate !== RNNOISE_SAMPLE_RATE) {
    throw new Error(`AI noise removal needs a 48 kHz audio context (got ${context.sampleRate})`);
  }
  const [wasmBinary] = await Promise.all([loadRnnoiseWasm(), ensureWorklet(context)]);
  if (context.state === 'closed') throw new Error('Audio context closed');
  const node = new AudioWorkletNode(context, RNNOISE_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { wasmBinary },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      node.port.onmessage = null;
      reject(new Error('AI noise removal did not start in time'));
    }, READY_TIMEOUT_MS);
    node.port.onmessage = (event: MessageEvent<{ type?: string; message?: string }>) => {
      if (event.data?.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (event.data?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(event.data.message || 'AI noise removal failed'));
      }
    };
  }).catch((error) => {
    disposeAiNoiseRemovalNode(node);
    throw error;
  });
  return node;
}
