/**
 * Prepares a studio logo before it is stored and shared: scaled down in the
 * browser to at most LOGO_IMAGE_MAX_EDGE px on its long edge (transparency is
 * kept) so it fits the image store. A small file that already fits is kept as
 * it is. Anything the browser cannot decode, or that cannot be made small
 * enough, is refused with a message the branding panel shows.
 */
import { LOGO_IMAGE_MAX_BYTES, LOGO_IMAGE_MAX_EDGE } from '@studio/shared';

/** Largest file the browser is asked to decode. */
export const LOGO_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
/** Below this long edge a logo is refused rather than shrunk into a smudge. */
export const LOGO_MIN_EDGE = 128;
const UPLOADABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class LogoPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoPrepareError';
  }
}

export interface LogoSourceInfo {
  width: number;
  height: number;
  bytes: number;
  type: string;
}

export type LogoScalePlan =
  | { action: 'keep' }
  | { action: 'scale'; width: number; height: number };

/** Keep a picture that already fits the store as it is; otherwise the size to scale it to (never upscaled). */
export function planLogoScale(
  source: LogoSourceInfo,
  maxEdge = LOGO_IMAGE_MAX_EDGE,
  maxBytes = LOGO_IMAGE_MAX_BYTES,
): LogoScalePlan {
  const longEdge = Math.max(source.width, source.height);
  if (!(source.width > 0) || !(source.height > 0)) throw new LogoPrepareError('This image has no usable size. Choose another logo.');
  if (longEdge <= maxEdge && source.bytes > 0 && source.bytes <= maxBytes && UPLOADABLE_TYPES.has(source.type)) return { action: 'keep' };
  const scale = Math.min(1, maxEdge / longEdge);
  return { action: 'scale', width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}

export type LogoEncoder = (width: number, height: number, format: 'png' | 'webp') => Promise<Blob | null>;

/**
 * Encode at the planned size; when the result is still above the store's cap,
 * try lossy WebP (still with transparency), then shrink and try again.
 * Resolves to null when even the smallest size does not fit.
 */
export async function encodeLogoWithinLimit(
  start: { width: number; height: number },
  encode: LogoEncoder,
  maxBytes = LOGO_IMAGE_MAX_BYTES,
): Promise<Blob | null> {
  let width = start.width;
  let height = start.height;
  for (;;) {
    for (const format of ['png', 'webp'] as const) {
      const blob = await encode(width, height, format);
      if (blob && blob.size > 0 && blob.size <= maxBytes) return blob;
    }
    const next = { width: Math.round(width * 0.75), height: Math.round(height * 0.75) };
    if (Math.max(next.width, next.height) < LOGO_MIN_EDGE) return null;
    width = Math.max(1, next.width);
    height = Math.max(1, next.height);
  }
}

async function decode(blob: Blob): Promise<{ width: number; height: number; draw: (context: CanvasRenderingContext2D, width: number, height: number) => void; close: () => void }> {
  try {
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, draw: (context, w, h) => context.drawImage(bitmap, 0, 0, w, h), close: () => bitmap.close() };
  } catch {
    // Some browsers cannot decode every format (SVG, for one) into a bitmap; an image element can.
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      return { width, height, draw: (context, w, h) => context.drawImage(image, 0, 0, w, h), close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new LogoPrepareError('This image could not be opened. Choose a PNG, JPG, WebP, GIF or SVG logo.');
    }
  }
}

/** The logo as it is stored and uploaded: a PNG, JPEG or WebP within the store's cap and 1024 px. */
export async function prepareLogoImage(source: Blob): Promise<Blob> {
  if (source.size > LOGO_MAX_SOURCE_BYTES) throw new LogoPrepareError('This logo file is too large (over 25 MB). Choose a smaller one.');
  const decoded = await decode(source);
  try {
    const plan = planLogoScale({ width: decoded.width, height: decoded.height, bytes: source.size, type: source.type });
    if (plan.action === 'keep') return source;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new LogoPrepareError('This browser cannot prepare logos. Try another browser.');
    const encoded = await encodeLogoWithinLimit(plan, async (width, height, format) => {
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      decoded.draw(context, width, height);
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'png' ? 'image/png' : 'image/webp', 0.9));
    });
    if (!encoded) throw new LogoPrepareError('This logo is too detailed to share. Choose a simpler or smaller picture.');
    return encoded;
  } finally {
    decoded.close();
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the picture')));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture'));
    reader.readAsDataURL(blob);
  });
}
