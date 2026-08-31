import {
  getClipCanvasSize,
  getClipDrawRect,
  getClipFileExtension,
  pickClipRecorderMimeType,
  type CapturedRecordingClip,
  type ClipAspectPreset,
} from './recordingClips.ts';
import type { TranscriptEdlSegment } from './transcriptEditor.ts';

/**
 * Renders a transcript edit in the browser by playing only the kept ranges
 * into a MediaRecorder, pausing it across each cut. This mirrors the browser
 * clip exporter so an edit can be produced without a media server.
 */

export interface RecordingEditSource {
  blob: Blob;
  hasVideo: boolean;
  aspect?: ClipAspectPreset;
}

export interface RecordingEditProgress {
  /** Overall completion of the edit, 0-1. */
  fraction: number;
  segmentIndex: number;
  segmentCount: number;
}

const EDIT_CAPTURE_FRAME_RATE = 30;
const EDIT_CAPTURE_TIMESLICE_MS = 500;
const EDIT_SEGMENT_END_TOLERANCE_SECONDS = 0.05;
const EDIT_PROGRESS_POLL_MS = 100;
const EDIT_SEEK_TIMEOUT_MS = 15_000;

export const MAX_BROWSER_EDIT_SEGMENTS = 200;
export const MAX_BROWSER_EDIT_DURATION_SECONDS = 3_600;

export function getRecordingEditDurationSeconds(segments: readonly TranscriptEdlSegment[]): number {
  return Math.round(
    segments.reduce((total, segment) => total + Math.max(0, segment.endSeconds - segment.startSeconds), 0) * 1000
  ) / 1000;
}

export function getRecordingEditIssue(segments: readonly TranscriptEdlSegment[]): string | null {
  if (!Array.isArray(segments) || segments.length === 0) {
    return 'This edit removed everything — keep at least one range before exporting';
  }
  if (segments.length > MAX_BROWSER_EDIT_SEGMENTS) {
    return `Browser edit exports handle up to ${MAX_BROWSER_EDIT_SEGMENTS} kept ranges. Export on the media server instead.`;
  }

  let previousEnd = -1;
  for (const segment of segments) {
    if (!Number.isFinite(segment.startSeconds) || segment.startSeconds < 0) return 'This edit has an invalid range start';
    if (!Number.isFinite(segment.endSeconds) || segment.endSeconds <= segment.startSeconds) {
      return 'This edit has a range that ends before it starts';
    }
    if (segment.startSeconds < previousEnd) return 'This edit has overlapping ranges';
    previousEnd = segment.endSeconds;
  }

  const duration = getRecordingEditDurationSeconds(segments);
  if (duration < 1) return 'This edit keeps less than a second of the recording';
  if (duration > MAX_BROWSER_EDIT_DURATION_SECONDS) {
    return `Browser edit exports are limited to ${Math.round(MAX_BROWSER_EDIT_DURATION_SECONDS / 60)} minutes. Export on the media server instead.`;
  }
  return null;
}

export function getRecordingEditProgress(
  segments: readonly TranscriptEdlSegment[],
  segmentIndex: number,
  currentSeconds: number
): number {
  const total = getRecordingEditDurationSeconds(segments);
  if (total <= 0) return 0;
  let elapsed = 0;
  for (let index = 0; index < segmentIndex && index < segments.length; index += 1) {
    elapsed += segments[index].endSeconds - segments[index].startSeconds;
  }
  const active = segments[segmentIndex];
  if (active && Number.isFinite(currentSeconds)) {
    elapsed += Math.min(
      Math.max(0, currentSeconds - active.startSeconds),
      active.endSeconds - active.startSeconds
    );
  }
  return Math.min(1, Math.max(0, elapsed / total));
}

