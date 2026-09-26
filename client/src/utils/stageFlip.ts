/**
 * Smooth stage layout changes (Me <-> Content + Me). Tiles are measured
 * before the switch; after it, each is drawn back at its old place and size
 * with a transform and animated to the new one ("FLIP"). Only transforms and
 * opacity animate: the tiles' real size changes in one step, which Safari
 * needs (animating the width left a thin strip). The broadcast compositor
 * draws from the same boxes, so viewers see the same glide.
 */

export const STAGE_FLIP_DURATION_MS = 520;
/** Content leaving fades out first, then the cameras move into its space. */
export const CONTENT_EXIT_DURATION_MS = 240;
const STAGE_FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type StageTileRects = Map<string, StageRect>;

export function measureStageTiles(container: ParentNode): StageTileRects {
  const rects: StageTileRects = new Map();
  container.querySelectorAll<HTMLElement>('[data-stage-item-id]').forEach((element) => {
    const id = element.dataset.stageItemId;
    if (!id) return;
    const rect = element.getBoundingClientRect();
    rects.set(id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
  return rects;
}

/** The transform that draws a tile now at `to` where it was at `from`; null when it barely moved. */
export function getFlipTransform(from: StageRect, to: StageRect): string | null {
  if (to.width <= 0 || to.height <= 0 || from.width <= 0 || from.height <= 0) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
  return `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

function canAnimate(element: Element): element is HTMLElement {
  return typeof (element as HTMLElement).animate === 'function';
}

/** Animate tiles from their earlier boxes; new tiles and newly shown content fade in. */
export function playStageFlip(container: ParentNode, before: StageTileRects, contentAppeared: boolean): void {
  const options: KeyframeAnimationOptions = { duration: STAGE_FLIP_DURATION_MS, easing: STAGE_FLIP_EASING };
  container.querySelectorAll<HTMLElement>('[data-stage-item-id]').forEach((element) => {
    if (!canAnimate(element)) return;
    const id = element.dataset.stageItemId;
    const from = id ? before.get(id) : undefined;
    if (!from) {
      element.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], options);
      return;
    }
    const rect = element.getBoundingClientRect();
    const inverse = getFlipTransform(from, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    if (!inverse) return;
    element.animate([
      { transformOrigin: 'top left', transform: inverse },
      { transformOrigin: 'top left', transform: 'none' },
    ], options);
  });
  if (contentAppeared) {
    container.querySelectorAll('.studio-active-media').forEach((element) => {
      if (!canAnimate(element)) return;
      element.animate([{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], options);
    });
  }
}
