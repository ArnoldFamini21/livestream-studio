export interface VideoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoSize {
  width: number;
  height: number;
}

export interface ScreenPictureInPictureStream {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  cleanup: () => void;
}

export interface CreateScreenPictureInPictureStreamOptions {
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  frameRate?: number;
}

type CanvasWithCaptureStream = HTMLCanvasElement & {
  captureStream?: (frameRate?: number) => MediaStream;
};

const DEFAULT_CANVAS_SIZE: VideoSize = { width: 1920, height: 1080 };
const MAX_CANVAS_EDGE = 1920;
const MIN_PIP_WIDTH = 280;
const MAX_PIP_WIDTH_RATIO = 0.32;
const PIP_WIDTH_RATIO = 0.24;
const PIP_MARGIN_RATIO = 0.035;

function isUsableDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function getScreenPictureInPictureCanvasSize(settings?: MediaTrackSettings | null): VideoSize {
  const sourceWidth = isUsableDimension(settings?.width) ? settings.width : DEFAULT_CANVAS_SIZE.width;
  const sourceHeight = isUsableDimension(settings?.height) ? settings.height : DEFAULT_CANVAS_SIZE.height;
  const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(sourceWidth, sourceHeight));

  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
}

export function getContainedVideoRect(source: VideoSize, target: VideoSize): VideoRect {
  if (!isUsableDimension(source.width) || !isUsableDimension(source.height)) {
    return { x: 0, y: 0, width: target.width, height: target.height };
  }

  const sourceRatio = source.width / source.height;
  const targetRatio = target.width / target.height;
  let width = target.width;
  let height = target.height;

  if (sourceRatio > targetRatio) {
    height = target.width / sourceRatio;
  } else {
    width = target.height * sourceRatio;
  }

  return {
    x: Math.round((target.width - width) / 2),
    y: Math.round((target.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function getCoverSourceRect(source: VideoSize, target: VideoSize): VideoRect {
  if (!isUsableDimension(source.width) || !isUsableDimension(source.height)) {
    return { x: 0, y: 0, width: source.width, height: source.height };
  }

  const sourceRatio = source.width / source.height;
  const targetRatio = target.width / target.height;
  let width = source.width;
  let height = source.height;
  let x = 0;
  let y = 0;

  if (sourceRatio > targetRatio) {
    width = source.height * targetRatio;
    x = (source.width - width) / 2;
  } else {
    height = source.width / targetRatio;
    y = (source.height - height) / 2;
  }

  return {
    x,
    y,
    width,
    height,
  };
}

export function getScreenPictureInPictureInsetRect(canvas: VideoSize): VideoRect {
  const margin = Math.round(Math.min(canvas.width, canvas.height) * PIP_MARGIN_RATIO);
  const maxWidth = Math.round(canvas.width * MAX_PIP_WIDTH_RATIO);
  const requestedWidth = Math.round(canvas.width * PIP_WIDTH_RATIO);
  const width = Math.min(Math.max(requestedWidth, MIN_PIP_WIDTH), maxWidth);
  const height = Math.round(width * 9 / 16);

  return {
    x: canvas.width - width - margin,
    y: canvas.height - height - margin,
    width,
    height,
  };
}

function createMutedVideoElement(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => undefined);
  return video;
}

function traceRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

export function createScreenPictureInPictureStream(
  options: CreateScreenPictureInPictureStreamOptions
): ScreenPictureInPictureStream | null {
  const screenVideoTrack = options.screenStream?.getVideoTracks().find((track) => track.readyState === 'live');
  const cameraVideoTrack = options.cameraStream?.getVideoTracks().find((track) => track.readyState === 'live');
  if (!screenVideoTrack || !cameraVideoTrack || cameraVideoTrack.enabled === false) return null;

  const canvas = document.createElement('canvas') as CanvasWithCaptureStream;
  if (typeof canvas.captureStream !== 'function') return null;

  const canvasSize = getScreenPictureInPictureCanvasSize(screenVideoTrack.getSettings());
  canvas.width = canvasSize.width;
  canvas.height = canvasSize.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const screenVideo = createMutedVideoElement(new MediaStream([screenVideoTrack]));
  const cameraVideo = createMutedVideoElement(new MediaStream([cameraVideoTrack]));
  const insetRect = getScreenPictureInPictureInsetRect(canvasSize);
  const generatedStream = canvas.captureStream(options.frameRate || 30);
  const generatedVideoTrack = generatedStream.getVideoTracks().find((track) => track.readyState === 'live');
  if (!generatedVideoTrack) {
    screenVideo.pause();
    cameraVideo.pause();
    screenVideo.srcObject = null;
    cameraVideo.srcObject = null;
    generatedStream.getTracks().forEach((track) => track.stop());
    return null;
  }

  let frame = 0;
  let cleanedUp = false;
  const draw = () => {
    ctx.fillStyle = '#050816';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (screenVideo.readyState >= 2 && screenVideo.videoWidth > 0 && screenVideo.videoHeight > 0) {
      const screenRect = getContainedVideoRect(
        { width: screenVideo.videoWidth, height: screenVideo.videoHeight },
        canvasSize
      );
      ctx.drawImage(screenVideo, screenRect.x, screenRect.y, screenRect.width, screenRect.height);
    }

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = Math.round(canvas.width * 0.012);
    ctx.shadowOffsetY = Math.round(canvas.height * 0.008);
    traceRoundedRect(ctx, insetRect.x, insetRect.y, insetRect.width, insetRect.height, Math.round(insetRect.width * 0.045));
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.restore();

    if (cameraVideo.readyState >= 2 && cameraVideo.videoWidth > 0 && cameraVideo.videoHeight > 0) {
      const sourceRect = getCoverSourceRect(
        { width: cameraVideo.videoWidth, height: cameraVideo.videoHeight },
        { width: insetRect.width, height: insetRect.height }
      );
      ctx.save();
      traceRoundedRect(ctx, insetRect.x, insetRect.y, insetRect.width, insetRect.height, Math.round(insetRect.width * 0.045));
      ctx.clip();
      ctx.drawImage(
        cameraVideo,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        insetRect.x,
        insetRect.y,
        insetRect.width,
        insetRect.height
      );
      ctx.restore();
    }

    ctx.save();
    traceRoundedRect(ctx, insetRect.x, insetRect.y, insetRect.width, insetRect.height, Math.round(insetRect.width * 0.045));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = Math.max(2, Math.round(canvas.width * 0.002));
    ctx.stroke();
    ctx.restore();

    if (!cleanedUp) frame = window.requestAnimationFrame(draw);
  };
  draw();

  return {
    stream: new MediaStream([generatedVideoTrack]),
    videoTrack: generatedVideoTrack,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (frame) window.cancelAnimationFrame(frame);
      generatedStream.getTracks().forEach((track) => track.stop());
      screenVideo.pause();
      cameraVideo.pause();
      screenVideo.srcObject = null;
      cameraVideo.srcObject = null;
    },
  };
}
