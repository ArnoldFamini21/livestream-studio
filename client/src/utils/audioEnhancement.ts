import type { AudioProcessingPreferences } from './mediaPreferences.ts';
import {
  createAiNoiseRemovalNode,
  disposeAiNoiseRemovalNode,
  type AiNoiseRemovalStatus,
} from './aiNoiseRemoval.ts';
import { usesAiNoiseRemoval } from './audioProcessing.ts';

type BrowserAudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext;

export interface VoiceGateState {
  noiseFloor: number;
  targetGain: number;
  open: boolean;
}

export interface VoiceEnhancementProfile {
  minFloor: number;
  maxFloor: number;
  openOffset: number;
  holdGain: number;
  closedGain: number;
  highPassHz: number;
  lowPassHz: number;
  compressorThreshold: number;
  compressorRatio: number;
  gateOpenTimeConstant: number;
  gateCloseTimeConstant: number;
}

export interface EnhancedAudioStream {
  stream: MediaStream;
  sourceTrack: MediaStreamTrack | null;
  outputTrack: MediaStreamTrack | null;
  enhanced: boolean;
  /** Settles once the RNNoise stage is running ('active') or known not to ('off' / 'unavailable'). */
  aiNoiseRemoval: Promise<AiNoiseRemovalStatus>;
  cleanup: (options?: { stopSource?: boolean }) => void;
}

export const STANDARD_VOICE_ENHANCEMENT_PROFILE: VoiceEnhancementProfile = {
  minFloor: 0.006,
  maxFloor: 0.08,
  openOffset: 0.018,
  holdGain: 0.52,
  closedGain: 0.24,
  highPassHz: 90,
  lowPassHz: 14_500,
  compressorThreshold: -32,
  compressorRatio: 2.8,
  gateOpenTimeConstant: 0.018,
  gateCloseTimeConstant: 0.055,
};

export const STUDIO_VOICE_ENHANCEMENT_PROFILE: VoiceEnhancementProfile = {
  minFloor: 0.005,
  maxFloor: 0.075,
  openOffset: 0.015,
  holdGain: 0.42,
  closedGain: 0.12,
  highPassHz: 110,
  lowPassHz: 12_500,
  compressorThreshold: -34,
  compressorRatio: 3.6,
  gateOpenTimeConstant: 0.014,
  gateCloseTimeConstant: 0.075,
};

export function getVoiceEnhancementProfile(preferences: AudioProcessingPreferences): VoiceEnhancementProfile {
  return preferences.voiceIsolation
    ? STUDIO_VOICE_ENHANCEMENT_PROFILE
    : STANDARD_VOICE_ENHANCEMENT_PROFILE;
}

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

export function getVoiceGateState(
  inputRms: number,
  previousNoiseFloor = STANDARD_VOICE_ENHANCEMENT_PROFILE.minFloor,
  profile: VoiceEnhancementProfile = STANDARD_VOICE_ENHANCEMENT_PROFILE
): VoiceGateState {
  const boundedRms = Math.max(0, Math.min(1, Number.isFinite(inputRms) ? inputRms : 0));
  const boundedFloor = Math.max(
    profile.minFloor,
    Math.min(profile.maxFloor, Number.isFinite(previousNoiseFloor) ? previousNoiseFloor : profile.minFloor)
  );
  const floorCandidate = Math.min(boundedRms, boundedFloor + 0.012);
  const noiseFloor = boundedRms < boundedFloor
    ? boundedFloor * 0.82 + boundedRms * 0.18
    : boundedFloor * 0.97 + floorCandidate * 0.03;
  const openThreshold = Math.max(profile.minFloor + profile.openOffset, noiseFloor + profile.openOffset);
  const open = boundedRms >= openThreshold;
  const targetGain = open
    ? 1
    : boundedRms >= noiseFloor + profile.openOffset * 0.45
      ? profile.holdGain
      : profile.closedGain;

  return {
    noiseFloor,
    targetGain,
    open,
  };
}


export interface EnhancedAudioStreamOptions {
  /** Builds the RNNoise node; injectable for tests. */
  createDenoiser?: (context: AudioContext) => Promise<AudioNode>;
  /** Frees a node createDenoiser made. */
  disposeDenoiser?: (node: AudioNode) => void;
}

