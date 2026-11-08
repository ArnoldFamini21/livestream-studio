// AudioWorklet processor for "AI noise removal" (RNNoise).
//
// It lives in its own same-origin file, loaded with
// new URL('./rnnoise.worklet.js', import.meta.url), because the production
// Content-Security-Policy (client/public/.htaccess) only allows scripts from
// 'self': AudioWorklet modules fall under script-src, so a blob: or data: URL
// would be refused. The RNNoise WebAssembly binary is fetched same-origin by
// the main thread (aiNoiseRemoval.ts) and handed over in processorOptions,
// because a worklet scope has no fetch(); compiling it needs only the
// 'wasm-unsafe-eval' the CSP already grants. Keep the processor name in sync
// with RNNOISE_WORKLET_NAME in aiNoiseRemoval.ts.
//
// RNNoise works on 480-sample frames at 48 kHz (10 ms), while the Web Audio
// render quantum is 128 samples. Input is collected into a 480-sample frame;
// each denoised frame goes into an output ring that starts with
// RNNOISE_LATENCY_FRAMES samples of silence. 448 is the largest amount by
// which a multiple of 128 overshoots a multiple of 480, so with that head
// start the ring never runs dry and the added delay is fixed at 9.3 ms.

const FRAME_SIZE = 480;
const LATENCY_FRAMES = 448;
const RING_SIZE = 2048;
// RNNoise expects samples in 16-bit PCM range, not -1..1.
const PCM_SCALE = 32768;

async function createRnnoiseEngine(wasm) {
  let memory = null;
  const imports = {
    env: {
      emscripten_memcpy_big(dest, src, num) {
        new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
      },
      emscripten_resize_heap(requestedSize) {
        const wanted = requestedSize >>> 0;
        const current = memory.buffer.byteLength;
        if (wanted <= current) return 1;
        try {
          memory.grow(Math.ceil((wanted - current) / 65536));
          return 1;
        } catch {
          return 0;
        }
      },
      __assert_fail() {
        throw new Error('RNNoise assertion failed');
      },
    },
  };
  const result = await WebAssembly.instantiate(wasm, imports);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  const exports = instance.exports;
  for (const name of ['memory', 'malloc', 'free', 'rnnoise_create', 'rnnoise_destroy', 'rnnoise_process_frame']) {
    if (!exports[name]) throw new Error(`RNNoise module is missing ${name}`);
  }
  memory = exports.memory;
  if (typeof exports.emscripten_stack_init === 'function') exports.emscripten_stack_init();
  if (typeof exports.__wasm_call_ctors === 'function') exports.__wasm_call_ctors();
  if (typeof exports.rnnoise_get_frame_size === 'function' && exports.rnnoise_get_frame_size() !== FRAME_SIZE) {
    throw new Error('Unexpected RNNoise frame size');
  }
  const state = exports.rnnoise_create(0);
  const inputPtr = exports.malloc(FRAME_SIZE * 4);
  const outputPtr = exports.malloc(FRAME_SIZE * 4);
  if (!state || !inputPtr || !outputPtr) throw new Error('RNNoise could not allocate its state');

  let heapBuffer = null;
  let inputHeap = null;
  let outputHeap = null;
  const views = () => {
    // Growing the memory detaches the old views.
    if (heapBuffer !== memory.buffer) {
      heapBuffer = memory.buffer;
      inputHeap = new Float32Array(heapBuffer, inputPtr, FRAME_SIZE);
      outputHeap = new Float32Array(heapBuffer, outputPtr, FRAME_SIZE);
    }
  };
  let destroyed = false;
  return {
    /** Denoise one 480-sample frame (-1..1) in place; returns the voice probability. */
    process(frame) {
      views();
      for (let i = 0; i < FRAME_SIZE; i++) inputHeap[i] = frame[i] * PCM_SCALE;
      const vad = exports.rnnoise_process_frame(state, outputPtr, inputPtr);
      views();
      for (let i = 0; i < FRAME_SIZE; i++) frame[i] = outputHeap[i] / PCM_SCALE;
      return vad;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      exports.rnnoise_destroy(state);
      exports.free(inputPtr);
      exports.free(outputPtr);
    },
  };
}

class StudioRnnoise extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    this.frame = new Float32Array(FRAME_SIZE);
    this.frameFill = 0;
    this.ring = new Float32Array(RING_SIZE);
    this.readIndex = 0;
    this.writeIndex = LATENCY_FRAMES;
    this.available = LATENCY_FRAMES;
    this.engine = null;
    this.bypass = false;
    this.alive = true;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'dispose') this.dispose();
      else if (data.type === 'bypass') this.bypass = Boolean(data.value);
    };
    if (processorOptions.wasmBinary) {
      this.load(processorOptions.wasmBinary);
    } else {
      this.port.postMessage({ type: 'error', message: 'RNNoise binary missing' });
    }
  }

  load(wasm) {
    createRnnoiseEngine(wasm).then((engine) => {
      if (!this.alive) {
        engine.destroy();
        return;
      }
      this.engine = engine;
      this.port.postMessage({ type: 'ready' });
    }, (error) => {
      this.port.postMessage({ type: 'error', message: String((error && error.message) || error) });
    });
  }

  dispose() {
    this.alive = false;
    if (this.engine) this.engine.destroy();
    this.engine = null;
  }

  /** Denoise the collected frame (or pass it through until the model is ready) into the ring. */
  flushFrame() {
    if (this.engine && !this.bypass) {
      try {
        this.engine.process(this.frame);
      } catch (error) {
        // A broken model must not silence the microphone: fall back to the dry signal.
        this.engine = null;
        this.port.postMessage({ type: 'error', message: String((error && error.message) || error) });
      }
    }
    for (let i = 0; i < FRAME_SIZE; i++) {
      this.ring[this.writeIndex] = this.frame[i];
      this.writeIndex = (this.writeIndex + 1) % RING_SIZE;
    }
    this.available += FRAME_SIZE;
    if (this.available > RING_SIZE) {
      // Cannot happen with a steady clock; drop the oldest audio rather than wrap.
      const overflow = this.available - RING_SIZE;
      this.readIndex = (this.readIndex + overflow) % RING_SIZE;
      this.available = RING_SIZE;
    }
    this.frameFill = 0;
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const frames = output[0] ? output[0].length : (input[0] ? input[0].length : 128);
    const channels = input.length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      if (channels === 1) sample = input[0][i];
      else if (channels > 1) {
        for (let c = 0; c < channels; c++) sample += input[c][i];
        sample /= channels;
      }
      this.frame[this.frameFill++] = sample;
      if (this.frameFill === FRAME_SIZE) this.flushFrame();
    }
    const out = output[0];
    if (out) {
      for (let i = 0; i < out.length; i++) {
        if (this.available > 0) {
          out[i] = this.ring[this.readIndex];
          this.readIndex = (this.readIndex + 1) % RING_SIZE;
          this.available--;
        } else {
          out[i] = 0;
        }
      }
      for (let c = 1; c < output.length; c++) output[c].set(out);
    }
    return true;
  }
}

registerProcessor('studio-rnnoise', StudioRnnoise);
