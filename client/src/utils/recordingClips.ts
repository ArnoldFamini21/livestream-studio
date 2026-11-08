export interface ClipRange {
  startSeconds: number;
  endSeconds: number;
}

export type ClipAspectPreset = 'source' | 'vertical' | 'square';

import { buildCropPath, sampleCropPath, type CropPath, type FaceSample, type SpeakerActivity } from './clipSmartCrop.ts';
import { buildClipCaptionCues, drawClipCaption, type ClipCaptionCue, type ClipCaptionStyle } from './clipCaptions.ts';
import { loadCanvasFonts } from './canvasFonts.ts';
import type { TranscriptWord } from './transcriptCleanup.ts';

export interface ClipCaptureSource {
  blob: Blob;
  hasVideo: boolean;
  aspect?: ClipAspectPreset;
}

export interface ClipRenderOptions {
  /**
   * Follow faces (MediaPipe FaceDetector, sampled every ~0.5 s and smoothed)
   * instead of centre-cropping a vertical or square clip. `speakerTracks` are
   * the participants' own audio tracks, in the program's left-to-right order,
   * used to pick who to follow when several faces do not fit the crop.
   */
  smartCrop?: { speakerTracks?: Blob[] } | null;
  /** Burn in word-synced captions from the transcript's word timings (recording timeline). */
  captions?: { words: TranscriptWord[]; style: ClipCaptionStyle } | null;
  signal?: AbortSignal;
}

export interface CapturedRecordingClip {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  extension: string;
  /** Things that fell back, e.g. smart framing unavailable so the crop stayed centred. */
  warnings?: string[];
}

/** Share of the progress bar the smart-framing analysis takes before real-time capture. */
export const SMART_CROP_ANALYSIS_SHARE = 0.35;

export type ClipTrackKind = 'audio' | 'video' | 'screen' | 'program' | 'iso';

export const MIN_CLIP_DURATION_SECONDS = 1;
export const MAX_CLIP_DURATION_SECONDS = 600;

const CLIP_CAPTURE_FRAME_RATE = 30;
const CLIP_CAPTURE_TIMESLICE_MS = 500;
const CLIP_END_TOLERANCE_SECONDS = 0.05;
const CLIP_PROGRESS_POLL_MS = 100;

const VIDEO_CLIP_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];

const AUDIO_CLIP_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
];

