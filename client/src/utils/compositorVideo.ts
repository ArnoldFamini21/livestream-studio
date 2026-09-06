export type CompositorVideoObjectFit = 'cover' | 'contain' | 'fill';

function hasCanvasSafeMediaSource(
  element: { currentSrc: string; src: string; crossOrigin: string | null },
  pageUrl: string
): boolean {
  try {
    const url = new URL(element.currentSrc || element.src, pageUrl);
    if (url.protocol === 'blob:' || url.protocol === 'data:') return true;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === new URL(pageUrl).origin || element.crossOrigin === 'anonymous';
  } catch {
    return false;
  }
}

export function canDrawMediaImage(
  image: Pick<HTMLImageElement, 'complete' | 'naturalWidth' | 'naturalHeight' | 'crossOrigin' | 'currentSrc' | 'src'>,
  pageUrl: string
): boolean {
  return image.complete && finitePositive(image.naturalWidth) && finitePositive(image.naturalHeight)
    && hasCanvasSafeMediaSource(image, pageUrl);
}

export function canDrawMediaVideo(
  video: Pick<HTMLVideoElement, 'readyState' | 'videoWidth' | 'videoHeight' | 'crossOrigin' | 'currentSrc' | 'src'>,
  pageUrl: string
): boolean {
  if (video.readyState < 2 || !finitePositive(video.videoWidth) || !finitePositive(video.videoHeight)) return false;
  // Remote elements must successfully load under CORS before the compositor
  // can draw them without tainting the canvas and breaking its recording.
  return hasCanvasSafeMediaSource(video, pageUrl);
}

export interface CompositorVideoDrawPlan {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  destX: number;
  destY: number;
  destWidth: number;
  destHeight: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalizeObjectFit(value: string | null | undefined): CompositorVideoObjectFit {
  if (value === 'contain' || value === 'cover') return value;
  return 'fill';
}

export function getCompositorVideoObjectFit(video: HTMLVideoElement): CompositorVideoObjectFit {
  const inlineFit = normalizeObjectFit(video.style.objectFit);
  if (inlineFit !== 'fill') return inlineFit;

  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return inlineFit;
  }

  return normalizeObjectFit(window.getComputedStyle(video).objectFit);
}

export function isCompositorVideoHorizontallyMirrored(video: HTMLVideoElement): boolean {
  const inlineTransform = video.style.transform || '';
  if (inlineTransform.includes('scaleX(-1)')) return true;

  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return false;
  }

  const transform = window.getComputedStyle(video).transform || '';
  return /^matrix\(-1(?:\.0+)?,\s*0(?:\.0+)?,\s*0(?:\.0+)?,\s*1(?:\.0+)?,/.test(transform);
}

export function getCompositorVideoDrawPlan(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
  objectFit: CompositorVideoObjectFit
): CompositorVideoDrawPlan | null {
  if (!finitePositive(sourceWidth) || !finitePositive(sourceHeight) || !finitePositive(boxWidth) || !finitePositive(boxHeight)) {
    return null;
  }

  if (objectFit === 'contain') {
    const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
    const destWidth = sourceWidth * scale;
    const destHeight = sourceHeight * scale;
    return {
      sourceX: 0,
      sourceY: 0,
      sourceWidth,
      sourceHeight,
      destX: (boxWidth - destWidth) / 2,
      destY: (boxHeight - destHeight) / 2,
      destWidth,
      destHeight,
    };
  }

  if (objectFit === 'cover') {
    const sourceRatio = sourceWidth / sourceHeight;
    const boxRatio = boxWidth / boxHeight;
    let croppedWidth = sourceWidth;
    let croppedHeight = sourceHeight;
    let sourceX = 0;
    let sourceY = 0;

    if (sourceRatio > boxRatio) {
      croppedWidth = sourceHeight * boxRatio;
      sourceX = (sourceWidth - croppedWidth) / 2;
    } else if (sourceRatio < boxRatio) {
      croppedHeight = sourceWidth / boxRatio;
      sourceY = (sourceHeight - croppedHeight) / 2;
    }

    return {
      sourceX,
      sourceY,
      sourceWidth: croppedWidth,
      sourceHeight: croppedHeight,
      destX: 0,
      destY: 0,
      destWidth: boxWidth,
      destHeight: boxHeight,
    };
  }

  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth,
    sourceHeight,
    destX: 0,
    destY: 0,
    destWidth: boxWidth,
    destHeight: boxHeight,
  };
}
