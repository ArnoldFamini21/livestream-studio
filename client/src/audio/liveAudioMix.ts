import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import {
  ProgramAudioMixer,
  type ProgramAudioInput,
  type ProgramAudioMixerChanges,
} from './programAudioMixer.ts';
import { connectSilentKeepAlive, createWebAudioProgramGraph, type WebAudioInputHandle } from './webAudioGraph.ts';

/**
 * A mix with a stable output track: live inputs are added and swapped behind
 * it, and the media bus (effects, music, clips) is always part of it.
 */
export interface LiveAudioMix {
  readonly track: MediaStreamTrack;
  update(inputs: Iterable<ProgramAudioInput<MediaStreamTrack>>): ProgramAudioMixerChanges;
  clear(): void;
  dispose(): void;
}

export function createLiveAudioMix(bus: Pick<BroadcastAudioBus, 'getContext' | 'connectOutput'>): LiveAudioMix {
  const context = bus.getContext();
  const destination = context.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0];
  if (!track) throw new Error('Web Audio did not provide an output track.');

  const mixer = new ProgramAudioMixer<MediaStreamTrack, WebAudioInputHandle>(
    createWebAudioProgramGraph(context, destination)
  );
  const stopKeepAlive = connectSilentKeepAlive(context, destination);
  const disconnectBus = bus.connectOutput(destination);
  let disposed = false;

  return {
    track,
    update(inputs) {
      if (disposed) return { added: [], removed: [], replaced: [], regained: [], failed: [] };
      return mixer.update(inputs);
    },
    clear() {
      mixer.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mixer.clear();
      disconnectBus();
      stopKeepAlive();
      track.stop();
    },
  };
}