export function roundClipSeconds(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundToEvenPixels(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function getClipCanvasSize(
  videoWidth: number,
  videoHeight: number,
  aspect: ClipAspectPreset = 'source'
): { width: number; height: number } {
  const safeWidth = videoWidth > 0 ? videoWidth : 1280;
  const safeHeight = videoHeight > 0 ? videoHeight : 720;
  if (aspect === 'vertical') {
    return { width: roundToEvenPixels((safeHeight * 9) / 16), height: roundToEvenPixels(safeHeight) };
  }
  if (aspect === 'square') {
    const side = roundToEvenPixels(Math.min(safeWidth, safeHeight));
    return { width: side, height: side };
  }
  return { width: roundToEvenPixels(safeWidth), height: roundToEvenPixels(safeHeight) };
}

/**
 * Source rectangle that fills the canvas. With `center` (fractions of the
 * source frame, from smart framing) the crop follows it, clamped to the frame;
 * otherwise it is centred.
 */
export function getClipDrawRect(
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  center?: { x: number; y: number } | null
): { sx: number; sy: number; sw: number; sh: number } {
  if (videoWidth <= 0 || videoHeight <= 0 || canvasWidth <= 0 || canvasHeight <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(1, videoWidth), sh: Math.max(1, videoHeight) };
  }
  const scale = Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const sw = canvasWidth / scale;
  const sh = canvasHeight / scale;
  const cx = center && Number.isFinite(center.x) ? center.x * videoWidth : videoWidth / 2;
  const cy = center && Number.isFinite(center.y) ? center.y * videoHeight : videoHeight / 2;
  return {
    sx: Math.min(Math.max(0, cx - sw / 2), Math.max(0, videoWidth - sw)),
    sy: Math.min(Math.max(0, cy - sh / 2), Math.max(0, videoHeight - sh)),
    sw,
    sh,
  };
}

export function getClipDurationSeconds(range: ClipRange): number {
  return Math.max(0, range.endSeconds - range.startSeconds);
}

export function clampClipRangeToDuration(range: ClipRange, durationSeconds: number | null | undefined): ClipRange {
  if (!Number.isFinite(durationSeconds) || (durationSeconds as number) <= 0) return { ...range };
  const duration = durationSeconds as number;
  const startSeconds = Math.min(Math.max(0, range.startSeconds), duration);
  const endSeconds = Math.min(Math.max(startSeconds, range.endSeconds), duration);
  return { startSeconds, endSeconds };
}

export function getClipRangeIssue(
  range: Partial<ClipRange>,
  trackDurationSeconds?: number | null
): string | null {
  const start = range.startSeconds;
  const end = range.endSeconds;
  if (!Number.isFinite(start) || (start as number) < 0) return 'Set a clip start point first';
  if (!Number.isFinite(end) || (end as number) <= 0) return 'Set a clip end point first';
  if ((end as number) <= (start as number)) return 'The clip end must be after the clip start';
  const duration = (end as number) - (start as number);
  if (duration < MIN_CLIP_DURATION_SECONDS) {
    return `Clips must be at least ${MIN_CLIP_DURATION_SECONDS} second${MIN_CLIP_DURATION_SECONDS === 1 ? '' : 's'} long`;
  }
  if (duration > MAX_CLIP_DURATION_SECONDS) {
    return `Clips are limited to ${Math.round(MAX_CLIP_DURATION_SECONDS / 60)} minutes`;
  }
  if (
    Number.isFinite(trackDurationSeconds) &&
    (trackDurationSeconds as number) > 0 &&
    (start as number) >= (trackDurationSeconds as number)
  ) {
    return 'The clip start is beyond the end of this track';
  }
  return null;
}

export function formatClipTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  const tenths = Math.round((seconds - whole) * 10) % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
  return tenths > 0 ? `${base}.${tenths}` : base;
}

export function pickClipRecorderMimeType(
  hasVideo: boolean,
  isTypeSupported: (type: string) => boolean
): string | null {
  const candidates = hasVideo ? VIDEO_CLIP_MIME_CANDIDATES : AUDIO_CLIP_MIME_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // Treat probe failures as unsupported and keep checking fallbacks.
    }
  }
  return null;
}

export function getClipFileExtension(mimeType: string, hasVideo: boolean): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (base === 'video/mp4') return 'mp4';
  if (base === 'audio/mp4') return 'm4a';
  if (base === 'audio/webm' || base === 'video/webm') return 'webm';
  return hasVideo ? 'webm' : 'webm';
}

function sanitizeClipNamePart(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'clip';
}

function formatClipFileTimecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function buildClipFileName(
  sourceName: string,
  trackLabel: string,
  range: ClipRange,
  extension: string,
  aspect: ClipAspectPreset = 'source'
): string {
  const namePart = sanitizeClipNamePart(sourceName).slice(0, 60);
  const labelPart = sanitizeClipNamePart(trackLabel).slice(0, 40);
  const rangePart = `${formatClipFileTimecode(range.startSeconds)}-${formatClipFileTimecode(range.endSeconds)}`;
  const aspectPart = aspect === 'vertical' ? '_9x16' : aspect === 'square' ? '_1x1' : '';
  return `${namePart}_clip_${labelPart}_${rangePart}${aspectPart}.${extension}`;
}

export function buildClipLabel(trackLabel: string, range: ClipRange): string {
  return `${trackLabel} clip ${formatClipTimecode(range.startSeconds)}-${formatClipTimecode(range.endSeconds)}`;
}

export function getClipCaptureProgress(currentSeconds: number, range: ClipRange): number {
  const duration = getClipDurationSeconds(range);
  if (!Number.isFinite(currentSeconds) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, (currentSeconds - range.startSeconds) / duration));
}

