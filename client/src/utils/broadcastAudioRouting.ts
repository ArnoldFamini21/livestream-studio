export interface BroadcastAudioRouting {
  /** Send to the program (live stream, program recording and guests). */
  stream: boolean;
  /** Play on this computer's speakers. */
  monitor: boolean;
  /** Music and clip audio that auto ducking lowers under speech. */
  duck: boolean;
}

export const DEFAULT_BROADCAST_AUDIO_ROUTING: BroadcastAudioRouting = {
  stream: true,
  monitor: true,
  duck: false,
};

export function normalizeBroadcastAudioRouting(
  routing: Partial<BroadcastAudioRouting> = {}
): BroadcastAudioRouting {
  return {
    stream: routing.stream ?? DEFAULT_BROADCAST_AUDIO_ROUTING.stream,
    monitor: routing.monitor ?? DEFAULT_BROADCAST_AUDIO_ROUTING.monitor,
    duck: routing.duck ?? DEFAULT_BROADCAST_AUDIO_ROUTING.duck,
  };
}
