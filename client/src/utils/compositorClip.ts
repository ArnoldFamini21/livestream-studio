/**
 * Stage tiles are clipped by rounded (or circular) CSS containers. The
 * compositor mirrors those clips so the broadcast matches the preview: a
 * circle camera stays a circle, rounded content keeps its corners.
 */

export interface CompositorClipShape {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

interface ClipStyle {
  clips: boolean;
  radius: string;
  borders: { top: number; right: number; bottom: number; left: number };
  expiresAt: number;
}

const STYLE_CACHE_MS = 1000;
const styleCache = new WeakMap<Element, ClipStyle>();

/** Resolve a computed border radius ("10px", "50%", "8px 4px") against an element's logical box. */
export function resolveCssRadius(value: string, width: number, height: number): number {
  const first = value.trim().split(/\s+/)[0] || '';
  if (!first) return 0;
  const amount = parseFloat(first);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const radius = first.endsWith('%') ? (amount / 100) * Math.min(width, height) : amount;
  return Math.min(radius, Math.min(width, height) / 2);
}

function readClipStyle(node: Element, now: number): ClipStyle {
  const cached = styleCache.get(node);
  if (cached && cached.expiresAt > now) return cached;
  const style = getComputedStyle(node);
  const width = (value: string) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const next: ClipStyle = {
    clips: style.overflow !== 'visible' || style.overflowX !== 'visible' || style.overflowY !== 'visible',
    radius: style.borderTopLeftRadius,
    borders: {
      top: width(style.borderTopWidth),
      right: width(style.borderRightWidth),
      bottom: width(style.borderBottomWidth),
      left: width(style.borderLeftWidth),
    },
    expiresAt: now + STYLE_CACHE_MS,
  };
  styleCache.set(node, next);
  return next;
}

/**
 * Collect rounded clipping containers from `element` up to (not including)
 * `stop`, in output coordinates. Like CSS, content is clipped at the padding
 * box: inside any border, with the radius reduced by the border width. Square
 * containers are skipped because each draw is already clipped to its rectangle.
 */
export function getCompositorClipShapes(
  element: Element,
  stop: Element,
  containerBounds: DOMRect,
  scales: { displayScaleX: number; displayScaleY: number; logicalScaleX: number; logicalScaleY: number },
  now = performance.now()
): CompositorClipShape[] {
  const shapes: CompositorClipShape[] = [];
  let node: Element | null = element;
  while (node && node !== stop) {
    const style = readClipStyle(node, now);
    if (style.clips && style.radius && style.radius !== '0px') {
      const logicalWidth = (node as HTMLElement).offsetWidth || 0;
      const logicalHeight = (node as HTMLElement).offsetHeight || 0;
      const { borders } = style;
      const logicalScale = Math.min(scales.logicalScaleX, scales.logicalScaleY);
      const innerRadius = resolveCssRadius(style.radius, logicalWidth, logicalHeight) - Math.max(borders.top, borders.left);
      if (innerRadius > 0) {
        const rect = node.getBoundingClientRect();
        const left = borders.left * scales.logicalScaleX;
        const top = borders.top * scales.logicalScaleY;
        shapes.push({
          x: (rect.left - containerBounds.left) * scales.displayScaleX + left,
          y: (rect.top - containerBounds.top) * scales.displayScaleY + top,
          width: Math.max(0, rect.width * scales.displayScaleX - left - borders.right * scales.logicalScaleX),
          height: Math.max(0, rect.height * scales.displayScaleY - top - borders.bottom * scales.logicalScaleY),
          radius: innerRadius * logicalScale,
        });
      }
    }
    node = node.parentElement;
  }
  return shapes;
}

export function applyCompositorClipShapes(ctx: CanvasRenderingContext2D, shapes: CompositorClipShape[]): void {
  for (const shape of shapes) {
    ctx.beginPath();
    ctx.roundRect(shape.x, shape.y, shape.width, shape.height, Math.min(shape.radius, shape.width / 2, shape.height / 2));
    ctx.clip();
  }
}
