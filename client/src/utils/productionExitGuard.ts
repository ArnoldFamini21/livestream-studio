export interface ProductionExitGuardState {
  isLive: boolean;
  isMixedRecording: boolean;
  isLocalRecording: boolean;
  isSessionRecording: boolean;
}

export interface ProductionExitGuardDecision {
  shouldBlock: boolean;
  reason: 'live-and-recording' | 'live' | 'recording' | null;
  message: string;
}

export function getProductionExitGuardDecision(
  state: ProductionExitGuardState,
): ProductionExitGuardDecision {
  const hasRecording = state.isMixedRecording || state.isLocalRecording || state.isSessionRecording;

  if (state.isLive && hasRecording) {
    return {
      shouldBlock: true,
      reason: 'live-and-recording',
      message: 'Live streaming and recording are active. Leaving now may stop the broadcast or lose recording chunks.',
    };
  }

  if (state.isLive) {
    return {
      shouldBlock: true,
      reason: 'live',
      message: 'A live stream is active. Leaving now may stop the broadcast.',
    };
  }

  if (hasRecording) {
    return {
      shouldBlock: true,
      reason: 'recording',
      message: 'A recording is active. Leaving now may lose recording chunks.',
    };
  }

  return {
    shouldBlock: false,
    reason: null,
    message: '',
  };
}
