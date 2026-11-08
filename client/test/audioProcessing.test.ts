import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAudioTrackConstraints,
  normalizeAudioProcessingPreferences,
  usesAiNoiseRemoval,
} from '../src/utils/audioProcessing.ts';
import {
  getVoiceEnhancementProfile,
  createEnhancedAudioStream,
  getVoiceGateState,
  STUDIO_VOICE_ENHANCEMENT_PROFILE,
  STANDARD_VOICE_ENHANCEMENT_PROFILE,
} from '../src/utils/audioEnhancement.ts';

describe('audio processing constraints', () => {
  it('defaults echo cancellation, noise suppression, and voice cleanup on', () => {
    assert.deepEqual(normalizeAudioProcessingPreferences(), {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
      aiNoiseRemoval: false,
      musicMode: false,
    });
  });

  it('preserves explicit audio processing choices', () => {
    assert.deepEqual(normalizeAudioProcessingPreferences({
      echoCancellation: false,
      noiseSuppression: true,
    }), {
      echoCancellation: false,
      noiseSuppression: true,
      voiceIsolation: true,
      aiNoiseRemoval: false,
      musicMode: false,
    });
  });

  it('builds microphone constraints with optional device targeting', () => {
    assert.deepEqual(createAudioTrackConstraints('mic-1', {
      echoCancellation: false,
      noiseSuppression: false,
      voiceIsolation: false,
    }), {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0.02 },
      deviceId: { exact: 'mic-1' },
    });
  });

  it('adds browser voice isolation hints when studio voice cleanup is enabled', () => {
    assert.deepEqual(createAudioTrackConstraints('mic-1', {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    }), {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      deviceId: { exact: 'mic-1' },
      voiceIsolation: { ideal: true },
      suppressLocalAudioPlayback: { ideal: true },
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      latency: { ideal: 0.02 },
    });
  });

  it('keeps explicit browser echo and suppression choices in advanced voice hints', () => {
    const constraints = createAudioTrackConstraints('mic-1', {
      echoCancellation: false,
      noiseSuppression: false,
      voiceIsolation: true,
    }) as MediaTrackConstraints & Record<string, unknown>;

    assert.equal(constraints.echoCancellation, false);
    assert.equal(constraints.noiseSuppression, false);
    assert.equal(constraints.googEchoCancellation, false);
    assert.equal(constraints.googNoiseSuppression, false);
    assert.equal(constraints.googHighpassFilter, true);
  });

  it('does not exact-match a device when using the browser default microphone', () => {
    assert.deepEqual(createAudioTrackConstraints('', {
      echoCancellation: true,
      noiseSuppression: false,
      voiceIsolation: false,
    }), {
      echoCancellation: { ideal: true },
      noiseSuppression: false,
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0.02 },
    });
  });

  it('uses the stronger studio voice gate profile when voice cleanup is enabled', () => {
    assert.equal(
      getVoiceEnhancementProfile({ echoCancellation: true, noiseSuppression: true, voiceIsolation: true }),
      STUDIO_VOICE_ENHANCEMENT_PROFILE
    );
    assert.equal(
      getVoiceEnhancementProfile({ echoCancellation: true, noiseSuppression: true, voiceIsolation: false }),
      STANDARD_VOICE_ENHANCEMENT_PROFILE
    );
  });

  it('keeps the voice gate open for speech above the adaptive noise floor', () => {
    const state = getVoiceGateState(0.08, 0.012);

    assert.equal(state.open, true);
    assert.equal(state.targetGain, 1);
  });

  it('reduces mic gain when input stays near the room noise floor', () => {
    const state = getVoiceGateState(0.008, 0.012);

    assert.equal(state.open, false);
    assert.ok(state.targetGain < 1);
    assert.ok(state.noiseFloor > 0);
  });

  it('attenuates steady background noise more aggressively in studio voice mode', () => {
    const standard = getVoiceGateState(0.008, 0.012, STANDARD_VOICE_ENHANCEMENT_PROFILE);
    const studio = getVoiceGateState(0.008, 0.012, STUDIO_VOICE_ENHANCEMENT_PROFILE);

    assert.equal(standard.open, false);
    assert.equal(studio.open, false);
    assert.ok(studio.targetGain < standard.targetGain);
  });
});

