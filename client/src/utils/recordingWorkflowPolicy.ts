/**
 * Small, pure decisions for the direct-to-folder recording workflow, kept out
 * of the studio component so they can be tested.
 */

export interface GuestTransferStatusLike {
  state: 'idle' | 'connecting' | 'sending' | 'delivered' | 'waiting';
  pendingTracks: number;
  percent: number;
}

/** One line for a guest about where their recording is. */
export function describeGuestTransfer(status: GuestTransferStatusLike, invited: boolean): string | null {
  if (!invited || status.pendingTracks === 0) return null;
  switch (status.state) {
    case 'sending':
      return `Sending your tracks to the host — ${Math.max(0, Math.min(100, status.percent))}%`;
    case 'connecting':
      return 'Connecting to the host to send your tracks…';
    case 'waiting':
      return 'Your tracks are safe in this browser and will be sent to the host when the connection returns.';
    default:
      return null;
  }
}

export interface ParticipantRecordingPlan {
  /** Upload to the media-server in the background while recording. */
  progressiveUpload: boolean;
  /** Upload the whole take after it stops when the progressive upload is missing or failed. */
  uploadAfterStop: boolean;
  /** Stream tracks to the host's folder over the transfer connection. */
  sendToHost: boolean;
}

/**
 * Where a participant's own tracks go.
 *
 * - Host with a folder: tracks are written there; no upload unless the
 *   owner opted into the cloud copy.
 * - Host without a folder: tracks stay in this browser and the library;
 *   uploading them would only feed the free-tier export, so the background
 *   upload pauses while live (the full upload after stop remains).
 * - Guest whose host collects tracks: send them peer-to-peer; the
 *   media-server copy is opt-in.
 * - Guest otherwise: the existing media-server upload.
 */
export function planParticipantRecording(input: {
  isOperator: boolean;
  hostFolderTake: boolean;
  invitedByHost: boolean;
  cloudUpload: boolean;
}): ParticipantRecordingPlan {
  if (input.isOperator) {
    if (input.hostFolderTake) return { progressiveUpload: input.cloudUpload, uploadAfterStop: input.cloudUpload, sendToHost: false };
    return { progressiveUpload: true, uploadAfterStop: true, sendToHost: false };
  }
  if (input.invitedByHost) return { progressiveUpload: input.cloudUpload, uploadAfterStop: input.cloudUpload, sendToHost: true };
  return { progressiveUpload: true, uploadAfterStop: true, sendToHost: false };
}

/** The program/ISO upload competes with the broadcast: hold it while live. */
export function shouldPauseOwnUploadWhileLive(input: { isOperator: boolean; isLive: boolean }): boolean {
  return input.isOperator && input.isLive;
}

