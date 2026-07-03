export interface SegmentationMaskRefinementOptions {
  lowCutoff: number;
  highCutoff: number;
  gamma: number;
  invert?: boolean;
}

export interface VirtualBackgroundRefinementSettings {
  edgeBlurPx: number;
  maskExpansionPx: number;
  coreMaskOpacity: number;
  edgeFeatherOpacity: number;
  replacementBackgroundBlurPx: number;
  replacementBackgroundBrightness: number;
  replacementBackgroundSaturation: number;
  fallbackBackgroundBrightness: number;
  fallbackBackgroundSaturation: number;
}

export const DEFAULT_SEGMENTATION_MASK_REFINEMENT: SegmentationMaskRefinementOptions = {
  lowCutoff: 0.04,
  highCutoff: 0.65,
  gamma: 0.75,
};

const DEFAULT_REFINEMENT_SETTINGS: VirtualBackgroundRefinementSettings = {
  edgeBlurPx: 2.25,
  maskExpansionPx: 1.5,
  coreMaskOpacity: 1,
  edgeFeatherOpacity: 0.32,
  replacementBackgroundBlurPx: 1.2,
  replacementBackgroundBrightness: 0.92,
  replacementBackgroundSaturation: 0.92,
  fallbackBackgroundBrightness: 0.96,
  fallbackBackgroundSaturation: 0.9,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export function smoothStep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function getSegmentationConfidence(r: number, g: number, b: number, a: number): number {
  const alpha = clamp(a / 255, 0, 1);
  if (r >= 255 && g >= 255 && b >= 255 && alpha >= 0.98) return 1;
  const luminance = clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1);

  // MediaPipe masks may encode confidence in alpha, or as an opaque grayscale
  // image depending on browser/backend. Prefer alpha only when it is not fully
  // opaque; otherwise use luminance so opaque black still means background.
  return alpha < 0.98 ? alpha : luminance;
}

function averageMaskConfidence(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number
): number {
  const x0 = clamp(Math.floor(startX), 0, width - 1);
  const y0 = clamp(Math.floor(startY), 0, height - 1);
  const x1 = clamp(Math.ceil(endX), x0 + 1, width);
  const y1 = clamp(Math.ceil(endY), y0 + 1, height);
  let total = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * width + x) * 4;
      total += getSegmentationConfidence(data[index], data[index + 1], data[index + 2], data[index + 3]);
      count += 1;
    }
  }

  return count > 0 ? total / count : 0;
}

export function shouldInvertSegmentationMask(
  data: Uint8ClampedArray,
  width: number,
  height: number
): boolean {
  if (width <= 1 || height <= 1 || data.length < width * height * 4) return false;

  const center = averageMaskConfidence(
    data,
    width,
    height,
    width * 0.34,
    height * 0.18,
    width * 0.66,
    height * 0.78
  );
  const cornerSizeX = width * 0.18;
  const cornerSizeY = height * 0.18;
  const corners = (
    averageMaskConfidence(data, width, height, 0, 0, cornerSizeX, cornerSizeY) +
    averageMaskConfidence(data, width, height, width - cornerSizeX, 0, width, cornerSizeY) +
    averageMaskConfidence(data, width, height, 0, height - cornerSizeY, cornerSizeX, height) +
    averageMaskConfidence(data, width, height, width - cornerSizeX, height - cornerSizeY, width, height)
  ) / 4;

  return corners > 0.62 && center < 0.42 && corners - center > 0.25;
}

export function refineSegmentationMaskAlpha(
  data: Uint8ClampedArray,
  options: SegmentationMaskRefinementOptions = DEFAULT_SEGMENTATION_MASK_REFINEMENT
): void {
  const lowCutoff = clamp(options.lowCutoff, 0, 1);
  const highCutoff = Math.max(lowCutoff + 0.01, clamp(options.highCutoff, 0, 1));
  const gamma = Math.max(0.1, options.gamma);

  for (let i = 0; i < data.length; i += 4) {
    const rawConfidence = getSegmentationConfidence(data[i], data[i + 1], data[i + 2], data[i + 3]);
    const confidence = options.invert ? 1 - rawConfidence : rawConfidence;
    const alpha = Math.pow(smoothStep(lowCutoff, highCutoff, confidence), gamma);
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = Math.round(alpha * 255);
  }
}

export function prepareSegmentationMaskAlpha(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: SegmentationMaskRefinementOptions = DEFAULT_SEGMENTATION_MASK_REFINEMENT
): { inverted: boolean } {
  const inverted = shouldInvertSegmentationMask(data, width, height);
  refineSegmentationMaskAlpha(data, { ...options, invert: inverted });
  return { inverted };
}

export function getVirtualBackgroundRefinementSettings(
  width: number,
  height: number
): VirtualBackgroundRefinementSettings {
  const longestEdge = Math.max(width, height, 1);
  const scale = clamp(longestEdge / 1280, 0.75, 1.45);

  return {
    ...DEFAULT_REFINEMENT_SETTINGS,
    edgeBlurPx: roundToHalf(clamp(DEFAULT_REFINEMENT_SETTINGS.edgeBlurPx * scale, 2.5, 5.5)),
    maskExpansionPx: roundToHalf(clamp(DEFAULT_REFINEMENT_SETTINGS.maskExpansionPx * scale, 1, 3)),
    replacementBackgroundBlurPx: roundToHalf(clamp(
      DEFAULT_REFINEMENT_SETTINGS.replacementBackgroundBlurPx * scale,
      0.8,
      2
    )),
  };
}

export function buildReplacementBackgroundFilter(settings: VirtualBackgroundRefinementSettings): string {
  return [
    `blur(${settings.replacementBackgroundBlurPx}px)`,
    `brightness(${settings.replacementBackgroundBrightness})`,
    `saturate(${settings.replacementBackgroundSaturation})`,
  ].join(' ');
}

export function buildFallbackBackgroundFilter(
  blurPx: number,
  settings: VirtualBackgroundRefinementSettings
): string {
  return [
    `blur(${Math.max(0, Math.round(blurPx))}px)`,
    `brightness(${settings.fallbackBackgroundBrightness})`,
    `saturate(${settings.fallbackBackgroundSaturation})`,
  ].join(' ');
}

export function getExpandedDrawRect(
  width: number,
  height: number,
  bleedPx: number
): { x: number; y: number; width: number; height: number } {
  const bleed = Math.max(0, Math.ceil(bleedPx));
  return {
    x: -bleed,
    y: -bleed,
    width: width + bleed * 2,
    height: height + bleed * 2,
  };
}
