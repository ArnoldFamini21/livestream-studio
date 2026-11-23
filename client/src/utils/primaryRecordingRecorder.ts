import { VIDEO_WEBM_MEDIA_RECORDER_TYPES } from './recordingMimeTypes.ts';
import type { StreamingWebCodecsRecorder } from './streamingWebCodecsRecorder.ts';

export type PrimaryRecordingRecorder = MediaRecorder | StreamingWebCodecsRecorder;

const encoder = import.meta.env?.VITE_RECORDING_ENCODER;
const profile = encoder === 'webcodecs-h264' ? 'h264' : encoder === 'webcodecs' || encoder === 'webcodecs-owned' ? 'vp9' : null;
export const useStreamingPrimaryRecording = profile !== null;

const BROWSER_DRAIN_MS = 200;

/** Returns a pending stop only when the explicit browser-drain preflight is active. */
export function stopPrimaryRecording(
  recorder: PrimaryRecordingRecorder,
  allowBrowserDrain: boolean,
): Promise<void> | undefined {
  if (recorder.state === 'inactive') return;
  if (encoder === 'browser-drain' && allowBrowserDrain && recorder.state === 'recording'
    && typeof MediaRecorder !== 'undefined' && recorder instanceof MediaRecorder
    && typeof navigator !== 'undefined' && /(?:Chrome|Chromium)\/\d+/.test(navigator.userAgent)
    && recorder.mimeType.toLowerCase().replace(/\s+/g, '') === VIDEO_WEBM_MEDIA_RECORDER_TYPES[0]
    && recorder.stream.getVideoTracks().length === 1 && recorder.stream.getAudioTracks().length === 1) {
    try {
      // Chromium pauses encoder intake while leaving in-flight callbacks able to
      // reach the muxer. Immediate stop invalidates those callbacks.
      recorder.pause();
      return waitForBrowserDrain(recorder);
    } catch {
      // A browser that cannot pause still closes the recording normally.
    }
  }
  recorder.stop();
}

function waitForBrowserDrain(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve, reject) => {
    const alreadyStopped = () => {
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      recorder.removeEventListener('stop', alreadyStopped);
      try {
        if (recorder.state !== 'inactive') recorder.stop();
        resolve();
      } catch (error) {
        reject(error);
      }
    }, BROWSER_DRAIN_MS);
    recorder.addEventListener('stop', alreadyStopped, { once: true });
  });
}

export async function preparePrimaryRecordingRecorder(
  stream: MediaStream,
  videoBitsPerSecond: number,
  audioBitsPerSecond: number,
  isCamera = false,
): Promise<StreamingWebCodecsRecorder | null> {
  if (!profile || stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length !== 1) return null;
  try {
    const { prepareStreamingWebCodecsRecorder } = await import('./streamingWebCodecsRecorder.ts');
    const recorder = await prepareStreamingWebCodecsRecorder(stream, {
      profile, videoBitsPerSecond, audioBitsPerSecond, copyCameraFrames: isCamera && encoder === 'webcodecs-owned',
    });
    if (recorder) window.dispatchEvent(new CustomEvent('studio-recording-recorder', { detail: { recorder, stream } }));
    return recorder;
  } catch (error) {
    console.warn('The streaming recorder could not be prepared. Using the browser recorder.', error);
    return null;
  }
}
