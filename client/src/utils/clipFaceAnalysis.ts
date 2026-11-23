/**
 * Browser-side analysis for smart-framed clips: face boxes from MediaPipe's
 * FaceDetector on frames sampled through the clip, and who was talking from
 * per-participant audio tracks. Both libraries load lazily (dynamic import)
 * so the studio bundle does not grow; see mediapipeVisionAssets.ts for the
 * CSP-compatible asset URLs.
 */
import type { FaceBox, FaceSample, SpeakerActivity } from './clipSmartCrop.ts';
import { buildSpeakerActivity } from './clipSmartCrop.ts';
import { computeRms } from './transcriptionWindows.ts';

/** Sample about twice a second, but never more than this many frames per clip. */
export const FACE_SAMPLE_SECONDS = 0.5;
export const MAX_FACE_SAMPLES = 240;
const ANALYSIS_FRAME_WIDTH = 480;

export function planFaceSampleTimes(durationSeconds: number, stepSeconds = FACE_SAMPLE_SECONDS, maxSamples = MAX_FACE_SAMPLES): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const step = Math.max(stepSeconds, durationSeconds / maxSamples);
  const times: number[] = [];
  for (let t = 0; t < durationSeconds; t += step) times.push(Math.round(t * 1000) / 1000);
  return times;
}

interface Detector {
  detect(image: HTMLCanvasElement): { detections: Array<{ boundingBox?: { originX: number; originY: number; width: number; height: number }; categories?: Array<{ score: number }> }> };
  close(): void;
}

async function createFaceDetector(): Promise<Detector> {
  const [{ FaceDetector }, assets] = await Promise.all([
    import('@mediapipe/tasks-vision'),
    import('./mediapipeVisionAssets.ts'),
  ]);
  const fileset = { wasmLoaderPath: assets.visionWasmLoaderUrl, wasmBinaryPath: assets.visionWasmBinaryUrl };
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: assets.FACE_DETECTOR_MODEL_URL, delegate },
    runningMode: 'IMAGE' as const,
    minDetectionConfidence: 0.5,
  });
  try {
    return await FaceDetector.createFromOptions(fileset, options('GPU')) as unknown as Detector;
  } catch {
    return await FaceDetector.createFromOptions(fileset, options('CPU')) as unknown as Detector;
  }
}

function waitForAnalysisMedia(video: HTMLVideoElement, event: 'seeked' | 'loadeddata', signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener(event, onReady);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error('The clip source could not be read for face analysis'));
    const onAbort = () => finish(signal?.reason);
    const timer = setTimeout(() => finish(new Error('The clip source did not respond for face analysis')), 8000);
    video.addEventListener(event, onReady);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function toFaceBoxes(
  detections: ReturnType<Detector['detect']>['detections'],
  frameWidth: number,
  frameHeight: number
): FaceBox[] {
  return detections
    .filter((detection) => detection.boundingBox && detection.boundingBox.width > 0)
    .map((detection) => {
      const box = detection.boundingBox!;
      return {
        x: box.originX / frameWidth,
        y: box.originY / frameHeight,
        width: box.width / frameWidth,
        height: box.height / frameHeight,
        score: detection.categories?.[0]?.score,
      };
    });
}

/**
 * Face boxes about every 0.5 s across [startSeconds, endSeconds) of a video
 * blob, with sample times relative to the clip start.
 */
export async function sampleClipFaces(
  blob: Blob,
  range: { startSeconds: number; endSeconds: number },
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<FaceSample[]> {
  signal?.throwIfAborted();
  const detector = await createFaceDetector();
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  try {
    signal?.throwIfAborted();
    if (!context) throw new Error('Canvas rendering is unavailable');
    if (video.readyState < 2) await waitForAnalysisMedia(video, 'loadeddata', signal);
    const scale = Math.min(1, ANALYSIS_FRAME_WIDTH / Math.max(1, video.videoWidth));
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale));
    const times = planFaceSampleTimes(range.endSeconds - range.startSeconds);
    const samples: FaceSample[] = [];
    for (const [index, seconds] of times.entries()) {
      signal?.throwIfAborted();
      const sourceTime = range.startSeconds + seconds;
      if (video.currentTime !== sourceTime) {
        const seeked = waitForAnalysisMedia(video, 'seeked', signal);
        video.currentTime = sourceTime;
        await seeked;
      }
      signal?.throwIfAborted();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = detector.detect(canvas);
      samples.push({ seconds, faces: toFaceBoxes(result.detections || [], canvas.width, canvas.height) });
      onProgress?.((index + 1) / times.length);
    }
    return samples;
  } finally {
    detector.close();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Loudness of each participant's own audio track in `stepSeconds` steps over
 * the clip range, as the active-speaker fallback for program tracks.
 */
export async function measureSpeakerActivity(
  tracks: Blob[],
  range: { startSeconds: number; endSeconds: number },
  stepSeconds = FACE_SAMPLE_SECONDS,
  signal?: AbortSignal
): Promise<SpeakerActivity | null> {
  if (tracks.length < 2) return null;
  const { openAudioWindowReader } = await import('./audioWindowReader.ts');
  const levels: number[][] = [];
  for (const track of tracks) {
    signal?.throwIfAborted();
    const reader = await openAudioWindowReader(track).catch(() => null);
    if (!reader) return null;
    try {
      const trackLevels: number[] = [];
      for (let t = range.startSeconds; t < range.endSeconds; t += stepSeconds) {
        signal?.throwIfAborted();
        trackLevels.push(computeRms(await reader.readWindow(t, Math.min(range.endSeconds, t + stepSeconds))));
      }
      levels.push(trackLevels);
    } finally {
      reader.close();
    }
  }
  return buildSpeakerActivity(levels, stepSeconds);
}
