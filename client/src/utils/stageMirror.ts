/**
 * Mirrors what the host has on stage (a slide, an image) to guests. Pictures
 * are too large for signaling, so the host uploads each one to the studio
 * server and the signaling message only names it.
 */
import type { ActiveMedia, LayoutMode, StageContentPayload } from '@studio/shared';
import { buildApiUrl } from './apiClient.ts';
import { clampPresentationSlideIndex, getPresentationSlides } from './presentationDeckControls.ts';

/** Guests see the stage in a panel, so a 720p picture is sharp enough and quick to load. */
export const STAGE_MIRROR_MAX_WIDTH = 1280;
export const STAGE_MIRROR_MAX_HEIGHT = 720;
const STAGE_MIRROR_JPEG_QUALITY = 0.82;

export const EMPTY_STAGE_CONTENT_SIGNATURE = JSON.stringify({ media: null });

export function getStageImageUrl(roomId: string, imageId: string): string {
  return buildApiUrl(`/api/rooms/${encodeURIComponent(roomId)}/stage-images/${encodeURIComponent(imageId)}`);
}

export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The picture that represents the media on stage right now, if it has one. */
export function getStageMirrorSource(media: ActiveMedia, slideIndex: number): { source?: string; slideIndex?: number; slideCount?: number } {
  const slides = getPresentationSlides(media);
  if (slides.length > 0) {
    const index = clampPresentationSlideIndex(slideIndex, slides.length);
    return { source: slides[index]?.imageUrl, slideIndex: index, slideCount: slides.length };
  }
  if (media.type === 'image') return { source: media.url };
  return {};
}

/** A cheap cache key for a picture source; data URLs can be megabytes long. */
export function getStageMirrorSourceKey(mediaId: string, source: string): string {
  return `${mediaId}|${source.length}|${source.slice(0, 48)}|${source.slice(-48)}`;
}

export function buildStageContent(
  media: ActiveMedia | null,
  details: { imageId?: string; slideIndex?: number; slideCount?: number; layout?: LayoutMode }
): StageContentPayload {
  if (!media) return { media: null };
  return {
    media: {
      id: media.assetId || media.url || media.name,
      type: media.type,
      name: media.name,
      ...(details.imageId ? { imageId: details.imageId } : {}),
      ...(details.slideIndex !== undefined ? { slideIndex: details.slideIndex } : {}),
      ...(details.slideCount ? { slideCount: details.slideCount } : {}),
    },
    ...(details.layout ? { layout: details.layout } : {}),
  };
}

/** What a guest puts on their own stage for the host's content. */
export function stageContentToActiveMedia(content: StageContentPayload | null | undefined, roomId: string): ActiveMedia | null {
  const media = content?.media;
  if (!media) return null;
  if (media.imageId) {
    return { assetId: media.id, type: 'image', url: getStageImageUrl(roomId, media.imageId), name: media.name };
  }
  // Videos and documents have no picture to share; show their name.
  return { assetId: media.id, type: media.type === 'presentation' ? 'presentation' : 'file', url: '', name: media.name };
}

async function downscaleToJpeg(source: string): Promise<Blob> {
  const response = await fetch(source);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, STAGE_MIRROR_MAX_WIDTH, STAGE_MIRROR_MAX_HEIGHT);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Could not encode the stage picture'))), 'image/jpeg', STAGE_MIRROR_JPEG_QUALITY);
    });
  } finally {
    bitmap.close();
  }
}

export async function uploadStageImage(
  source: string,
  auth: { roomId: string; participantId: string; token: string }
): Promise<string> {
  const body = await downscaleToJpeg(source);
  const response = await fetch(buildApiUrl(`/api/rooms/${encodeURIComponent(auth.roomId)}/stage-images`), {
    method: 'POST',
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Participant-Id': auth.participantId,
      'X-Stage-Token': auth.token,
    },
    body,
  });
  if (!response.ok) throw new Error(`Stage picture upload failed (${response.status})`);
  const result = await response.json() as { imageId?: unknown };
  if (typeof result.imageId !== 'string') throw new Error('Stage picture upload returned no id');
  return result.imageId;
}
