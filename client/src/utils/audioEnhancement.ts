import type { AudioProcessingPreferences } from './mediaPreferences.ts';

type BrowserAudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext;

export interface VoiceGateState {
  noiseFloor: number;
  targetGain: number;
  open: boolean;
}

export interface EnhancedAudioStream {
  stream: MediaStream;
  sourceTrack: MediaStreamTrack | null;
  outputTrack: MediaStreamTrack | null;
  enhanced: boolean;
  cleanup: (options?: { stopSource?: boolean }) => void;
}

const VOICE_GATE_MIN_FLOOR = 0.006;
const VOICE_GATE_MAX_FLOOR = 0.08;
const VOICE_GATE_OPEN_OFFSET = 0.018;
const VOICE_GATE_CLOSED_GAIN = 0.24;
const VOICE_GATE_HOLD_GAIN = 0.52;

function getAudioContextConstructor(): BrowserAudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const globalWithWebkit = window as unknown as {
    AudioContext?: BrowserAudioContextConstructor;
    webkitAudioContext?: BrowserAudioContextConstructor;
  };
  return globalWithWebkit.AudioContext || globalWithWebkit.webkitAudioContext || null;
}

function createVoiceAudioContext(AudioContextConstructor: BrowserAudioContextConstructor): AudioContext {
  try {
    return new AudioContextConstructor({ sampleRate: 48_000 });
  } catch {
    return new AudioContextConstructor();
  }
}

function getTimeDomainRms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export function getVoiceGateState(inputRms: number, previousNoiseFloor = VOICE_GATE_MIN_FLOOR): VoiceGateState {
  const boundedRms = Math.max(0, Math.min(1, Number.isFinite(inputRms) ? inputRms : 0));
  const boundedFloor = Math.max(
    VOICE_GATE_MIN_FLOOR,
    Math.min(VOICE_GATE_MAX_FLOOR, Number.isFinite(previousNoiseFloor) ? previousNoiseFloor : VOICE_GATE_MIN_FLOOR)
  );
  const floorCandidate = Math.min(boundedRms, boundedFloor + 0.012);
  const noiseFloor = boundedRms < boundedFloor
    ? boundedFloor * 0.82 + boundedRms * 0.18
    : boundedFloor * 0.97 + floorCandidate * 0.03;
  const openThreshold = Math.max(VOICE_GATE_MIN_FLOOR + VOICE_GATE_OPEN_OFFSET, noiseFloor + VOICE_GATE_OPEN_OFFSET);
  const open = boundedRms >= openThreshold;
  const targetGain = open
    ? 1
    : boundedRms >= noiseFloor + VOICE_GATE_OPEN_OFFSET * 0.45
      ? VOICE_GATE_HOLD_GAIN
      : VOICE_GATE_CLOSED_GAIN;

  return {
    noiseFloor,
    targetGain,
    open,
  };
}

export function createEnhancedAudioStream(
  inputStream: MediaStream,
  preferences: AudioProcessingPreferences
): EnhancedAudioStream {
  const sourceTrack = inputStream.getAudioTracks()[0] || null;
  const passthrough = (): EnhancedAudioStream => ({
    stream: inputStream,
    sourceTrack,
    outputTrack: sourceTrack,
    enhanced: false,
    cleanup: ({ stopSource = false } = {}) => {
      if (stopSource) sourceTrack?.stop();
    },
  });

  if (!sourceTrack || !preferences.noiseSuppression) return passthrough();

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) return passthrough();

  try {
    const audioContext = createVoiceAudioContext(AudioContextConstructor);
    const source = audioContext.createMediaStreamSource(new MediaStream([sourceTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;

    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 90;
    highPass.Q.value = 0.7;

    const gateGain = audioContext.createGain();
    gateGain.gain.value = 1;

    const lowPass = audioContext.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 14_500;
    lowPass.Q.value = 0.5;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -32;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.8;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const destination = audioContext.createMediaStreamDestination();
    source.connect(analyser);
    source.connect(highPass);
    highPass.connect(gateGain);
    gateGain.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(destination);

    const samples = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
    let gateState = getVoiceGateState(VOICE_GATE_MIN_FLOOR);
    const gateTimer = window.setInterval(() => {
      const rms = getTimeDomainRms(analyser, samples);
      gateState = getVoiceGateState(rms, gateState.noiseFloor);
      gateGain.gain.setTargetAtTime(gateState.targetGain, audioContext.currentTime, gateState.open ? 0.018 : 0.055);
    }, 40);

    const outputTrack = destination.stream.getAudioTracks()[0] || null;
    if (!outputTrack) {
      window.clearInterval(gateTimer);
      void audioContext.close();
      return passthrough();
    }

    outputTrack.enabled = sourceTrack.enabled;
    const stream = new MediaStream();
    stream.addTrack(outputTrack);
    for (const videoTrack of inputStream.getVideoTracks()) stream.addTrack(videoTrack);

    return {
      stream,
      sourceTrack,
      outputTrack,
      enhanced: true,
      cleanup: ({ stopSource = false } = {}) => {
        window.clearInterval(gateTimer);
        try { source.disconnect(); } catch { /* already disconnected */ }
        try { analyser.disconnect(); } catch { /* already disconnected */ }
        try { highPass.disconnect(); } catch { /* already disconnected */ }
        try { gateGain.disconnect(); } catch { /* already disconnected */ }
        try { lowPass.disconnect(); } catch { /* already disconnected */ }
        try { compressor.disconnect(); } catch { /* already disconnected */ }
        outputTrack.stop();
        if (stopSource) sourceTrack.stop();
        if (audioContext.state !== 'closed') {
          void audioContext.close();
        }
      },
    };
  } catch {
    return passthrough();
  }
}