describe('AI noise removal and music mode constraints', () => {
  it('turns the browser noise suppressor off when RNNoise will run, and keeps it otherwise', () => {
    const withAi = createAudioTrackConstraints('mic-1', {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
      aiNoiseRemoval: true,
    }, { aiNoiseRemovalSupported: true }) as MediaTrackConstraints & Record<string, unknown>;
    assert.equal(withAi.noiseSuppression, false);
    assert.equal(withAi.googNoiseSuppression, false);
    assert.deepEqual(withAi.echoCancellation, { ideal: true });

    const unsupported = createAudioTrackConstraints('mic-1', {
      noiseSuppression: true,
      aiNoiseRemoval: true,
    }, { aiNoiseRemovalSupported: false }) as MediaTrackConstraints & Record<string, unknown>;
    assert.deepEqual(unsupported.noiseSuppression, { ideal: true });
    assert.equal(unsupported.googNoiseSuppression, true);
  });

  it('asks for unprocessed stereo capture in music mode, whatever the voice switches say', () => {
    const constraints = createAudioTrackConstraints('mic-1', {
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
      aiNoiseRemoval: true,
      musicMode: true,
    }, { aiNoiseRemovalSupported: true }) as MediaTrackConstraints & Record<string, unknown>;
    assert.equal(constraints.echoCancellation, false);
    assert.equal(constraints.noiseSuppression, false);
    assert.equal(constraints.autoGainControl, false);
    assert.deepEqual(constraints.channelCount, { ideal: 2 });
    assert.equal(constraints.googAutoGainControl, false);
    assert.equal(constraints.googHighpassFilter, false);
    assert.deepEqual(constraints.deviceId, { exact: 'mic-1' });
  });

  it('never runs RNNoise in music mode or where the browser cannot', () => {
    const base = normalizeAudioProcessingPreferences({ aiNoiseRemoval: true });
    assert.equal(usesAiNoiseRemoval(base, true), true);
    assert.equal(usesAiNoiseRemoval({ ...base, musicMode: true }, true), false);
    assert.equal(usesAiNoiseRemoval(base, false), false);
    assert.equal(usesAiNoiseRemoval({ ...base, aiNoiseRemoval: false }, true), false);
  });
});

class FakeNode {
  connections = new Set<FakeNode>();
  type = '';
  frequency = { value: 0 };
  Q = { value: 0 };
  connect(node: FakeNode) { this.connections.add(node); return node; }
  disconnect(node?: FakeNode) { if (node) this.connections.delete(node); else this.connections.clear(); }
}

class FakeTrack {
  enabled = true;
  stopped = false;
  applied: MediaTrackConstraints[] = [];
  constructor(readonly kind: 'audio' | 'video') {}
  stop() { this.stopped = true; }
  getConstraints() { return { deviceId: 'mic-1' }; }
  applyConstraints(constraints: MediaTrackConstraints) { this.applied.push(constraints); return Promise.resolve(); }
}

