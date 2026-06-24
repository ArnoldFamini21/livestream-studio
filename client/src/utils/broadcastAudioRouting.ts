export interface BroadcastAudioRouting {
  stream: boolean;
  monitor: boolean;
}

export const DEFAULT_BROADCAST_AUDIO_ROUTING: BroadcastAudioRouting = {
  stream: true,
  monitor: true,
};

export function normalizeBroadcastAudioRouting(
  routing: Partial<BroadcastAudioRouting> = {}
): BroadcastAudioRouting {
  return {
    stream: routing.stream ?? DEFAULT_BROADCAST_AUDIO_ROUTING.stream,
    monitor: routing.monitor ?? DEFAULT_BROADCAST_AUDIO_ROUTING.monitor,
  };
}
