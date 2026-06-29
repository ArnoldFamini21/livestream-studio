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
