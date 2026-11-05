/**
 * Canvas text does not wait for web fonts: drawing before Inter has loaded
 * silently falls back to Arial, so the broadcast's glyph widths (and where
 * lower-third and banner text gets cut) differ from the preview. The program
 * compositor loads the faces it draws with before its first frame.
 */

/** Weights and sizes the compositor draws with (sizes only need to be valid). */
export const COMPOSITOR_CANVAS_FONTS: readonly string[] = [
  '400 16px Inter',
  '500 16px Inter',
  '600 16px Inter',
  '700 16px Inter',
  '800 16px Inter',
  '900 16px Inter',
];

export const CANVAS_FONT_LOAD_TIMEOUT_MS = 1_500;

interface FontFaceSetLike {
  load(font: string, text?: string): Promise<unknown>;
}

/**
 * Resolves once every face has loaded, failed, or the timeout passed: a
 * missing font must never hold the broadcast back.
 */
export function loadCanvasFonts(
  fonts: readonly string[] = COMPOSITOR_CANVAS_FONTS,
  fontSet: FontFaceSetLike | null | undefined = typeof document !== 'undefined' ? document.fonts : undefined,
  timeoutMs = CANVAS_FONT_LOAD_TIMEOUT_MS
): Promise<'loaded' | 'timeout' | 'unavailable'> {
  if (!fontSet || typeof fontSet.load !== 'function') return Promise.resolve('unavailable');
  const loads = Promise.all(fonts.map((font) => fontSet.load(font).catch(() => undefined)))
    .then(() => 'loaded' as const);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  return Promise.race([loads, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
