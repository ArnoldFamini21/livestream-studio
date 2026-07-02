export interface SegmentationMaskRefinementOptions {
  lowCutoff: number;
  highCutoff: number;
  gamma: number;
}

export interface VirtualBackgroundRefinementSettings {
  edgeBlurPx: number;
  coreMaskOpacity: number;
  replacementBackgroundBlurPx: number;
  replacementBackgroundBrightness: number;
  replacementBackgroundSaturation: number;
  fallbackBackgroundBrightness: number;
  fallbackBackgroundSaturation: number;
}

export const DEFAULT_SEGMENTATION_MASK_REFINEMENT: SegmentationMaskRefinementOptions = {
  lowCutoff: 0.2,
  highCutoff: 0.86,
  gamma: 0.9,
};

const DEFAULT_REFINEMENT_SETTINGS: VirtualBackgroundRefinementSettings = {
  edgeBlurPx: 3.5,
  coreMaskOpacity: 0.68,
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

export function refineSegmentationMaskAlpha(
  data: Uint8ClampedArray,
  options: SegmentationMaskRefinementOptions = DEFAULT_SEGMENTATION_MASK_REFINEMENT
): void {
  const lowCutoff = clamp(options.lowCutoff, 0, 1);
  const highCutoff = Math.max(lowCutoff + 0.01, clamp(options.highCutoff, 0, 1));
  const gamma = Math.max(0.1, options.gamma);

  for (let i = 0; i < data.length; i += 4) {
    const confidence = getSegmentationConfidence(data[i], data[i + 1], data[i + 2], data[i + 3]);
    const alpha = Math.pow(smoothStep(lowCutoff, highCutoff, confidence), gamma);
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = Math.round(alpha * 255);
  }
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
