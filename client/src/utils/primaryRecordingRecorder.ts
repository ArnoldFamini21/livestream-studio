import type { StreamingWebCodecsRecorder } from './streamingWebCodecsRecorder.ts';

export type PrimaryRecordingRecorder = MediaRecorder | StreamingWebCodecsRecorder;

const encoder = import.meta.env?.VITE_RECORDING_ENCODER;
const profile = encoder === 'webcodecs-h264' ? 'h264' : encoder === 'webcodecs' || encoder === 'webcodecs-owned' ? 'vp9' : null;
export const useStreamingPrimaryRecording = profile !== null;

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
