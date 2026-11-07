import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from 'node:vm';
import { describe, it } from 'node:test';
import viteConfig from '../vite.config.ts';
import {
  getAiNoiseRemovalStateLabel,
  RNNOISE_FRAME_SIZE,
  RNNOISE_LATENCY_FRAMES,
  RNNOISE_WORKLET_NAME,
  RNNOISE_WORKLET_URL,
  supportsWasmSimd,
} from '../src/utils/aiNoiseRemoval.ts';

interface Posted { type?: string; message?: string }

interface RnnoiseProcessor {
  port: { onmessage: ((event: { data: unknown }) => void) | null; posted: Posted[] };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type ProcessorConstructor = new (options: unknown) => RnnoiseProcessor;

function loadWorklet(): Map<string, ProcessorConstructor> {
  const registered = new Map<string, ProcessorConstructor>();
  class FakePort {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    posted: Posted[] = [];
    postMessage(message: Posted) { this.posted.push(message); }
  }
  class AudioWorkletProcessor { port = new FakePort(); }
  const context = vm.createContext({
    AudioWorkletProcessor,
    registerProcessor: (name: string, ctor: ProcessorConstructor) => { registered.set(name, ctor); },
  });
  vm.runInContext(readFileSync(fileURLToPath(RNNOISE_WORKLET_URL), 'utf8'), context);
  return registered;
}

const require = createRequire(import.meta.url);
function readWasm(file: 'rnnoise.wasm' | 'rnnoise_simd.wasm'): Uint8Array {
  const index = require.resolve('@sapphi-red/web-noise-suppressor');
  return readFileSync(new URL(`./${file}`, pathToFileURL(index)));
}

async function waitFor(processor: RnnoiseProcessor, type: string) {
  for (let i = 0; i < 400; i++) {
    if (processor.port.posted.some((message) => message.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`processor never posted ${type}: ${JSON.stringify(processor.port.posted)}`);
}

/** Feed `blocks` 128-sample blocks from `signal` and collect the output. */
function run(processor: RnnoiseProcessor, signal: (index: number) => number, blocks: number) {
  const out: number[] = [];
  for (let block = 0; block < blocks; block++) {
    const input = new Float32Array(128);
    for (let i = 0; i < 128; i++) input[i] = signal(block * 128 + i);
    const output = [new Float32Array(128)];
    assert.equal(processor.process([[input]], [output]), true);
    out.push(...output[0]);
  }
  return out;
}

const energy = (samples: number[]) => samples.reduce((sum, value) => sum + value * value, 0);

describe('AI noise removal worklet', () => {
  it('loads from a same-origin file that is never inlined as a data: URL', () => {
    assert.equal(RNNOISE_WORKLET_URL.protocol, 'file:');
    assert.ok(existsSync(fileURLToPath(RNNOISE_WORKLET_URL)));
    const inlineLimit = (viteConfig as { build: { assetsInlineLimit: (file: string, content: Buffer) => boolean | undefined } })
      .build.assetsInlineLimit;
    assert.equal(inlineLimit('/src/utils/rnnoise.worklet.js', Buffer.from('x')), false);
  });

  it('registers the processor name the node is created with', () => {
    assert.deepEqual([...loadWorklet().keys()], [RNNOISE_WORKLET_NAME]);
  });

  it('lines 128-sample blocks up with 480-sample frames at a fixed delay and never runs dry', () => {
    const Processor = loadWorklet().get(RNNOISE_WORKLET_NAME)!;
    // No model: frames pass through dry, which exposes the ring buffer timing.
    const processor = new Processor({ processorOptions: {} });
    assert.equal(processor.port.posted[0]?.type, 'error');
    const ramp = (index: number) => ((index % 1000) + 1) / 1000;
    const out = run(processor, ramp, 15 * 8); // 8 x lcm(128, 480)
    for (let i = 0; i < RNNOISE_LATENCY_FRAMES; i++) assert.equal(out[i], 0, `head start sample ${i}`);
    for (let i = RNNOISE_LATENCY_FRAMES; i < out.length; i++) {
      assert.ok(Math.abs(out[i] - ramp(i - RNNOISE_LATENCY_FRAMES)) < 1e-6, `sample ${i} is input delayed by the latency`);
    }
    assert.equal(RNNOISE_LATENCY_FRAMES < RNNOISE_FRAME_SIZE, true);
  });

  it('mixes a stereo input down to mono and stops after dispose', () => {
    const Processor = loadWorklet().get(RNNOISE_WORKLET_NAME)!;
    const processor = new Processor({ processorOptions: {} });
    const left = new Float32Array(128).fill(0.5);
    const right = new Float32Array(128).fill(-0.1);
    for (let block = 0; block < 8; block++) processor.process([[left, right]], [[new Float32Array(128)]]);
    const output = [new Float32Array(128), new Float32Array(128)];
    processor.process([[left, right]], [output]);
    assert.ok(Math.abs(output[0][127] - 0.2) < 1e-6);
    assert.deepEqual([...output[1]], [...output[0]], 'every output channel carries the mono result');
    processor.port.onmessage!({ data: { type: 'dispose' } });
    assert.equal(processor.process([[left]], [[new Float32Array(128)]]), false);
  });

  for (const file of ['rnnoise.wasm', 'rnnoise_simd.wasm'] as const) {
    it(`removes steady noise with the bundled ${file}`, async () => {
      const Processor = loadWorklet().get(RNNOISE_WORKLET_NAME)!;
      const processor = new Processor({ processorOptions: { wasmBinary: readWasm(file) } });
      await waitFor(processor, 'ready');
      // Deterministic low-frequency rumble (low-passed mulberry32 noise), like a desk fan.
      let seed = 1;
      let rumble = 0;
      const noise = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        const white = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
        rumble = 0.9 * rumble + 0.1 * white;
        return rumble * 0.5;
      };
      const out = run(processor, noise, 375); // one second
      const settled = out.slice(48_000 / 2);
      seed = 1;
      rumble = 0;
      const dry: number[] = [];
      for (let i = 0; i < out.length; i++) dry.push(noise());
      const ratio = energy(settled) / energy(dry.slice(48_000 / 2));
      assert.ok(ratio < 0.05, `noise energy kept: ${ratio}`);
      assert.ok(settled.every(Number.isFinite));
      assert.equal(processor.port.posted.some((message) => message.type === 'error'), false);
    });
  }

  it('posts an error and stays dry for a binary that is not RNNoise', async () => {
    const Processor = loadWorklet().get(RNNOISE_WORKLET_NAME)!;
    const processor = new Processor({ processorOptions: { wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) } });
    await waitFor(processor, 'error');
    const out = run(processor, () => 0.25, 10);
    assert.ok(Math.abs(out[out.length - 1] - 0.25) < 1e-6);
  });
});

describe('AI noise removal helpers', () => {
  it('detects WebAssembly SIMD (Node supports it)', () => {
    assert.equal(supportsWasmSimd(), true);
  });

  it('labels the switch from the preference and the running state', () => {
    const on = { aiNoiseRemoval: true, musicMode: false };
    assert.equal(getAiNoiseRemovalStateLabel({ aiNoiseRemoval: false, musicMode: false }, 'active'), 'Off');
    assert.equal(getAiNoiseRemovalStateLabel({ aiNoiseRemoval: true, musicMode: true }, 'active'), 'Off');
    assert.equal(getAiNoiseRemovalStateLabel(on, 'loading'), 'Loading');
    assert.equal(getAiNoiseRemovalStateLabel(on, 'active'), 'On');
    assert.equal(getAiNoiseRemovalStateLabel(on, 'unavailable'), 'Unavailable');
  });
});
