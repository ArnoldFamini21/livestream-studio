import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gatePcmChannels, isPcmGateClosed, PcmWavRecorder } from '../src/utils/pcmWavRecorder.ts';
import { WAV_HEADER_BYTES } from '../src/utils/wavStream.ts';

type Gate = { enabled: boolean; readyState: MediaStreamTrackState };

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown) {
    if (message === 'flush') queueMicrotask(() => this.onmessage?.({ data: { flushed: true } } as MessageEvent));
  }
}

let lastNode: { port: FakePort } | null = null;

class FakeWorkletNode {
  port = new FakePort();
  constructor() { lastNode = this; }
  connect() {}
  disconnect() {}
}

function fakeContext(): AudioContext {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  return {
    sampleRate: 48_000,
    state: 'running',
    destination: {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: node,
    createGain: node,
    resume: async () => {},
    close: async () => {},
  } as unknown as AudioContext;
}

function fakeStream(): MediaStream {
  const track = { getSettings: () => ({ channelCount: 1 }) };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

describe('lossless WAV mute gate', () => {
  it('treats a disabled or ended gate as closed and no gate as open', () => {
    assert.equal(isPcmGateClosed(undefined), false);
    assert.equal(isPcmGateClosed({ enabled: true, readyState: 'live' }), false);
    assert.equal(isPcmGateClosed({ enabled: false, readyState: 'live' }), true);
    assert.equal(isPcmGateClosed({ enabled: true, readyState: 'ended' }), true);
  });

  it('replaces a muted batch with silence of the same length', () => {
    const speech = [new Float32Array([0.5, -0.25, 0.75])];
    assert.equal(gatePcmChannels(speech, { enabled: true, readyState: 'live' }), speech);
    const gated = gatePcmChannels(speech, { enabled: false, readyState: 'live' });
    assert.equal(gated[0].length, 3);
    assert.deepEqual([...gated[0]], [0, 0, 0]);
    assert.deepEqual([...speech[0]], [0.5, -0.25, 0.75], 'the input batch is not modified');
  });

  it('writes zeroed PCM frames while the participant is muted', async () => {
    const previous = (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeWorkletNode;
    try {
      const gate: Gate = { enabled: true, readyState: 'live' };
      const recorder = new PcmWavRecorder(fakeStream(), {
        createContext: fakeContext,
        gateTrack: gate as unknown as MediaStreamTrack,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = ({ data }) => { chunks.push(data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = resolve; });
      recorder.start(60_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const port = lastNode!.port;
      const batch = () => ({ data: { channels: [new Float32Array([0.5, 0.5])] } } as MessageEvent);
      port.onmessage!(batch());
      gate.enabled = false;
      port.onmessage!(batch());
      gate.enabled = true;
      gate.readyState = 'ended';
      port.onmessage!(batch());
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()).slice(WAV_HEADER_BYTES);
      assert.equal(bytes.length, 3 * 2 * 3, 'three batches of two 24-bit frames keep the timeline');
      assert.ok(bytes.slice(0, 6).some((value) => value !== 0), 'unmuted speech is recorded');
      assert.deepEqual([...bytes.slice(6)], new Array(12).fill(0), 'muted and ended batches are silent');
    } finally {
      (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = previous;
    }
  });
});