class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) { this.tracks = [...tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  addTrack(track: FakeTrack) { this.tracks.push(track); }
}

const fakeContexts: FakeAudioContext[] = [];
class FakeAudioContext {
  sampleRate = 48_000;
  state = 'running';
  currentTime = 0;
  nodes: FakeNode[] = [];
  source: FakeNode | null = null;
  constructor() { fakeContexts.push(this); }
  private node<T extends FakeNode>(node: T) { this.nodes.push(node); return node; }
  createMediaStreamSource() { this.source = this.node(new FakeNode()); return this.source; }
  createAnalyser() {
    return Object.assign(this.node(new FakeNode()), {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
    });
  }
  createBiquadFilter() { return this.node(new FakeNode()); }
  createGain() { return Object.assign(this.node(new FakeNode()), { gain: { value: 1, setTargetAtTime() {} } }); }
  createDynamicsCompressor() {
    return Object.assign(this.node(new FakeNode()), {
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 },
    });
  }
  createMediaStreamDestination() {
    return Object.assign(this.node(new FakeNode()), { stream: new FakeMediaStream([new FakeTrack('audio')]) });
  }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
(FakeAudioContext.prototype as unknown as { audioWorklet: object }).audioWorklet = {};

describe('processed microphone with AI noise removal', () => {
  const saved: Record<string, unknown> = {};
  const globals = ['window', 'MediaStream', 'AudioContext', 'AudioWorkletNode'] as const;
  const install = () => {
    for (const name of globals) saved[name] = (globalThis as Record<string, unknown>)[name];
    Object.assign(globalThis, {
      window: { AudioContext: FakeAudioContext, setInterval: () => 1, clearInterval: () => {} },
      MediaStream: FakeMediaStream,
      AudioContext: FakeAudioContext,
      AudioWorkletNode: class {},
    });
  };
  const restore = () => {
    for (const name of globals) (globalThis as Record<string, unknown>)[name] = saved[name];
  };
  const prefs = normalizeAudioProcessingPreferences({ aiNoiseRemoval: true });
  const input = () => new FakeMediaStream([new FakeTrack('audio'), new FakeTrack('video')]) as unknown as MediaStream;

  it('splices RNNoise between the mic and the filters once it is running', async () => {
    install();
    try {
      const denoiser = new FakeNode();
      const disposed: unknown[] = [];
      const result = createEnhancedAudioStream(input(), prefs, {
        createDenoiser: async () => denoiser as unknown as AudioNode,
        disposeDenoiser: (node) => disposed.push(node),
      });
      assert.equal(result.enhanced, true);
      assert.equal(result.stream.getVideoTracks().length, 1, 'camera stays in the stream');
      const context = fakeContexts[fakeContexts.length - 1];
      const highPass = context.nodes[2];
      assert.ok(context.source!.connections.has(highPass), 'dry until RNNoise is ready');

      assert.equal(await result.aiNoiseRemoval, 'active');
      assert.deepEqual([...context.source!.connections], [denoiser]);
      assert.ok(denoiser.connections.has(highPass));
      assert.ok(denoiser.connections.has(context.nodes[1]), 'the gate meter hears the denoised signal');

      result.cleanup();
      assert.deepEqual(disposed, [denoiser]);
      assert.equal(context.state, 'closed');
    } finally {
      restore();
    }
  });

  it('keeps the dry chain and asks for the browser suppressor back when RNNoise cannot start', async () => {
    install();
    try {
      const stream = input();
      const result = createEnhancedAudioStream(stream, prefs, {
        createDenoiser: async () => { throw new Error('no wasm'); },
      });
      assert.equal(await result.aiNoiseRemoval, 'unavailable');
      const context = fakeContexts[fakeContexts.length - 1];
      assert.ok(context.source!.connections.has(context.nodes[2]));
      const source = stream.getAudioTracks()[0] as unknown as FakeTrack;
      assert.deepEqual(source.applied, [{ deviceId: 'mic-1', noiseSuppression: { ideal: true } }]);
      result.cleanup();
    } finally {
      restore();
    }
  });

  it('frees a denoiser that finishes loading after the mic was replaced', async () => {
    install();
    try {
      let resolve: (node: AudioNode) => void = () => {};
      const disposed: unknown[] = [];
      const result = createEnhancedAudioStream(input(), prefs, {
        createDenoiser: () => new Promise<AudioNode>((done) => { resolve = done; }),
        disposeDenoiser: (node) => disposed.push(node),
      });
      result.cleanup();
      const late = new FakeNode();
      resolve(late as unknown as AudioNode);
      assert.equal(await result.aiNoiseRemoval, 'off');
      assert.deepEqual(disposed, [late]);
    } finally {
      restore();
    }
  });

  it('passes music mode through untouched', async () => {
    install();
    try {
      const stream = input();
      const result = createEnhancedAudioStream(stream, { ...prefs, musicMode: true }, {
        createDenoiser: async () => { throw new Error('must not load'); },
      });
      assert.equal(result.enhanced, false);
      assert.equal(result.stream, stream);
      assert.equal(await result.aiNoiseRemoval, 'off');
    } finally {
      restore();
    }
  });
});
