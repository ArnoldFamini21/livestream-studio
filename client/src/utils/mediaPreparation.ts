import type { StudioMediaAsset, StudioMediaType } from '@studio/shared';
import { MAX_PRESENTATION_PREVIEW_BYTES } from './presentationPreview.ts';

export const MAX_STUDIO_MEDIA_ASSETS = 80;

/** Links must point to a browser-readable file, not a streaming service page. */
export function normalizeMediaAssetUrl(value: string, type: 'video' | 'image'): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete HTTP or HTTPS link to a media file.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS media link without a username or password.');
  }
  const hostname = url.hostname.toLowerCase();
  const isVideoPage = ['youtube.com', 'youtu.be', 'vimeo.com', 'youtube-nocookie.com']
    .some(host => hostname === host || hostname.endsWith(`.${host}`));
  if (type === 'video' && isVideoPage) {
    throw new Error('Use a direct video file link, upload the clip, or share the browser tab to show this video.');
  }
  return url.href;
}

/** Match the renderer's real limits before allocating previews or sending a file. */
export function getMediaFilePreparationError(
  file: Pick<File, 'name' | 'size'>,
  type: StudioMediaType
): string | undefined {
  if (file.size === 0) return 'This file is empty. Choose a file with content.';
  if (/\.key$/i.test(file.name)) {
    return 'Export this Keynote presentation as PDF or PowerPoint (.pptx), then add the exported file.';
  }
  if ((type === 'presentation' || type === 'pdf') && file.size > MAX_PRESENTATION_PREVIEW_BYTES) {
    return 'Presentations must be 50 MB or smaller. Compress the deck or split it into smaller files.';
  }
  return undefined;
}

export function assertMediaLibraryCapacity(currentCount: number, incomingCount: number): void {
  if (currentCount + incomingCount <= MAX_STUDIO_MEDIA_ASSETS) return;
  const available = Math.max(0, MAX_STUDIO_MEDIA_ASSETS - currentCount);
  throw new Error(available === 0
    ? 'Your media library is full. Remove a file before adding another.'
    : `Your media library has room for ${available} more file${available === 1 ? '' : 's'}. Add fewer files or remove some first.`);
}

export function getMediaBatchFailureMessage(
  failures: Array<{ name: string; message: string }>,
  total: number
): string {
  if (failures.length === 1) return `${failures[0].name}: ${failures[0].message}`;
  const succeeded = Math.max(0, total - failures.length);
  return `${succeeded > 0 ? `${succeeded} file${succeeded === 1 ? '' : 's'} added. ` : ''}${failures.length} files need attention. Check the message beside each file.`;
}

interface MediaProbeOptions {
  timeoutMs?: number;
  createElement?: (type: 'image' | 'video') => HTMLImageElement | HTMLVideoElement;
}

/** Verify decodability and CORS before a file can replace the current stage. */
export function probeMediaAsset(
  url: string,
  type: 'image' | 'video',
  options: MediaProbeOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = options.createElement
      ? options.createElement(type)
      : document.createElement(type === 'image' ? 'img' : 'video');
    const video = type === 'video' ? element as HTMLVideoElement : null;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      element.onload = null;
      element.onerror = null;
      if (video) { video.onloadeddata = null; video.pause(); }
      element.removeAttribute('src');
      if (video) video.load();
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => {
      const hasFrame = video
        ? video.videoWidth > 0 && video.videoHeight > 0
        : (element as HTMLImageElement).naturalWidth > 0;
      finish(hasFrame ? undefined : new Error(`This ${type} has no readable picture. Try another file.`));
    };
    element.crossOrigin = 'anonymous';
    element.onerror = () => finish(new Error(
      url.startsWith('blob:')
        ? `This ${type} cannot be opened in this browser. ${type === 'video' ? 'Try an MP4 with H.264 video and AAC audio.' : 'Try a PNG, JPEG, or WebP image.'}`
        : `This ${type} link could not be loaded for sharing. Check that it is a direct file link with cross-origin access, or upload the file.`
    ));
    if (video) {
      video.preload = 'auto';
      video.muted = true;
      video.onloadeddata = loaded;
    } else element.onload = loaded;
    timeoutId = setTimeout(() => finish(new Error(`This ${type} took too long to load. Try again or upload the file.`)), options.timeoutMs ?? 15_000);
    element.src = url;
    if (video) video.load();
  });
}

/** A page reload cannot resume an in-memory decode job or a local object URL. */
export function getPersistableMediaAssets(assets: StudioMediaAsset[]): StudioMediaAsset[] {
  return assets.filter(asset => asset.source === 'url' && asset.processingStatus !== 'processing');
}
