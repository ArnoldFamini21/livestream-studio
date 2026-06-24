import { useCallback, useEffect, useRef, useState } from 'react';
import {
  normalizeBroadcastAudioRouting,
  type BroadcastAudioRouting,
} from '../utils/broadcastAudioRouting.ts';

export interface BroadcastAudioBus {
  stream: MediaStream | null;
  ensureStream: () => MediaStream | null;
  getContext: () => AudioContext;
  connectNode: (node: AudioNode, routing?: Partial<BroadcastAudioRouting>) => () => void;
}

function getAudioContextConstructor(): typeof AudioContext {
  const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('Web Audio is not available in this browser.');
  }
  return AudioContextConstructor;
}

export function useBroadcastAudioBus(): BroadcastAudioBus {
  const audioContextRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const getContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const AudioContextConstructor = getAudioContextConstructor();
      const audioContext = new AudioContextConstructor({ sampleRate: 48_000 });
      const destination = audioContext.createMediaStreamDestination();
      audioContextRef.current = audioContext;
      destinationRef.current = destination;
      setStream(destination.stream);
    }
    return audioContextRef.current;
  }, []);

  const ensureStream = useCallback(() => {
    getContext();
    return destinationRef.current?.stream ?? null;
  }, [getContext]);

  const connectNode = useCallback((node: AudioNode, routing: Partial<BroadcastAudioRouting> = {}) => {
    const audioContext = getContext();
    if (node.context !== audioContext) {
      throw new Error('Broadcast audio nodes must use the broadcast audio context.');
    }

    const destination = destinationRef.current;
    if (!destination) {
      throw new Error('Broadcast audio destination is unavailable.');
    }

    const normalized = normalizeBroadcastAudioRouting(routing);
    if (normalized.stream) node.connect(destination);
    if (normalized.monitor) node.connect(audioContext.destination);

    return () => {
      if (normalized.stream) {
        try {
          node.disconnect(destination);
        } catch {
          // Already disconnected.
        }
      }
      if (normalized.monitor) {
        try {
          node.disconnect(audioContext.destination);
        } catch {
          // Already disconnected.
        }
      }
    };
  }, [getContext]);

  useEffect(() => () => {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close();
    }
    audioContextRef.current = null;
    destinationRef.current = null;
  }, []);

  return { stream, ensureStream, getContext, connectNode };
}
