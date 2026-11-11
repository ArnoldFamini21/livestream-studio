import { chatOverlayFont, type ChatOverlayLayoutResult, type TextMeasure } from './chatOverlayLayout.ts';

/**
 * Canvas side of the on-screen chat overlay: a measurer with a bounded
 * cache, a font-load revision (so layouts are redone when a font arrives),
 * and a draw function that only replays the layout's primitives.
 */

let fontRevision = 0;
if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => { fontRevision += 1; });
}

/** Changes whenever a web font finishes loading; part of the layout cache token. */
export function getChatOverlayFontRevision(): number {
  return fontRevision;
}

const MEASURE_CACHE_LIMIT = 4000;

/** Measures with a 2D context and remembers every result (cleared when fonts load or the cache grows large). */
export function createCanvasTextMeasure(getContext: () => { font: string; measureText(text: string): { width: number } } | null): TextMeasure {
  const cache = new Map<string, number>();
  let revision = fontRevision;
  return (font, text) => {
    if (revision !== fontRevision || cache.size >= MEASURE_CACHE_LIMIT) {
      cache.clear();
      revision = fontRevision;
    }
    const key = `${font}|${text}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const ctx = getContext();
    let width: number;
    if (ctx) {
      ctx.font = font;
      width = ctx.measureText(text).width;
    } else {
      // No canvas available (tests, very early render): a stable estimate.
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 16;
      width = Array.from(text).length * px * 0.55;
    }
    cache.set(key, width);
    return width;
  };
}

type DrawContext = Pick<CanvasRenderingContext2D,
  'save' | 'restore' | 'beginPath' | 'fill' | 'fillText' | 'roundRect' | 'rect'> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  font: string;
  textBaseline: CanvasRenderingContext2D['textBaseline'];
  textAlign: CanvasRenderingContext2D['textAlign'];
};

/** Draws a ready layout. No measuring, no wrapping: just rectangles and lines of text. */
export function drawChatOverlay(ctx: DrawContext, layout: ChatOverlayLayoutResult, fontFamily: string): void {
  if (layout.primitives.length === 0) return;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const item of layout.primitives) {
    ctx.fillStyle = item.fill;
    if (item.kind === 'rect') {
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(item.x, item.y, item.width, item.height, item.radius);
      else ctx.rect(item.x, item.y, item.width, item.height);
      ctx.fill();
    } else {
      ctx.font = chatOverlayFont(item.weight, item.fontSize, fontFamily);
      ctx.fillText(item.text, item.x, item.y);
    }
  }
  ctx.restore();
}
