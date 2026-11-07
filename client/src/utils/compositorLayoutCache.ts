/**
 * The compositor maps every stage <video> to the canvas from its DOM
 * rectangle, clip shapes, object-fit and fade. Reading those for every tile
 * on every frame forces style and layout work on the studio's busy main
 * thread, interleaved with React renders. They only change when the layout
 * does, so the draw plan is cached and rebuilt:
 *
 * - while the stage is settling after a relevant DOM change or resize,
 * - on every frame while a tile, the shared media or the stage layer is
 *   animating (FLIP moves, fades, presence transitions),
 * - and at least every `maxAgeMs`, for changes no observer reports.
 *
 * Between rebuilds the frame loop only draws videos into cached rectangles.
 */

export interface CompositorLayoutCacheOptions {
  /** Keep rebuilding this long after a change: CSS transitions run after it. */
  settleMs?: number;
  /** Rebuild at least this often regardless. */
  maxAgeMs?: number;
}

export const DEFAULT_LAYOUT_SETTLE_MS = 1_200;
export const DEFAULT_LAYOUT_MAX_AGE_MS = 1_000;

export class CompositorLayoutCache<T> {
  private value: T | null = null;
  private builtAt = Number.NEGATIVE_INFINITY;
  private settlingUntil = Number.NEGATIVE_INFINITY;
  private readonly settleMs: number;
  private readonly maxAgeMs: number;
  rebuilds = 0;

  constructor(options: CompositorLayoutCacheOptions = {}) {
    this.settleMs = options.settleMs ?? DEFAULT_LAYOUT_SETTLE_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_LAYOUT_MAX_AGE_MS;
  }

  /** The layout changed (or may have): rebuild on every frame until it settles. */
  invalidate(now: number): void {
    this.settlingUntil = Math.max(this.settlingUntil, now + this.settleMs);
  }

  get(now: number, build: () => T, isAnimating: () => boolean = () => false): T {
    const needsBuild = this.value === null
      || now < this.settlingUntil
      || now - this.builtAt >= this.maxAgeMs
      || isAnimating();
    if (needsBuild) {
      this.value = build();
      this.builtAt = now;
      this.rebuilds += 1;
    }
    return this.value as T;
  }
}

const TILE_SELECTOR = '[data-stage-item-id], .studio-active-media';

interface MutationLike {
  type: string;
  target: Node;
}

function asElement(node: Node | null): Element | null {
  return node && node.nodeType === 1 ? node as Element : null;
}

function containsVideo(element: Element): boolean {
  return element.tagName === 'VIDEO' || Boolean(element.querySelector?.('video'));
}

/**
 * Whether a DOM mutation can move or restyle a drawn video. Decoration
 * inside a tile that holds no video (audio rings, name tags, badges) cannot;
 * those re-render constantly while people talk, so they are ignored.
 */
export function isLayoutRelevantMutation(record: MutationLike): boolean {
  if (record.type === 'childList') return true;
  const element = asElement(record.target);
  if (!element) return false;
  if (containsVideo(element)) return true;
  return !element.closest?.(TILE_SELECTOR);
}

interface AnimationLike {
  playState: string;
  /** A KeyframeEffect has a target; other effects do not. */
  effect: object | null;
}

/** A running animation that moves or fades a tile, the shared media or the stage. */
export function hasLayoutAnimation(animations: readonly AnimationLike[]): boolean {
  return animations.some((animation) => {
    if (animation.playState !== 'running') return false;
    const target = (animation.effect as { target?: Element | null } | null)?.target;
    return Boolean(target && containsVideo(target));
  });
}

/**
 * Observe the stage for layout changes. Returns a disconnect function; when
 * the observers are unavailable (tests, old browsers) the cache simply
 * rebuilds on its max-age schedule.
 */
export function observeCompositorLayout(container: Element, onChange: () => void): () => void {
  const cleanups: Array<() => void> = [];
  if (typeof MutationObserver === 'function') {
    const mutations = new MutationObserver((records) => {
      if (records.some(isLayoutRelevantMutation)) onChange();
    });
    mutations.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'data-stage-item-id'],
    });
    cleanups.push(() => mutations.disconnect());
  }
  if (typeof ResizeObserver === 'function') {
    const resize = new ResizeObserver(() => onChange());
    resize.observe(container);
    cleanups.push(() => resize.disconnect());
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onChange);
    cleanups.push(() => window.removeEventListener('resize', onChange));
  }
  return () => cleanups.forEach((cleanup) => cleanup());
}
