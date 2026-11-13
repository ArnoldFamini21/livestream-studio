/**
 * Shares the host's canvas background with everyone in the studio.
 *
 * Colours, gradients and https URLs ride the studio branding message as they
 * are. A custom picture is far larger than the 64 KiB signaling message cap,
 * so the host uploads it to the authorized stage-image store (like slides) and
 * branding only names it by id. Admitted participants load it with their stage
 * read token; nobody else can.
 */
import type { StageBackground } from '@studio/shared';
import { CANVAS_BACKGROUND_MAX_BYTES, prepareCanvasBackground } from './canvasBackgroundImage.ts';
import { getStageImageUrl, getStageMirrorSourceKey, postStageImage, type StageImageUploadAuth } from './stageMirror.ts';
import { runWithRetry, type RetryOptions } from './pictureUpload.ts';

const NO_BACKGROUND: StageBackground = { type: 'none', value: '' };
const UPLOADABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** A picture only this browser can read (an inline data URL or an object URL) must be uploaded first. */
export function needsCanvasBackgroundUpload(background: StageBackground): boolean {
  return background.type === 'image' && /^(data|blob):/i.test(background.value);
}

/** Cheap cache key for an uploaded background picture; data URLs are hundreds of KiB. */
export function getCanvasBackgroundUploadKey(background: StageBackground): string {
  return getStageMirrorSourceKey('canvas-background', background.value);
}

/**
 * The background as studio branding carries it. Pass the uploaded id for a
 * local picture; without one a local picture or a session-only video is not
 * shareable and guests see the default canvas instead.
 */
export function toSharedStageBackground(background: StageBackground, imageId?: string): StageBackground {
  if (needsCanvasBackgroundUpload(background)) {
    return imageId ? { type: 'image', value: '', imageId } : NO_BACKGROUND;
  }
  if (background.type === 'video' && background.value.startsWith('blob:')) return NO_BACKGROUND;
  if (background.type === 'none') return NO_BACKGROUND;
  // A stale id is never re-sent next to a fresh value.
  return { type: background.type, value: background.value };
}

/** Where to load a shared background picture, or null when the background has none. */
export function getSharedBackgroundImageUrl(background: StageBackground | null | undefined, roomId: string): string | null {
  return background?.type === 'image' && background.imageId ? getStageImageUrl(roomId, background.imageId) : null;
}

/**
 * The background a participant actually paints for a shared one: an uploaded
 * picture becomes the object URL it was loaded into (or nothing if it could not
 * be loaded), and values another browser cannot open fall back to the default.
 */
export function resolveSharedStageBackground(background: StageBackground | null | undefined, loadedImageUrl: string | null): StageBackground {
  if (!background || background.type === 'none') return NO_BACKGROUND;
  if (background.type === 'image' && background.imageId) {
    return loadedImageUrl ? { type: 'image', value: loadedImageUrl } : NO_BACKGROUND;
  }
  if ((background.type === 'image' || background.type === 'video') && background.value.startsWith('blob:')) return NO_BACKGROUND;
  if (!background.value) return NO_BACKGROUND;
  return { type: background.type, value: background.value };
}

/** The picture as uploaded: JPEG, PNG or WebP within the background cap, re-encoded only if needed. */
export async function prepareCanvasBackgroundUpload(source: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const blob = await (await fetchImpl(source)).blob();
  if (UPLOADABLE_TYPES.has(blob.type) && blob.size > 0 && blob.size <= CANVAS_BACKGROUND_MAX_BYTES) return blob;
  return prepareCanvasBackground(new File([blob], 'canvas-background', { type: blob.type }));
}

export async function uploadCanvasBackground(
  background: StageBackground,
  auth: StageImageUploadAuth,
  fetchImpl: typeof fetch = fetch,
  retry?: RetryOptions,
): Promise<string> {
  // Prepared once; only the network part has a time limit and is retried.
  const body = await prepareCanvasBackgroundUpload(background.value, fetchImpl);
  return runWithRetry((signal) => postStageImage(body, auth, fetchImpl, { signal }), retry);
}
