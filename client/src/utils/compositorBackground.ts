import type { StageBackground } from '@studio/shared';
import { getContextCanvasSize } from './compositorCanvasSize.ts';

/** The fill behind every program frame when no studio background is set. */
export const DEFAULT_PROGRAM_BACKGROUND = '#0f172a';
function splitGradientParts(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseGradientColorStop(part: string): { color: string; offset?: number } {
  const pieces = part.split(/\s+/).filter(Boolean);
  if (pieces.length < 2) return { color: part };

  const stop = pieces[pieces.length - 1];
  const color = pieces.slice(0, -1).join(' ');
  if (stop.endsWith('%')) {
    const percent = Number(stop.slice(0, -1));
    if (Number.isFinite(percent)) return { color, offset: Math.min(1, Math.max(0, percent / 100)) };
  }

  return { color: part };
}

export function createCanvasGradient(
  ctx: CanvasRenderingContext2D,
  value: string,
  width: number,
  height: number
): CanvasGradient | null {
  const match = value.match(/^linear-gradient\((.*)\)$/i);
  if (!match) return null;

  const parts = splitGradientParts(match[1]);
  if (parts.length < 2) return null;

  let angle = 180;
  let stopParts = parts;
  const first = parts[0].toLowerCase();
  if (first.endsWith('deg')) {
    const parsed = Number(first.replace('deg', '').trim());
    if (Number.isFinite(parsed)) {
      angle = parsed;
      stopParts = parts.slice(1);
    }
  }
  if (stopParts.length < 2) return null;

  const radians = ((angle - 90) * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const half = Math.max(width, height);
  const gradient = ctx.createLinearGradient(
    width / 2 - dx * half,
    height / 2 - dy * half,
    width / 2 + dx * half,
    height / 2 + dy * half
  );

  const stops = stopParts.map(parseGradientColorStop);
  stops.forEach((stop, index) => {
    const offset = stop.offset ?? (stops.length === 1 ? 0 : index / (stops.length - 1));
    gradient.addColorStop(offset, stop.color);
  });

  return gradient;
}

function drawCoverSource(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceNaturalWidth: number,
  sourceNaturalHeight: number,
  width: number,
  height: number
) {
  const imageRatio = sourceNaturalWidth / sourceNaturalHeight;
  const canvasRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = sourceNaturalWidth;
  let sourceHeight = sourceNaturalHeight;

  if (imageRatio > canvasRatio) {
    sourceWidth = sourceNaturalHeight * canvasRatio;
    sourceX = (sourceNaturalWidth - sourceWidth) / 2;
  } else {
    sourceHeight = sourceNaturalWidth / canvasRatio;
    sourceY = (sourceNaturalHeight - sourceHeight) / 2;
  }

  ctx.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number
) {
  drawCoverSource(ctx, image, image.width, image.height, width, height);
}

function drawCoverVideo(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number
) {
  drawCoverSource(ctx, video, video.videoWidth, video.videoHeight, width, height);
}

/**
 * Paints the studio canvas background into the program frame (stream, program
 * recording and program return), the same background the DOM preview shows.
 */
export function drawStageBackground(
  ctx: CanvasRenderingContext2D,
  background: StageBackground | undefined,
  backgroundImage: HTMLImageElement | null,
  backgroundVideo: HTMLVideoElement | null = null
) {
  const { width, height } = getContextCanvasSize(ctx);

  ctx.fillStyle = DEFAULT_PROGRAM_BACKGROUND;
  ctx.fillRect(0, 0, width, height);

  if (!background || background.type === 'none' || !background.value) return;

  if (background.type === 'color') {
    ctx.fillStyle = background.value;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (background.type === 'gradient') {
    const gradient = createCanvasGradient(ctx, background.value, width, height);
    if (gradient) {
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  if (background.type === 'image' && backgroundImage?.complete && backgroundImage.naturalWidth > 0) {
    drawCoverImage(ctx, backgroundImage, width, height);
    return;
  }

  if (background.type === 'video' && backgroundVideo && backgroundVideo.readyState >= 2 && backgroundVideo.videoWidth > 0 && backgroundVideo.videoHeight > 0) {
    drawCoverVideo(ctx, backgroundVideo, width, height);
  }
}
