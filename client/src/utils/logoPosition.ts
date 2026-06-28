import type { CSSProperties } from 'react';
import type { LogoPlacement, LogoPosition, LogoSize } from '@studio/shared';

const LOGO_POSITION_MARGIN_CSS_PX = 12;
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;

interface LogoSourceSize {
  sourceWidth: number;
  sourceHeight: number;
}

interface LogoCanvasRectInput extends LogoSourceSize {
  placement?: LogoPlacement;
  position?: LogoPosition | null;
  size?: LogoSize;
  scaleX?: number;
  scaleY?: number;
  outputWidth?: number;
  outputHeight?: number;
}

interface LogoStageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatPercent(value: number): string {
  const fixed = (clamp(value, 0, 1) * 100).toFixed(2);
  return `${fixed.replace(/\.?0+$/, '')}%`;
}

export function normalizeLogoPosition(value: unknown): LogoPosition | null {
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

export function getLogoPositionFromPlacement(placement: LogoPlacement): LogoPosition {
  switch (placement) {
    case 'top-left':
      return { x: 0.08, y: 0.08 };
    case 'bottom-left':
      return { x: 0.08, y: 0.86 };
    case 'bottom-right':
      return { x: 0.92, y: 0.86 };
    case 'top-right':
    default:
      return { x: 0.92, y: 0.08 };
  }
}

export function getCustomLogoPositionStyle(position: LogoPosition): CSSProperties {
  return {
    left: formatPercent(position.x),
    top: formatPercent(position.y),
    transform: 'translate(-50%, -50%)',
  };
}

export function getLogoPositionFromPointer(
  clientX: number,
  clientY: number,
  stageRect: LogoStageRect
): LogoPosition | null {
  if (stageRect.width <= 0 || stageRect.height <= 0) return null;
  return normalizeLogoPosition({
    x: (clientX - stageRect.left) / stageRect.width,
    y: (clientY - stageRect.top) / stageRect.height,
  });
}

export function getLogoMaxSize(size: LogoSize): { maxWidth: number; maxHeight: number } {
  switch (size) {
    case 'small':
      return { maxWidth: 84, maxHeight: 28 };
    case 'large':
      return { maxWidth: 180, maxHeight: 58 };
    case 'medium':
    default:
      return { maxWidth: 128, maxHeight: 42 };
  }
}

export function getLogoCanvasRect(input: LogoCanvasRectInput): { x: number; y: number; width: number; height: number } | null {
  const {
    sourceWidth,
    sourceHeight,
    placement = 'top-right',
    position,
    size = 'medium',
    scaleX = 1,
    scaleY = 1,
    outputWidth = OUTPUT_WIDTH,
    outputHeight = OUTPUT_HEIGHT,
  } = input;

  if (sourceWidth <= 0 || sourceHeight <= 0) return null;

  const { maxWidth, maxHeight } = getLogoMaxSize(size);
  const cssScale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * cssScale * scaleX;
  const height = sourceHeight * cssScale * scaleY;
  const marginX = LOGO_POSITION_MARGIN_CSS_PX * scaleX;
  const marginY = LOGO_POSITION_MARGIN_CSS_PX * scaleY;
  const safeMaxX = Math.max(marginX, outputWidth - marginX - width);
  const safeMaxY = Math.max(marginY, outputHeight - marginY - height);

  if (position) {
    const normalized = normalizeLogoPosition(position);
    if (normalized) {
      return {
        x: clamp((normalized.x * outputWidth) - (width / 2), marginX, safeMaxX),
        y: clamp((normalized.y * outputHeight) - (height / 2), marginY, safeMaxY),
        width,
        height,
      };
    }
  }

  return {
    x: placement.endsWith('right') ? outputWidth - marginX - width : marginX,
    y: placement.startsWith('bottom') ? outputHeight - marginY - height : marginY,
    width,
    height,
  };
}
