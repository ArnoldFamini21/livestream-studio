import type { RtmpRelayVideoConfig } from '@studio/shared';
import { createFrameTicker, type FrameTicker } from './frameTicker.ts';

/**
 * The relay's video track at the output size.
 *
 * The compositor draws a 1920x1080 program. For that size the compositor's
 * own track goes out as it is. Other sizes (720p, portrait) are drawn into a
 * second canvas on the worker-driven frame ticker, never on
 * requestAnimationFrame: rAF stops in a hidden tab and slows to about 1 fps
 * in a covered window, which froze the broadcast while the host looked at
 * slides. The compositor's canvas is copied directly when the track exposes
 * it (CanvasCaptureMediaStreamTrack.canvas), so no <video> element sits in
 * between; a <video> is only the fallback.
 */

export interface RelayVideoResources {
  stream: MediaStream;
  cleanup: () => void;
}

type DrawSource = CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number };

interface RelayCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
  captureStream(frameRate?: number): MediaStream;
}

export interface RelayVideoStreamDeps {
  createCanvas: () => RelayCanvas;
  createTicker: (fps: number, onFrame: () => void) => FrameTicker;
  /** Fallback when the track does not expose its source canvas. */
  createSourceVideo: (track: MediaStreamTrack) => Promise<HTMLVideoElement>;
  createStream: (tracks: MediaStreamTrack[]) => MediaStream;
}

/** Centre-crop `source` to fill the target, like CSS object-fit: cover. */
export function getCoverCrop(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || width <= 0 || height <= 0) return null;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }
  return { sx, sy, sw, sh };
}

function getSourceSize(source: DrawSource): { width: number; height: number } {
  const width = source.videoWidth ?? source.width ?? 0;
  const height = source.videoHeight ?? source.height ?? 0;
  return { width: Number(width) || 0, height: Number(height) || 0 };
}

function getTrackCanvas(track: MediaStreamTrack): DrawSource | null {
  const canvas = (track as MediaStreamTrack & { canvas?: unknown }).canvas;
  if (!canvas || typeof canvas !== 'object') return null;
  const candidate = canvas as { width?: unknown; height?: unknown };
  return typeof candidate.width === 'number' && typeof candidate.height === 'number'
    ? canvas as DrawSource
    : null;
}

async function createDefaultSourceVideo(track: MediaStreamTrack): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await new Promise<void>((resolve) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, 1_000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
  });
  await video.play().catch(() => undefined);
  return video;
}

const defaultDeps: RelayVideoStreamDeps = {
  createCanvas: () => document.createElement('canvas'),
  createTicker: createFrameTicker,
  createSourceVideo: createDefaultSourceVideo,
  createStream: (tracks) => new MediaStream(tracks),
};

export async function createRelayVideoStream(
  compositeStream: MediaStream,
  videoConfig: RtmpRelayVideoConfig,
  deps: RelayVideoStreamDeps = defaultDeps
): Promise<RelayVideoResources> {
  const videoTrack = compositeStream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') {
    throw new Error('The composited studio video stream is not ready.');
  }

  const trackCanvas = getTrackCanvas(videoTrack);
  const settings = typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
  const sourceSize = trackCanvas
    ? getSourceSize(trackCanvas)
    : { width: settings.width || 1920, height: settings.height || 1080 };
  if (sourceSize.width === videoConfig.width && sourceSize.height === videoConfig.height) {
    return {
      stream: deps.createStream([videoTrack]),
      cleanup: () => undefined,
    };
  }

  const sourceVideo = trackCanvas ? null : await deps.createSourceVideo(videoTrack);
  const source: DrawSource = trackCanvas || (sourceVideo as DrawSource);

  const canvas = deps.createCanvas();
  canvas.width = videoConfig.width;
  canvas.height = videoConfig.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    if (sourceVideo) {
      sourceVideo.pause();
      sourceVideo.srcObject = null;
    }
    throw new Error('Canvas output is unavailable for this stream size.');
  }

  const draw = () => {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (sourceVideo && sourceVideo.readyState < 2) return;
    const size = getSourceSize(source);
    const crop = getCoverCrop(size.width, size.height, canvas.width, canvas.height);
    if (!crop) return;
    ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  };
  draw();
  const ticker = deps.createTicker(videoConfig.frameRate, draw);

  const stream = canvas.captureStream(videoConfig.frameRate);
  return {
    stream,
    cleanup: () => {
      ticker.stop();
      stream.getTracks().forEach((track) => track.stop());
      if (sourceVideo) {
        sourceVideo.pause();
        sourceVideo.srcObject = null;
      }
    },
  };
}