export function getClipTrackKind(sourceKind: ClipTrackKind | undefined, hasVideo: boolean): ClipTrackKind {
  if (sourceKind === 'audio' || sourceKind === 'screen') return sourceKind;
  if (sourceKind === 'video' || sourceKind === 'program' || sourceKind === 'iso') {
    return hasVideo ? sourceKind : 'audio';
  }
  return hasVideo ? 'video' : 'audio';
}

function waitForMediaEvent(
  element: HTMLMediaElement,
  eventName: string,
  timeoutMs: number,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener(eventName, onEvent);
      element.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(new Error(`${label} failed`));
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    element.addEventListener(eventName, onEvent);
    element.addEventListener('error', onError);
  });
}

async function resolveClipSourceDuration(element: HTMLMediaElement): Promise<number | null> {
  if (Number.isFinite(element.duration) && element.duration > 0) return element.duration;
  // MediaRecorder WebM blobs often report Infinity until the element seeks past the end.
  try {
    const seeked = waitForMediaEvent(element, 'seeked', 10_000, 'Reading the clip source duration');
    element.currentTime = 60 * 60 * 24;
    await seeked;
  } catch {
    return null;
  }
  if (Number.isFinite(element.duration) && element.duration > 0) return element.duration;
  if (Number.isFinite(element.currentTime) && element.currentTime > 0) return element.currentTime;
  return null;
}

/**
 * Plans the smart-framing crop path for a clip: face samples (and per-track
 * loudness for multi-person program tracks) turned into a smoothed path of
 * crop centres. Falls back to speaker activity alone when face detection is
 * unavailable, and to null (centre crop) when neither is.
 */
