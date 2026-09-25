/**
 * What the watch page does when hls.js reports a fatal error. Unbounded
 * recovery turns one browser that cannot decode the stream into a tight
 * reload loop against the media server (the same process that encodes the
 * broadcast), so every path here is bounded or backed off.
 */

export type HlsRecoveryAction =
  | { action: 'reload'; delayMs: number }
  | { action: 'recover-media' }
  | { action: 'swap-audio-and-recover' }
  | { action: 'fail'; message: string };

export interface HlsFatalError {
  type: string;
  details: string;
}

/** The browser cannot decode the stream's codecs; retrying cannot help. */
const CODEC_ERRORS = new Set([
  'bufferAddCodecError',
  'bufferIncompatibleCodecsError',
  'manifestIncompatibleCodecsError',
]);

export const UNSUPPORTED_FORMAT_MESSAGE =
  "This browser can't play this broadcast's video format. Try Chrome, Edge, or Safari.";
export const PLAYBACK_FAILED_MESSAGE = 'Playback stopped. Please retry.';

const NETWORK_RETRY_BASE_MS = 1_000;
const NETWORK_RETRY_MAX_MS = 10_000;
/** Media errors this close together mean the first recovery did not work. */
const MEDIA_RECOVERY_WINDOW_MS = 3_000;

export class HlsRecoveryPolicy {
  private networkFailures = 0;
  private lastMediaRecoveryAt = -Infinity;
  private swappedAudio = false;

  /** Playback is progressing again: forget earlier failures. */
  recovered(): void {
    this.networkFailures = 0;
  }

  next(error: HlsFatalError, now = Date.now()): HlsRecoveryAction {
    if (CODEC_ERRORS.has(error.details)) {
      return { action: 'fail', message: UNSUPPORTED_FORMAT_MESSAGE };
    }

    if (error.type === 'networkError') {
      // While the broadcast is live the playlist will come back (a restart,
      // a slow first segment), so keep trying, but never faster than this.
      const delayMs = Math.min(NETWORK_RETRY_BASE_MS * 2 ** this.networkFailures, NETWORK_RETRY_MAX_MS);
      this.networkFailures += 1;
      return { action: 'reload', delayMs };
    }

    if (error.type === 'mediaError') {
      const sinceLast = now - this.lastMediaRecoveryAt;
      this.lastMediaRecoveryAt = now;
      if (sinceLast > MEDIA_RECOVERY_WINDOW_MS) return { action: 'recover-media' };
      if (!this.swappedAudio) {
        this.swappedAudio = true;
        return { action: 'swap-audio-and-recover' };
      }
    }

    return { action: 'fail', message: PLAYBACK_FAILED_MESSAGE };
  }
}