export function createEnhancedAudioStream(
  inputStream: MediaStream,
  preferences: AudioProcessingPreferences,
  options: EnhancedAudioStreamOptions = {}
): EnhancedAudioStream {
  const sourceTrack = inputStream.getAudioTracks()[0] || null;
  const wantsAiNoiseRemoval = usesAiNoiseRemoval(preferences);
  const passthrough = (): EnhancedAudioStream => ({
    stream: inputStream,
    sourceTrack,
    outputTrack: sourceTrack,
    enhanced: false,
    aiNoiseRemoval: Promise.resolve(wantsAiNoiseRemoval ? 'unavailable' : 'off'),
    cleanup: ({ stopSource = false } = {}) => {
      if (stopSource) sourceTrack?.stop();
    },
  });

  // Music mode is original sound: no gate, filters or compressor either.
  if (!sourceTrack || preferences.musicMode) return passthrough();
  if (!preferences.noiseSuppression && !preferences.voiceIsolation && !wantsAiNoiseRemoval) return passthrough();

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) return passthrough();

  try {
    const profile = getVoiceEnhancementProfile(preferences);
    const audioContext = createVoiceAudioContext(AudioContextConstructor);
    const source = audioContext.createMediaStreamSource(new MediaStream([sourceTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;

    const highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = profile.highPassHz;
    highPass.Q.value = 0.7;

    const gateGain = audioContext.createGain();
    gateGain.gain.value = 1;

    const lowPass = audioContext.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = profile.lowPassHz;
    lowPass.Q.value = 0.5;

    const compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = profile.compressorThreshold;
    compressor.knee.value = 18;
    compressor.ratio.value = profile.compressorRatio;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.18;

    const destination = audioContext.createMediaStreamDestination();
    source.connect(analyser);
    source.connect(highPass);
    highPass.connect(gateGain);
    gateGain.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(destination);

    let denoiser: AudioNode | null = null;
    let closed = false;
    const samples = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
    let gateState = getVoiceGateState(profile.minFloor, profile.minFloor, profile);
    const gateTimer = window.setInterval(() => {
      if (denoiser) {
        // RNNoise already removes the noise between words; gating on top of it pumps.
        gateGain.gain.setTargetAtTime(1, audioContext.currentTime, profile.gateOpenTimeConstant);
        return;
      }
      const rms = getTimeDomainRms(analyser, samples);
      gateState = getVoiceGateState(rms, gateState.noiseFloor, profile);
      gateGain.gain.setTargetAtTime(
        gateState.targetGain,
        audioContext.currentTime,
        gateState.open ? profile.gateOpenTimeConstant : profile.gateCloseTimeConstant
      );
    }, 40);

    const outputTrack = destination.stream.getAudioTracks()[0] || null;
    if (!outputTrack) {
      window.clearInterval(gateTimer);
      void audioContext.close();
      return passthrough();
    }

    const createDenoiser = options.createDenoiser ?? createAiNoiseRemovalNode;
    const disposeDenoiser = options.disposeDenoiser
      ?? ((node: AudioNode) => disposeAiNoiseRemovalNode(node as AudioWorkletNode));
    const aiNoiseRemoval: Promise<AiNoiseRemovalStatus> = !wantsAiNoiseRemoval
      ? Promise.resolve('off')
      : createDenoiser(audioContext).then((node) => {
        if (closed) {
          disposeDenoiser(node);
          return 'off' as const;
        }
        // Splice RNNoise in right after the mic, ahead of the filters and the
        // meter; both changes land in the same render quantum.
        source.disconnect();
        source.connect(node);
        node.connect(analyser);
        node.connect(highPass);
        denoiser = node;
        return 'active' as const;
      }, (error: unknown) => {
        console.warn('AI noise removal is unavailable; using the browser noise suppressor:', error);
        // The browser suppressor was switched off for RNNoise; ask for it back.
        if (!closed && preferences.noiseSuppression && typeof sourceTrack.applyConstraints === 'function') {
          const current = typeof sourceTrack.getConstraints === 'function' ? sourceTrack.getConstraints() : {};
          void sourceTrack.applyConstraints({ ...current, noiseSuppression: { ideal: true } }).catch(() => {});
        }
        return closed ? 'off' as const : 'unavailable' as const;
      });

    outputTrack.enabled = sourceTrack.enabled;
    const stream = new MediaStream();
    stream.addTrack(outputTrack);
    for (const videoTrack of inputStream.getVideoTracks()) stream.addTrack(videoTrack);

    return {
      stream,
      sourceTrack,
      outputTrack,
      enhanced: true,
      aiNoiseRemoval,
      cleanup: ({ stopSource = false } = {}) => {
        closed = true;
        window.clearInterval(gateTimer);
        try { source.disconnect(); } catch { /* already disconnected */ }
        if (denoiser) disposeDenoiser(denoiser);
        denoiser = null;
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
