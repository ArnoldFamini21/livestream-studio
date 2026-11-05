import type { ProgramAudioGraph } from './programAudioMixer.ts';

export interface WebAudioInputHandle {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}

const GAIN_SMOOTHING_SECONDS = 0.05;

/** Web Audio implementation of the mixer graph: track -> gain -> destination. */
export function createWebAudioProgramGraph(
  context: AudioContext,
  destination: AudioNode
): ProgramAudioGraph<MediaStreamTrack, WebAudioInputHandle> {
  return {
    connectTrack(track, gainValue) {
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const gain = context.createGain();
      gain.gain.value = gainValue;
      source.connect(gain);
      gain.connect(destination);
      return { source, gain };
    },
    setGain(handle, gainValue) {
      handle.gain.gain.setTargetAtTime(gainValue, context.currentTime, GAIN_SMOOTHING_SECONDS);
    },
    disconnect(handle) {
      try {
        handle.source.disconnect();
      } finally {
        handle.gain.disconnect();
      }
    },
  };
}

/**
 * A permanently connected silent source. It keeps the destination track
 * producing samples when nobody is audible, so encoders that wait on audio
 * (MediaRecorder, the RTMP relay) never stall.
 */
export function connectSilentKeepAlive(context: AudioContext, destination: AudioNode): () => void {
  if (typeof context.createConstantSource === 'function') {
    const source = context.createConstantSource();
    source.offset.value = 0;
    source.connect(destination);
    source.start();
    return () => {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    };
  }
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();
  return () => {
    try {
      oscillator.stop();
    } catch {
      // Already stopped.
    }
    oscillator.disconnect();
    gain.disconnect();
  };
}