export function buildRecordingEditFileName(
  sourceName: string,
  trackLabel: string,
  segments: readonly TranscriptEdlSegment[],
  extension: string
): string {
  const clean = (value: string) => value
    .trim()
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .replace(/^_+|_+$/g, '') || 'edit';
  const whole = Math.max(0, Math.floor(getRecordingEditDurationSeconds(segments)));
  const durationPart = `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
  return `${clean(sourceName).slice(0, 60)}_edit_${clean(trackLabel).slice(0, 40)}_${segments.length}x_${durationPart}.${extension}`;
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

async function seekTo(element: HTMLMediaElement, seconds: number): Promise<void> {
  if (Math.abs(element.currentTime - seconds) < 0.001) return;
  const seeked = waitForMediaEvent(element, 'seeked', EDIT_SEEK_TIMEOUT_MS, 'Seeking to the next kept range');
  element.currentTime = seconds;
  await seeked;
}

export async function captureRecordingEdit(
  source: RecordingEditSource,
  segments: readonly TranscriptEdlSegment[],
  onProgress?: (progress: RecordingEditProgress) => void
): Promise<CapturedRecordingClip> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Edit export is not supported in this browser');
  }
  const issue = getRecordingEditIssue(segments);
  if (issue) throw new Error(issue);
  const mimeType = pickClipRecorderMimeType(source.hasVideo, (type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    throw new Error('This browser cannot encode edits from the preview player');
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
    await waitForMediaEvent(video, 'loadedmetadata', 15_000, 'Loading the edit source');

    const outputTracks: MediaStreamTrack[] = [];
    if (source.hasVideo) {
      const aspect = source.aspect || 'source';
      const canvas = document.createElement('canvas');
      const initialSize = getClipCanvasSize(video.videoWidth, video.videoHeight, aspect);
      canvas.width = initialSize.width;
      canvas.height = initialSize.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable for edit export');
      const canvasStream = canvas.captureStream(EDIT_CAPTURE_FRAME_RATE);
      outputTracks.push(...canvasStream.getVideoTracks());
      cleanupTasks.push(() => canvasStream.getTracks().forEach((track) => track.stop()));

      let drawingStopped = false;
      let animationFrame = 0;
      const frameSource = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      };
      const scheduleFrame = () => {
        if (drawingStopped) return;
        if (typeof frameSource.requestVideoFrameCallback === 'function') {
          frameSource.requestVideoFrameCallback(drawFrame);
        } else {
          animationFrame = requestAnimationFrame(drawFrame);
        }
      };
      function drawFrame() {
        if (drawingStopped) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          const size = getClipCanvasSize(video.videoWidth, video.videoHeight, aspect);
          if (canvas.width !== size.width || canvas.height !== size.height) {
            canvas.width = size.width;
            canvas.height = size.height;
          }
        }
        const rect = getClipDrawRect(
          video.videoWidth || canvas.width,
          video.videoHeight || canvas.height,
          canvas.width,
          canvas.height
        );
        context!.drawImage(video, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
        scheduleFrame();
      }
      scheduleFrame();
      cleanupTasks.push(() => {
        drawingStopped = true;
        cancelAnimationFrame(animationFrame);
      });
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
          outputTracks.push(...capture.call(video).getAudioTracks());
        } catch {
          // Video-only capture still produces a usable edit.
        }
      }
    }

    if (outputTracks.length === 0) {
      throw new Error('No capturable media tracks were found for this edit');
    }

    const recorder = new MediaRecorder(new MediaStream(outputTracks), { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    let recorderError: Error | null = null;
    recorder.onerror = () => {
      recorderError = new Error('Edit recording failed');
    };

    await seekTo(video, segments[0].startSeconds);
    recorder.start(EDIT_CAPTURE_TIMESLICE_MS);
    cleanupTasks.push(() => {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // The recorder may already be stopped.
      }
    });

    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (index > 0) {
        // Pausing across the cut is what removes the material between ranges.
        recorder.pause();
        await seekTo(video, segment.startSeconds);
        recorder.resume();
      }
      await playSegment(video, segment, () => {
        onProgress?.({
          fraction: getRecordingEditProgress(segments, index, video.currentTime),
          segmentIndex: index,
          segmentCount: segments.length,
        });
      });
      if (recorderError) throw recorderError;
    }

    video.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    if (recorderError) throw recorderError;

    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) throw new Error('The exported edit was empty');

    onProgress?.({ fraction: 1, segmentIndex: segments.length - 1, segmentCount: segments.length });
    return {
      blob,
      mimeType,
      durationSeconds: getRecordingEditDurationSeconds(segments),
      extension: getClipFileExtension(mimeType, source.hasVideo),
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

function playSegment(
  video: HTMLVideoElement,
  segment: TranscriptEdlSegment,
  onTick: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const durationSeconds = segment.endSeconds - segment.startSeconds;
    const hardTimeout = setTimeout(() => {
      finish(new Error('Edit export timed out'));
    }, Math.ceil(durationSeconds * 1500) + 20_000);
    const poll = setInterval(() => {
      onTick();
      if (video.currentTime >= segment.endSeconds - EDIT_SEGMENT_END_TOLERANCE_SECONDS || video.ended) {
        finish();
      }
    }, EDIT_PROGRESS_POLL_MS);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      clearInterval(poll);
      video.removeEventListener('ended', onEnded);
      video.pause();
      if (error) reject(error);
      else resolve();
    }
    const onEnded = () => finish();
    video.addEventListener('ended', onEnded);

    video.play().catch(() => {
      // Retry muted so video-only edits can still export under autoplay blocks.
      video.muted = true;
      video.play().catch(() => {
        finish(new Error('Playback for edit export was blocked by the browser'));
      });
    });
  });
}
