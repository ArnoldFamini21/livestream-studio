import type { VirtualBackgroundConfig } from '../hooks/useVirtualBackground.ts';

export const VIRTUAL_BACKGROUND_STORAGE_KEY = 'livestream-studio:virtual-background';
export const DEFAULT_VIRTUAL_BACKGROUND_CONFIG: VirtualBackgroundConfig = { mode: 'off' };
export const MIN_VIRTUAL_BACKGROUND_BLUR = 4;
export const MAX_VIRTUAL_BACKGROUND_BLUR = 28;
export const DEFAULT_VIRTUAL_BACKGROUND_BLUR = 12;
const MAX_IMAGE_SRC_LENGTH = 6_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeBlurPx(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VIRTUAL_BACKGROUND_BLUR;
  return Math.min(MAX_VIRTUAL_BACKGROUND_BLUR, Math.max(MIN_VIRTUAL_BACKGROUND_BLUR, Math.round(numeric)));
}

function isSupportedImageSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const src = value.trim();
  if (!src || src.length > MAX_IMAGE_SRC_LENGTH) return false;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(src)) return true;
  if (/^https?:\/\//i.test(src)) return true;
  return false;
}

export function normalizeVirtualBackgroundConfig(value: unknown): VirtualBackgroundConfig {
  if (!isRecord(value)) return DEFAULT_VIRTUAL_BACKGROUND_CONFIG;

  if (value.mode === 'blur') {
    return {
      mode: 'blur',
      blurPx: normalizeBlurPx(value.blurPx),
    };
  }

  if (value.mode === 'image' && isSupportedImageSource(value.imageSrc)) {
    return {
      mode: 'image',
      imageSrc: value.imageSrc.trim(),
    };
  }

  return DEFAULT_VIRTUAL_BACKGROUND_CONFIG;
}

export function parseVirtualBackgroundConfig(json: string | null): VirtualBackgroundConfig {
  if (!json) return DEFAULT_VIRTUAL_BACKGROUND_CONFIG;
  try {
    return normalizeVirtualBackgroundConfig(JSON.parse(json));
  } catch {
    return DEFAULT_VIRTUAL_BACKGROUND_CONFIG;
  }
}

export function serializeVirtualBackgroundConfig(config: VirtualBackgroundConfig): string {
  return JSON.stringify(normalizeVirtualBackgroundConfig(config));
}