export async function planSmartCrop(
  source: ClipCaptureSource,
  range: ClipRange,
  videoSize: { width: number; height: number },
  options: NonNullable<ClipRenderOptions['smartCrop']>,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<{ path: CropPath | null; warning?: string }> {
  const aspect = source.aspect || 'source';
  const canvasSize = getClipCanvasSize(videoSize.width, videoSize.height, aspect);
  const rect = getClipDrawRect(videoSize.width, videoSize.height, canvasSize.width, canvasSize.height);
  const cropWidth = rect.sw / Math.max(1, videoSize.width);
  const cropHeight = rect.sh / Math.max(1, videoSize.height);
  if (cropWidth >= 0.999 && cropHeight >= 0.999) return { path: null };
  const analysis = await import('./clipFaceAnalysis.ts');
  let faces: FaceSample[] | null = null;
  let warning: string | undefined;
  try {
    faces = await analysis.sampleClipFaces(source.blob, range, (fraction) => onProgress?.(fraction * 0.85), signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    warning = `Face tracking was unavailable (${err instanceof Error ? err.message : 'unknown error'}).`;
  }
  let activity: SpeakerActivity | null = null;
  if (options.speakerTracks && options.speakerTracks.length > 1) {
    activity = await analysis.measureSpeakerActivity(options.speakerTracks, range).catch(() => null);
  }
  onProgress?.(1);
  const durationSeconds = getClipDurationSeconds(range);
  if (!faces) {
    if (!activity) return { path: null, warning: `${warning} The clip is centre-cropped.` };
    faces = activity.samples.map((sample) => ({ seconds: sample.seconds, faces: [] }));
    warning = `${warning} Framing follows the active speaker instead.`;
  }
  return { path: buildCropPath(faces, { cropWidth, cropHeight, durationSeconds, activity }), ...(warning ? { warning } : {}) };
}

export async function captureRecordingClip(
  source: ClipCaptureSource,
  range: ClipRange,
  onProgress?: (fraction: number) => void,
  renderOptions: ClipRenderOptions = {}
): Promise<CapturedRecordingClip> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Clip export is not supported in this browser');
  }
  const mimeType = pickClipRecorderMimeType(source.hasVideo, (type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    throw new Error('This browser cannot encode clips from the preview player');
  }

  const objectUrl = URL.createObjectURL(source.blob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = objectUrl;

  const cleanupTasks: Array<() => void> = [() => URL.revokeObjectURL(objectUrl)];
  const runCleanup = () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      try {
        task?.();
      } catch {
        // Cleanup failures must not mask the capture result.
      }
    }
  };

  try {
    await waitForMediaEvent(video, 'loadedmetadata', 15_000, 'Loading the clip source');
    const sourceDuration = await resolveClipSourceDuration(video);
    const clipRange = clampClipRangeToDuration(range, sourceDuration);
    const issue = getClipRangeIssue(clipRange, sourceDuration);
    if (issue) throw new Error(issue);

    const outputTracks: MediaStreamTrack[] = [];
    let stopDrawing: (() => void) | null = null;
    const warnings: string[] = [];

    // Smart framing analyses the clip before the real-time capture starts.
    let cropPath: CropPath | null = null;
    const aspectForCrop = source.aspect || 'source';
    const useSmartCrop = source.hasVideo && aspectForCrop !== 'source' && Boolean(renderOptions.smartCrop);
    const captureShare = useSmartCrop ? 1 - SMART_CROP_ANALYSIS_SHARE : 1;
    const reportCapture = (fraction: number) => onProgress?.((1 - captureShare) + fraction * captureShare);
    if (useSmartCrop && renderOptions.smartCrop) {
      try {
        const planned = await planSmartCrop(
          source,
          clipRange,
          { width: video.videoWidth, height: video.videoHeight },
          renderOptions.smartCrop,
          (fraction) => onProgress?.(fraction * SMART_CROP_ANALYSIS_SHARE),
          renderOptions.signal
        );
        cropPath = planned.path;
        if (planned.warning) warnings.push(planned.warning);
      } catch (err) {
        if (renderOptions.signal?.aborted) throw err;
        warnings.push(`Smart framing failed (${err instanceof Error ? err.message : 'unknown error'}); the clip is centre-cropped.`);
      }
    }

    let captionCues: ClipCaptionCue[] = [];
    const captionStyle = renderOptions.captions?.style;
    if (source.hasVideo && renderOptions.captions?.words.length) {
      captionCues = buildClipCaptionCues(renderOptions.captions.words, clipRange);
      if (captionCues.length === 0) warnings.push('The transcript has no words in this clip range, so no captions were burned in.');
      else if (captionStyle) await loadCanvasFonts([`800 48px ${captionStyle.fontFamily}`]);
    }

    if (source.hasVideo) {
      const aspect = source.aspect || 'source';
      const canvas = document.createElement('canvas');
      const initialSize = getClipCanvasSize(video.videoWidth, video.videoHeight, aspect);
      canvas.width = initialSize.width;
      canvas.height = initialSize.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable for clip export');
      const canvasStream = canvas.captureStream(CLIP_CAPTURE_FRAME_RATE);
      outputTracks.push(...canvasStream.getVideoTracks());
      cleanupTasks.push(() => canvasStream.getTracks().forEach((track) => track.stop()));

      let drawingStopped = false;
      let animationFrame = 0;
      const frameSource = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      };
      const drawFrame = () => {
        if (drawingStopped) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          const size = getClipCanvasSize(video.videoWidth, video.videoHeight, aspect);
          if (canvas.width !== size.width || canvas.height !== size.height) {
            canvas.width = size.width;
            canvas.height = size.height;
          }
        }
        const clipSeconds = Math.max(0, video.currentTime - clipRange.startSeconds);
        const rect = getClipDrawRect(
          video.videoWidth || canvas.width,
          video.videoHeight || canvas.height,
          canvas.width,
          canvas.height,
          cropPath ? sampleCropPath(cropPath, clipSeconds) : null
        );
        context.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
        if (captionCues.length > 0 && captionStyle) {
          drawClipCaption(context, captionCues, clipSeconds, captionStyle, canvas.width, canvas.height);
        }
        scheduleFrame();
      };
      const scheduleFrame = () => {
        if (drawingStopped) return;
        if (typeof frameSource.requestVideoFrameCallback === 'function') {
          frameSource.requestVideoFrameCallback(drawFrame);
        } else {
          animationFrame = requestAnimationFrame(drawFrame);
        }
      };
      scheduleFrame();
      stopDrawing = () => {
        drawingStopped = true;
        cancelAnimationFrame(animationFrame);
      };
      cleanupTasks.push(stopDrawing);
    }

    let hasRoutedAudio = false;
    try {
      const AudioContextCtor = window.AudioContext
        || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor();
        const elementSource = audioContext.createMediaElementSource(video);
        const destination = audioContext.createMediaStreamDestination();
        elementSource.connect(destination);
        const audioTracks = destination.stream.getAudioTracks();
        if (audioTracks.length > 0) {
          outputTracks.push(...audioTracks);
          hasRoutedAudio = true;
        }
        await audioContext.resume();
        cleanupTasks.push(() => {
          void audioContext.close().catch(() => undefined);
        });
      }
    } catch {
      hasRoutedAudio = false;
    }

    if (!hasRoutedAudio) {
      const captureCapable = video as HTMLVideoElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const capture = captureCapable.captureStream || captureCapable.mozCaptureStream;
      if (typeof capture === 'function') {
        try {
          const elementStream = capture.call(video);
          outputTracks.push(...elementStream.getAudioTracks());
        } catch {
          // Video-only capture still produces a usable clip.
        }
      }
    }

    if (outputTracks.length === 0) {
      throw new Error('No capturable media tracks were found for this clip');
    }

    const seeked = waitForMediaEvent(video, 'seeked', 10_000, 'Seeking to the clip start');
    video.currentTime = clipRange.startSeconds;
    await seeked;

    const recorder = new MediaRecorder(new MediaStream(outputTracks), { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    const clipDurationSeconds = getClipDurationSeconds(clipRange);
    const clipBlob = await new Promise<Blob>((resolve, reject) => {
      let settled = false;
      let stopRequested = false;
      const hardTimeout = setTimeout(() => {
        fail(new Error('Clip export timed out'));
      }, Math.ceil(clipDurationSeconds * 1500) + 20_000);
      const progressPoll = setInterval(() => {
        reportCapture(getClipCaptureProgress(video.currentTime, clipRange));
        if (video.currentTime >= clipRange.endSeconds - CLIP_END_TOLERANCE_SECONDS || video.ended) {
          stopCapture();
        }
      }, CLIP_PROGRESS_POLL_MS);
      const settle = () => {
        clearTimeout(hardTimeout);
        clearInterval(progressPoll);
        video.removeEventListener('ended', stopCapture);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        settle();
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          // The recorder may already be stopped when capture fails.
        }
        video.pause();
        reject(error);
      };
      const stopCapture = () => {
        if (stopRequested) return;
        stopRequested = true;
        video.pause();
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          else fail(new Error('Clip recording stopped before any media was captured'));
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Clip recording failed'));
        }
      };
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        settle();
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size === 0) reject(new Error('The exported clip was empty'));
        else resolve(blob);
      };
      recorder.onerror = () => fail(new Error('Clip recording failed'));
      video.addEventListener('ended', stopCapture);
      try {
        recorder.start(CLIP_CAPTURE_TIMESLICE_MS);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Clip recording could not start'));
        return;
      }
      video.play().catch(() => {
        // Retry muted so video-only clips can still export under autoplay blocks.
        video.muted = true;
        video.play().catch(() => {
          fail(new Error('Playback for clip export was blocked by the browser'));
        });
      });
    });

    onProgress?.(1);
    return {
      blob: clipBlob,
      mimeType,
      durationSeconds: clipDurationSeconds,
      extension: getClipFileExtension(mimeType, source.hasVideo),
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // Releasing the element source is best-effort.
    }
    runCleanup();
  }
}
