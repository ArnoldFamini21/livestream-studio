import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';

type MediaAudioBus = Pick<BroadcastAudioBus, 'getContext' | 'connectNode'>;

// A browser allows only one MediaElementAudioSourceNode per media element,
// including after a route has been disconnected and attached again.
const mediaSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

export function connectMediaElementAudio(
  element: HTMLMediaElement,
  bus: MediaAudioBus,
  { duck = true, startConnected = true } = {},
): {
  resume: () => Promise<void>;
  connect: () => void;
  disconnect: () => void;
} {
  const context = bus.getContext();
  let source = mediaSources.get(element);
  if (source && source.context !== context) {
    throw new Error('Video audio needs to be reloaded after the audio session changes.');
  }
  if (!source) {
    source = context.createMediaElementSource(element);
    mediaSources.set(element, source);
  }

  // Creating the source replaces the element's direct speaker output. Route
  // that single source to both monitoring and the broadcast/recording mix.
  const mediaSource = source;
  let disconnectRoute: (() => void) | null = null;
  const connect = () => {
    disconnectRoute ??= bus.connectNode(mediaSource, { stream: true, monitor: true, duck });
  };
  if (startConnected) connect();
  return {
    resume: async () => {
      if (context.state === 'suspended') await context.resume();
    },
    connect,
    disconnect: () => {
      const disconnect = disconnectRoute;
      disconnectRoute = null;
      disconnect?.();
    },
  };
}
