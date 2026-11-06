import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import viteConfig from '../vite.config.ts';
import { PCM_WAV_WORKLET_NAME, PCM_WAV_WORKLET_URL } from '../src/utils/pcmWavRecorder.ts';

type Posted = { message: unknown; transfer?: unknown[] };

interface TapProcessor {
  port: { onmessage: ((event: { data: unknown }) => void) | null; posted: Posted[] };
  process(inputs: Float32Array[][]): boolean;
}

function loadWorklet() {
  const registered = new Map<string, new (options: unknown) => TapProcessor>();
  class FakePort {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    posted: Posted[] = [];
    postMessage(message: unknown, transfer?: unknown[]) { this.posted.push({ message, transfer }); }
  }
  class AudioWorkletProcessor { port = new FakePort(); }
  const context = vm.createContext({
    AudioWorkletProcessor,
    Float32Array,
    Math,
    registerProcessor: (name: string, ctor: new (options: unknown) => TapProcessor) => { registered.set(name, ctor); },
  });
  vm.runInContext(readFileSync(fileURLToPath(PCM_WAV_WORKLET_URL), 'utf8'), context);
  return registered;
}

describe('lossless WAV worklet', () => {
  it('loads from a same-origin file, not a blob: or data: URL the CSP would refuse', () => {
    assert.equal(PCM_WAV_WORKLET_URL.protocol, 'file:');
    assert.ok(existsSync(fileURLToPath(PCM_WAV_WORKLET_URL)), 'worklet module exists next to the recorder');
    const inlineLimit = (viteConfig as { build: { assetsInlineLimit: (file: string, content: Buffer) => boolean | undefined } })
      .build.assetsInlineLimit;
    assert.equal(inlineLimit('/src/utils/pcmWavTap.worklet.js', Buffer.from('x')), false, 'never inlined as data:');
    assert.equal(inlineLimit('/src/assets/icon.svg', Buffer.from('x')), undefined, 'other assets keep the default');
  });

  it('registers the processor name the recorder creates', () => {
    const registered = loadWorklet();
    assert.deepEqual([...registered.keys()], [PCM_WAV_WORKLET_NAME]);
  });

  it('posts full batches, flushes partial ones on pause and on request', () => {
    const Tap = loadWorklet().get(PCM_WAV_WORKLET_NAME)!;
    const tap = new Tap({ processorOptions: { channels: 1, batchFrames: 200 } });
    const block = new Float32Array(128).fill(0.5);
    tap.process([[block]]);
    assert.equal(tap.port.posted.length, 0);
    tap.process([[block]]);
    assert.equal(tap.port.posted.length, 1);
    const first = tap.port.posted[0].message as { channels: Float32Array[] };
    assert.equal(first.channels[0].length, 200);

    tap.port.onmessage!({ data: 'flush' });
    const flushed = tap.port.posted.slice(1).map((entry) => entry.message as { channels?: Float32Array[]; flushed?: boolean });
    assert.equal(flushed[0].channels![0].length, 56);
    assert.equal(flushed[1].flushed, true, 'flush is acknowledged');

    tap.process([[block]]);
    tap.port.onmessage!({ data: 'pause' });
    const afterPause = tap.port.posted.length;
    assert.equal((tap.port.posted[afterPause - 1].message as { channels: Float32Array[] }).channels[0].length, 128);
    tap.process([[block]]);
    assert.equal(tap.port.posted.length, afterPause, 'nothing is captured while paused');
  });

  it('copies a mono input to both channels and pads silence when there is no input', () => {
    const Tap = loadWorklet().get(PCM_WAV_WORKLET_NAME)!;
    const tap = new Tap({ processorOptions: { channels: 2, batchFrames: 128 } });
    tap.process([[new Float32Array(128).fill(0.25)]]);
    const { channels } = tap.port.posted[0].message as { channels: Float32Array[] };
    assert.equal(channels.length, 2);
    assert.equal(channels[1][0], 0.25, 'mono input is copied to both channels');
    tap.process([]);
    const silent = (tap.port.posted[1].message as { channels: Float32Array[] }).channels;
    assert.ok(silent.every((channel) => channel.length === 128 && channel.every((sample) => sample === 0)));
  });
});
