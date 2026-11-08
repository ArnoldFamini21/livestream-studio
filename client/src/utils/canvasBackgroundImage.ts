/** A self-contained image that fits studio persistence and the branding transport. */
export const CANVAS_BACKGROUND_MAX_EDGE = 1920;
export const CANVAS_BACKGROUND_MAX_BYTES = 400 * 1024;
export const CANVAS_BACKGROUND_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export function fitCanvasBackground(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('This image has no usable dimensions.');
  const scale = Math.min(1, CANVAS_BACKGROUND_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** WebP keeps PNG transparency while bounding the data URL stored and shared by the studio. */
export async function prepareCanvasBackground(file: File): Promise<File> {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error('Choose a JPG, PNG, or WebP image.');
  if (file.size > CANVAS_BACKGROUND_MAX_SOURCE_BYTES) throw new Error('Image is too large (max 20 MB).');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('This image could not be opened. Choose another JPG, PNG, or WebP file.'); }
  try {
    const size = fitCanvasBackground(bitmap.width, bitmap.height);
    if (bitmap.width <= CANVAS_BACKGROUND_MAX_EDGE && bitmap.height <= CANVAS_BACKGROUND_MAX_EDGE && file.size <= CANVAS_BACKGROUND_MAX_BYTES) return file;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare background images.');
    for (let scale = 1; scale >= 0.2; scale *= 0.75) {
      canvas.width = Math.max(1, Math.round(size.width * scale));
      canvas.height = Math.max(1, Math.round(size.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.75, 0.6]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= CANVAS_BACKGROUND_MAX_BYTES) {
          return new File([blob], file.name.replace(/\.[^.]+$/, '') + (blob.type === 'image/webp' ? '.webp' : '.png'), { type: blob.type });
        }
      }
    }
    throw new Error('This image could not be optimized. Choose a smaller image.');
  } finally { bitmap.close(); }
}
