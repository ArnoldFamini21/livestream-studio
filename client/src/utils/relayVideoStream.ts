import type { RtmpRelayVideoConfig } from '@studio/shared';
import { createFrameTicker, type FrameTicker } from './frameTicker.ts';

/**
 * The relay's video track at the output size.
 *
 * The compositor draws the program at the output orientation: 1920x1080 for
 * 16:9 and 1080x1920 for 9:16, laid out for that shape (no centre crop of a
 * landscape program). At 1080p the compositor's own track goes out as it is.
 * 720p (1280x720 or 720x1280) is scaled into a second canvas on the
 * worker-driven frame ticker, never on
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

/**
 * Where the whole program goes in the output, like CSS object-fit: contain.
 * The program is drawn at the output's shape, so this is a plain scale; a
 * mismatched shape is letterboxed, never cropped (cropping cut off lower
 * thirds, banners and side tiles).
 */
export function getContainFit(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || width <= 0 || height <= 0) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const dw = sourceWidth * scale;
  const dh = sourceHeight * scale;
  return { dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
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
    const fit = getContainFit(size.width, size.height, canvas.width, canvas.height);
    if (!fit) return;
    ctx.drawImage(source, 0, 0, size.width, size.height, fit.dx, fit.dy, fit.dw, fit.dh);
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
